import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { run } from '../../core/exec';
import { logger } from '../../core/logger';
import { ERROR_CODES, AppError } from '../../core/errors';
import { DownloadResult, VideoMetadata } from '../types';
import { config } from '../../core/config';
import { parseVideoInfoFromPath } from '../utils';

function normalizeUrl(u: string): string {
  // Remove query parameters that might cause issues
  try {
    const url = new URL(u);
    // Keep only the essential path, remove tracking params
    if (url.hostname.includes('tiktok.com')) {
      return url.origin + url.pathname;
    }
  } catch {}
  return u;
}

function mapYtDlpError(stderr: string): string {
  const s = stderr.toLowerCase();
  if (s.includes('private') || s.includes('login') || s.includes('only available to') || s.includes('this video is private')) {
    return ERROR_CODES.ERR_PRIVATE_OR_RESTRICTED;
  }
  if (s.includes('http error 4') || s.includes('429') || s.includes('rate limit')) {
    return ERROR_CODES.ERR_FETCH_FAILED;
  }
  if (s.includes('unsupported url') || s.includes('no video found') || s.includes('cannot parse')) {
    return ERROR_CODES.ERR_UNSUPPORTED_URL;
  }
  if (s.includes('geo') || s.includes('blocked') || s.includes('not available in your country')) {
    return ERROR_CODES.ERR_GEO_BLOCKED;
  }
  return ERROR_CODES.ERR_INTERNAL;
}

async function findDownloadedFile(outDir: string): Promise<string | null> {
  const files = await fs.readdir(outDir);
  const candidates = files.filter((f) => ['.mp4', '.mkv', '.webm', '.avi', '.mov'].includes(path.extname(f).toLowerCase()));
  if (candidates.length === 0) return null;
  const stats = await Promise.all(
    candidates.map(async (f) => {
      const p = path.join(outDir, f);
      const st = await fs.stat(p);
      return { p, mtime: st.mtime };
    })
  );
  stats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return stats[0]?.p || null;
}

function createBaseArgs(outDir: string): string[] {
  const base = [
    '--no-playlist',
    '--geo-bypass',
    '-4',
    '--retries', '3',
    '--fragment-retries', '10',
    // TikTok specific format selector
    '-f', 'best[ext=mp4]/best',
    '-o', path.join(outDir, '%(title).80B.%(id)s.%(ext)s'),
  ];
  if (config.GEO_BYPASS_COUNTRY) base.push('--geo-bypass-country', config.GEO_BYPASS_COUNTRY);
  if (config.LOG_LEVEL === 'debug' || config.LOG_LEVEL === 'trace') base.unshift('-v');
  return base;
}

async function prepareTikTokCookies(outDir: string): Promise<string | undefined> {
  const canUseCookies = !!config['TIKTOK_COOKIES_B64'] && !config['SKIP_COOKIES'];
  if (!canUseCookies) return undefined;
  try {
    const buf = Buffer.from(config['TIKTOK_COOKIES_B64'], 'base64');
    const cookiesPath = path.join(outDir, 'tiktok_cookies.txt');
    await fs.writeFile(cookiesPath, buf);
    logger.info('TikTok cookies detected');
    return cookiesPath;
  } catch (error) {
    logger.warn('Failed to write TikTok cookies, proceeding without', { error });
    return undefined;
  }
}

type Attempt = { target: string; useCookies: boolean; ua: string };

function buildTikTokAttempts(url: string, normalizedUrl: string, cookiesPath?: string): Attempt[] {
  // TikTok works best with mobile user agents
  const mobileUA = 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
  const desktopUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  const attempts: Attempt[] = [];
  
  // Try mobile UA first (TikTok prefers mobile)
  attempts.push({ target: normalizedUrl, useCookies: false, ua: mobileUA });
  attempts.push({ target: url, useCookies: false, ua: mobileUA });
  
  // Try desktop UA
  attempts.push({ target: normalizedUrl, useCookies: false, ua: desktopUA });
  
  // If cookies available, try with cookies
  if (cookiesPath) {
    attempts.push({ target: normalizedUrl, useCookies: true, ua: mobileUA });
    attempts.push({ target: url, useCookies: true, ua: mobileUA });
  }
  
  return attempts;
}

