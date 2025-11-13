import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { run } from '../../core/exec';
import { logger } from '../../core/logger';
import { ERROR_CODES, AppError } from '../../core/errors';
import { DownloadResult, VideoMetadata } from '../types';
import { config } from '../../core/config';
import { parseVideoInfoFromPath, findDownloadedFile } from '../utils';

function normalizeUrl(u: string): string {
  // Remove query parameters that might cause issues
  try {
    const url = new URL(u);
    // Keep only the essential path, remove tracking params
    if (url.hostname.includes('vk.com') || url.hostname.includes('vk.ru') || url.hostname.includes('vkvideo.ru')) {
      // Normalize vkvideo.ru to vk.com format if possible, otherwise keep as is
      if (url.hostname.includes('vkvideo.ru')) {
        // vkvideo.ru/clip-xxx_xxx format - keep as is, yt-dlp handles it
        return url.origin + url.pathname;
      }
      // Normalize to vk.com
      const normalizedHost = url.hostname.replace('vk.ru', 'vk.com').replace('m.vk.com', 'vk.com');
      return `https://${normalizedHost}${url.pathname}`;
    }
  } catch {}
  return u;
}

function mapYtDlpError(stderr: string): string {
  const s = stderr.toLowerCase();
  if (s.includes('private') || s.includes('login') || s.includes('only available to') || s.includes('this video is private') || s.includes('access denied')) {
    return ERROR_CODES.ERR_PRIVATE_OR_RESTRICTED;
  }
  if (s.includes('http error 4') || s.includes('429') || s.includes('rate limit')) {
    return ERROR_CODES.ERR_FETCH_FAILED;
  }
  if (s.includes('unsupported url') || s.includes('no video found') || s.includes('cannot parse') || s.includes('unable to extract')) {
    return ERROR_CODES.ERR_UNSUPPORTED_URL;
  }
  if (s.includes('geo') || s.includes('blocked') || s.includes('not available in your country')) {
    return ERROR_CODES.ERR_GEO_BLOCKED;
  }
  return ERROR_CODES.ERR_INTERNAL;
}

function createBaseArgs(outDir: string): string[] {
  const base = [
    '--no-playlist',
    '--geo-bypass',
    '-4',
    '--retries', '3',
    '--fragment-retries', '10',
    '-f', 'best[ext=mp4]/best',
    '-o', path.join(outDir, '%(title).80B.%(id)s.%(ext)s'),
  ];
  if (config.GEO_BYPASS_COUNTRY) base.push('--geo-bypass-country', config.GEO_BYPASS_COUNTRY);
  if (config.LOG_LEVEL === 'debug' || config.LOG_LEVEL === 'trace') base.unshift('-v');
  return base;
}

type Attempt = { target: string; ua: string };

function buildVkAttempts(url: string, normalizedUrl: string): Attempt[] {
  // VK works with both mobile and desktop user agents
  const mobileUA = 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
  const desktopUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  const attempts: Attempt[] = [];
  
  // Try normalized URL first
  attempts.push({ target: normalizedUrl, ua: desktopUA });
  attempts.push({ target: normalizedUrl, ua: mobileUA });
  
  // Try original URL as fallback
  if (url !== normalizedUrl) {
    attempts.push({ target: url, ua: desktopUA });
    attempts.push({ target: url, ua: mobileUA });
  }
  
  return attempts;
}

