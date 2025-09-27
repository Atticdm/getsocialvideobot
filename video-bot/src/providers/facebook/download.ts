import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { run } from '../../core/exec';
import { logger } from '../../core/logger';
import { ERROR_CODES, AppError } from '../../core/errors';
import { FacebookVideoInfo, DownloadResult } from './types';
import { VideoMetadata } from '../types';
import { config } from '../../core/config';

function extractIdFromUrl(originalUrl: string): string | null {
  try {
    const m1 = originalUrl.match(/facebook\.com\/reel\/(\d+)/);
    if (m1 && m1[1]) return m1[1];
    const m2 = originalUrl.match(/[?&]v=(\d+)/);
    if (m2 && m2[1]) return m2[1];
  } catch {}
  return null;
}

function normalizeFacebookUrl(originalUrl: string): string {
  try {
    const id = extractIdFromUrl(originalUrl);
    if (id) return `https://m.facebook.com/watch/?v=${id}`;
  } catch {}
  return originalUrl;
}

type Attempt = { target: string; referer?: string; ua?: string; useCookies?: boolean };

function createCommonArgs(outDir: string): string[] {
  const common = [
    '--no-playlist',
    '--geo-bypass',
    '-4',
    '-f', 'best[ext=mp4]/best',
    '-o', path.join(outDir, '%(title).80B.%(id)s.%(ext)s'),
  ];
  if (config.GEO_BYPASS_COUNTRY) {
    common.push('--geo-bypass-country', config.GEO_BYPASS_COUNTRY);
  }
  if (config.LOG_LEVEL === 'debug' || config.LOG_LEVEL === 'trace') {
    common.unshift('-v');
  }
  return common;
}

async function prepareFacebookCookies(outDir: string): Promise<string | undefined> {
  if (!config.FACEBOOK_COOKIES_B64) return undefined;
  try {
    const cookieBuf = Buffer.from(config.FACEBOOK_COOKIES_B64, 'base64');
    const cookiesPath = path.join(outDir, 'cookies.txt');
    await fs.writeFile(cookiesPath, cookieBuf);
    logger.info('Facebook cookies detected');
    return cookiesPath;
  } catch (error) {
    logger.warn('Failed to write Facebook cookies file; proceeding without', { error });
    return undefined;
  }
}

function buildFacebookAttempts(url: string, normalizedUrl: string, cookiesPath?: string): Attempt[] {
  const id = extractIdFromUrl(url) || extractIdFromUrl(normalizedUrl);
  const watchUrl = normalizedUrl;
  const reelMobile = id ? `https://m.facebook.com/reel/${id}` : undefined;

  const attempts: Attempt[] = [];
  const desktopUA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const mobileUA = 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

  attempts.push({ target: url, referer: 'https://www.facebook.com/', ua: desktopUA, useCookies: false });
  attempts.push({ target: watchUrl, referer: 'https://www.facebook.com/', ua: desktopUA, useCookies: false });
  if (reelMobile) {
    attempts.push({ target: reelMobile, referer: 'https://m.facebook.com/', ua: mobileUA, useCookies: false });
  }
  if (cookiesPath) {
    attempts.push({ target: url, referer: 'https://www.facebook.com/', ua: desktopUA, useCookies: true });
    attempts.push({ target: watchUrl, referer: 'https://www.facebook.com/', ua: desktopUA, useCookies: true });
    if (reelMobile) {
      attempts.push({ target: reelMobile, referer: 'https://m.facebook.com/', ua: mobileUA, useCookies: true });
    }
  }
  return attempts;
}

export async function downloadFacebookVideo(url: string, outDir: string): Promise<DownloadResult> {
  const normalizedUrl = normalizeFacebookUrl(url);
  logger.info('Starting Facebook video download', { url, normalizedUrl, outDir });

  const common = createCommonArgs(outDir);
  const cookiesPath = await prepareFacebookCookies(outDir);
  const attempts = buildFacebookAttempts(url, normalizedUrl, cookiesPath);

  try {
    let lastResult: { code: number; stdout: string; stderr: string; durationMs: number } | null = null;
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i]!;
      const args: string[] = [...common];
      if (a.referer) args.push('--add-header', `Referer:${a.referer}`);
      if (a.ua) args.push('--user-agent', a.ua);
      if (a.useCookies && cookiesPath) args.push('--cookies', cookiesPath);
      args.push(a.target);

      logger.info('yt-dlp attempt', { attempt: i + 1, target: a.target, cookies: !!(a.useCookies && cookiesPath), ua: a.ua?.includes('Android') ? 'android' : 'desktop' });
      if (config.DEBUG_YTDLP) {
        logger.debug('yt-dlp full args', { args });
      }
      const result = await run('yt-dlp', args, { timeout: 300000 });
      lastResult = result;
      if (result.code === 0) {
        // Find the downloaded file
        const filePath = await findDownloadedFile(outDir);
        if (!filePath) {
          throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Downloaded file not found', { url: a.target, outDir });
        }
        const videoInfo = parseVideoInfoFromPath(filePath, a.target);
        logger.info('Facebook video downloaded successfully', { url: a.target, filePath, videoInfo });
        return { filePath, videoInfo };
      }
      logger.warn('yt-dlp attempt failed', { attempt: i + 1, code: result.code });
    }

    const stderrPreview = (lastResult?.stderr || '').slice(0, 1200);
    const stdoutPreview = (lastResult?.stdout || '').slice(0, 400);
    logger.error('All yt-dlp attempts failed', { url, stderrPreview, stdoutPreview });
    throw new AppError(mapYtDlpError(lastResult?.stderr || ''), 'yt-dlp download failed', { url, stderr: lastResult?.stderr, stdout: lastResult?.stdout, code: lastResult?.code });
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error('Unexpected error during Facebook video download', { error, url, outDir });
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Unexpected error during download', { url, originalError: error });
  }
}