export async function downloadTikTokVideo(url: string, outDir: string): Promise<DownloadResult> {
  const normalizedUrl = normalizeUrl(url);
  logger.info('Starting TikTok video download', { url, normalizedUrl, outDir });

  const base = createBaseArgs(outDir);
  const cookiesPath = await prepareTikTokCookies(outDir);
  const attempts = buildTikTokAttempts(url, normalizedUrl, cookiesPath);

  try {
    let last: { code: number; stdout: string; stderr: string; durationMs: number } | null = null;
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i]!;
      const args = [
        ...base,
        '--user-agent', a.ua,
        // Add TikTok specific headers
        '--add-header', 'Referer:https://www.tiktok.com/',
      ];
      
      if (a.useCookies && cookiesPath) {
        args.push('--cookies', cookiesPath);
      }
      
      args.push(a.target);
      
      logger.info('yt-dlp attempt (tiktok)', { 
        attempt: i + 1, 
        target: a.target, 
        cookies: a.useCookies && !!cookiesPath, 
        ua: a.ua.includes('Android') ? 'mobile' : 'desktop' 
      });
      
      if (config.DEBUG_YTDLP) logger.debug('yt-dlp args (tiktok)', { args });
      
      const result = await run('yt-dlp', args, { timeout: 300000 });
      last = result;
      
      if (result.code === 0) {
        const filePath = await findDownloadedFile(outDir);
        if (!filePath) {
          throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Downloaded file not found', { url: a.target, outDir });
        }
        const videoInfo = await parseVideoInfoFromPath(filePath, a.target);
        logger.info('TikTok video downloaded successfully', { url: a.target, filePath, videoInfo });
        return { filePath, videoInfo };
      }
      
      logger.warn('yt-dlp attempt failed (tiktok)', { attempt: i + 1, code: result.code });
    }

    const stderrPreview = (last?.stderr || '').slice(0, 1200);
    const stdoutPreview = (last?.stdout || '').slice(0, 400);
    logger.error('All yt-dlp attempts failed (tiktok)', { url, stderrPreview, stdoutPreview });
    throw new AppError(
      mapYtDlpError(last?.stderr || ''), 
      'yt-dlp download failed', 
      { url, stderr: last?.stderr, stdout: last?.stdout, code: last?.code }
    );
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error('Unexpected error during TikTok download', { error, url, outDir });
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Unexpected error during download', { url, originalError: error });
  }
}

export async function fetchTikTokMetadata(url: string): Promise<VideoMetadata> {
  logger.info('Fetching TikTok metadata', { url });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tiktok-meta-'));
  
  try {
    const normalizedUrl = normalizeUrl(url);
    const cookiesPath = await prepareTikTokCookies(tempDir);
    const attempts = buildTikTokAttempts(url, normalizedUrl, cookiesPath);
    const base = createBaseArgs(tempDir);

    let lastError: AppError | Error | null = null;
    for (const attempt of attempts) {
      const args = [
        ...base,
        '--dump-single-json',
        '--skip-download',
        '--user-agent', attempt.ua,
        '--add-header', 'Referer:https://www.tiktok.com/',
      ];
      
      if (attempt.useCookies && cookiesPath) {
        args.push('--cookies', cookiesPath);
      }
      
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
          logger.warn('Failed to parse TikTok metadata JSON', { url: attempt.target, error: lastError.message });
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
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Failed to resolve TikTok metadata', { url, lastError: lastError?.message });
  } finally {
    try { 
      await fs.remove(tempDir); 
    } catch (error) {
      logger.warn('Failed to cleanup temp dir after TikTok metadata', { url, error });
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
  const title: string = json?.title || requested?.title || 'TikTok video';
  
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