export async function downloadVkVideo(url: string, outDir: string): Promise<DownloadResult> {
  const normalizedUrl = normalizeUrl(url);
  logger.info('Starting VK video download', { url, normalizedUrl, outDir });

  const base = createBaseArgs(outDir);
  const attempts = buildVkAttempts(url, normalizedUrl);

  try {
    let last: { code: number; stdout: string; stderr: string } | null = null;
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i]!;
      const args = [
        ...base,
        '--user-agent', a.ua,
        '--add-header', 'Referer:https://vk.com/',
      ];
      
      args.push(a.target);
      
      logger.info('yt-dlp attempt (vk)', { 
        attempt: i + 1, 
        target: a.target, 
        ua: a.ua.includes('Android') ? 'mobile' : 'desktop' 
      });
      
      if (config.DEBUG_YTDLP) logger.debug('yt-dlp args (vk)', { args });
      
      const result = await run('yt-dlp', args, { timeout: 300000 });
      last = result;
      
      if (result.code === 0) {
        const filePath = await findDownloadedFile(outDir);
        if (!filePath) {
          throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Downloaded file not found', { url: a.target, outDir });
        }
        const videoInfo = await parseVideoInfoFromPath(filePath, a.target);
        logger.info('VK video downloaded successfully', { url: a.target, filePath, videoInfo });
        return { filePath, videoInfo };
      }
      
      logger.warn('yt-dlp attempt failed (vk)', { attempt: i + 1, code: result.code });
    }

    const stderrPreview = (last?.stderr || '').slice(0, 1200);
    const stdoutPreview = (last?.stdout || '').slice(0, 400);
    logger.error('All yt-dlp attempts failed (vk)', { url, stderrPreview, stdoutPreview });
    throw new AppError(
      mapYtDlpError(last?.stderr || ''), 
      'yt-dlp download failed', 
      { url, stderr: last?.stderr, stdout: last?.stdout, code: last?.code }
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error('Unexpected error during VK download', { error, url, outDir });
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Unexpected error during download', { url, originalError: error });
  }
}

export async function fetchVkMetadata(url: string): Promise<VideoMetadata> {
  logger.info('Fetching VK metadata', { url });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vk-meta-'));
  
  try {
    const normalizedUrl = normalizeUrl(url);
    const attempts = buildVkAttempts(url, normalizedUrl);
    const base = createBaseArgs(tempDir);

    let lastError: AppError | Error | null = null;
    for (const attempt of attempts) {
      const args = [
        ...base,
        '--dump-single-json',
        '--skip-download',
        '--user-agent', attempt.ua,
        '--add-header', 'Referer:https://vk.com/',
      ];
      
      args.push(attempt.target);

      const result = await run('yt-dlp', args, { timeout: 240000 });
      
      if (result.code === 0) {
        try {
          const parsed = JSON.parse(result.stdout || '{}');
          const metadata = extractMetadata(parsed, attempt.target);
          if (!metadata.downloadUrl) throw new Error('downloadUrl missing');
          return metadata;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          logger.warn('Failed to parse VK metadata JSON', { url: attempt.target, error: lastError.message });
        }
      } else {
        lastError = new AppError(
          mapYtDlpError(result.stderr), 
          'Metadata attempt failed', 
          { url: attempt.target, stderr: result.stderr, code: result.code }
        );
      }
    }

    if (lastError instanceof AppError) throw lastError;
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Failed to resolve VK metadata', { url, lastError: lastError?.message });
  } finally {
    try { 
      await fs.remove(tempDir); 
    } catch (error) {
      logger.warn('Failed to cleanup temp dir after VK metadata', { url, error });
    }
  }
}

function extractMetadata(json: any, fallbackUrl: string): VideoMetadata {
  const requested = Array.isArray(json?.requested_downloads) && json.requested_downloads.length > 0 
    ? json.requested_downloads[0] 
    : null;
  
  const downloadUrl: string | undefined = requested?.url || json?.url;
  const fileSize: number | undefined = requested?.filesize || requested?.filesizeApprox || json?.filesize || json?.filesizeApprox;
  const duration: number | undefined = json?.duration || requested?.duration;
  const title: string = json?.title || requested?.title || 'VK video';
  
  let thumbnail: string | undefined;
  if (typeof json?.thumbnail === 'string') {
    thumbnail = json.thumbnail;
  } else if (Array.isArray(json?.thumbnails) && json.thumbnails.length) {
    const best = json.thumbnails[json.thumbnails.length - 1];
    if (best?.url) thumbnail = best.url;
  }

  const metadata: VideoMetadata = {
    downloadUrl: downloadUrl || fallbackUrl,
    title,
  };
  
  if (typeof duration === 'number' && !Number.isNaN(duration)) metadata.duration = duration;
  if (typeof fileSize === 'number' && fileSize > 0) metadata.fileSize = fileSize;
  if (thumbnail) metadata.thumbnail = thumbnail;
  
  return metadata;
}