export async function fetchFacebookMetadata(url: string): Promise<VideoMetadata> {
  logger.info('Fetching Facebook metadata', { url });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fb-meta-'));
  try {
    const normalizedUrl = normalizeFacebookUrl(url);
    const cookiesPath = await prepareFacebookCookies(tempDir);
    const attempts = buildFacebookAttempts(url, normalizedUrl, cookiesPath);
    const common = createCommonArgs(tempDir);

    let lastError: { code: number; stderr: string } | null = null;
    for (const attempt of attempts) {
      const args = [...common, '--dump-single-json', '--skip-download'];
      if (attempt.referer) args.push('--add-header', `Referer:${attempt.referer}`);
      if (attempt.ua) args.push('--user-agent', attempt.ua);
      if (attempt.useCookies && cookiesPath) args.push('--cookies', cookiesPath);
      args.push(attempt.target);

      const result = await run('yt-dlp', args, { timeout: 240000 });
      if (result.code === 0) {
        try {
          const parsed = JSON.parse(result.stdout || '{}');
          const metadata = extractMetadata(parsed, attempt.target);
          if (!metadata.downloadUrl) throw new Error('downloadUrl missing');
          return metadata;
        } catch (error) {
          logger.warn('Failed to parse Facebook metadata JSON', { url: attempt.target, error });
          lastError = { code: 0, stderr: String(error) };
        }
      } else {
        lastError = { code: result.code, stderr: result.stderr };
      }
    }

    const message = lastError ? mapYtDlpError(lastError.stderr) : ERROR_CODES.ERR_INTERNAL;
    throw new AppError(message, 'Failed to resolve Facebook metadata', { url, lastError });
  } finally {
    try {
      await fs.remove(tempDir);
    } catch (error) {
      logger.warn('Failed to cleanup temp dir after Facebook metadata', { url, error });
    }
  }
}

function extractMetadata(json: any, fallbackUrl: string): VideoMetadata {
  const requested = Array.isArray(json?.requested_downloads) && json.requested_downloads.length > 0 ? json.requested_downloads[0] : null;
  const downloadUrl: string | undefined = requested?.url || json?.url;
  const fileSize: number | undefined = requested?.filesize || requested?.filesizeApprox || json?.filesize || json?.filesizeApprox;
  const duration: number | undefined = json?.duration || requested?.duration;
  const title: string = json?.title || requested?.title || 'Facebook video';
  let thumbnail: string | undefined;
  if (typeof json?.thumbnail === 'string') thumbnail = json.thumbnail;
  else if (Array.isArray(json?.thumbnails) && json.thumbnails.length) {
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

function mapYtDlpError(stderr: string): string {
  const errorLower = stderr.toLowerCase();
  
  if (errorLower.includes('this video is only available to logged in users') ||
      errorLower.includes('private') ||
      errorLower.includes('restricted') ||
      errorLower.includes('log in or sign up')) {
    return ERROR_CODES.ERR_PRIVATE_OR_RESTRICTED;
  }
  
  if (errorLower.includes('http error 4') ||
      errorLower.includes('429') ||
      errorLower.includes('rate limit')) {
    return ERROR_CODES.ERR_FETCH_FAILED;
  }
  
  if (errorLower.includes('unsupported url') ||
      errorLower.includes('no video found') ||
      errorLower.includes('cannot parse data')) {
    return ERROR_CODES.ERR_UNSUPPORTED_URL;
  }
  
  if (errorLower.includes('geo') ||
      errorLower.includes('blocked')) {
    return ERROR_CODES.ERR_GEO_BLOCKED;
  }
  
  return ERROR_CODES.ERR_INTERNAL;
}

function parseVideoInfoFromPath(filePath: string, url: string): FacebookVideoInfo {
  const fileName = path.basename(filePath);
  const ext = path.extname(fileName);
  const nameWithoutExt = fileName.replace(ext, '');
  
  // Extract ID from filename (last part after the last dot before extension)
  const parts = nameWithoutExt.split('.');
  const id = parts[parts.length - 1] || 'unknown';
  
  // Use filename as title, but clean it up
  let title = nameWithoutExt.replace(`.${id}`, '');
  if (title.length > 100) {
    title = title.substring(0, 100) + '...';
  }
  
  return {
    id,
    title,
    url,
    duration: undefined,
  };
}

async function findDownloadedFile(outDir: string): Promise<string | null> {
  try {
    const files = await fs.readdir(outDir);
    
    // Look for video files
    const videoFiles = files.filter(file => {
      const ext = path.extname(file).toLowerCase();
      return ['.mp4', '.mkv', '.webm', '.avi'].includes(ext);
    });
    
    if (videoFiles.length === 0) {
      return null;
    }
    
    // Return the most recent file
    const fileStats = await Promise.all(
      videoFiles.map(async (file) => {
        const filePath = path.join(outDir, file);
        const stats = await fs.stat(filePath);
        return { filePath, mtime: stats.mtime };
      })
    );
    
    fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
    return fileStats[0]?.filePath || null;
  } catch (error) {
    logger.error('Failed to find downloaded file', { error, outDir });
    return null;
  }
}
