import * as fs from 'fs-extra';
import * as path from 'path';
import { run } from '../../core/exec';
import { logger } from '../../core/logger';
import { ERROR_CODES, AppError } from '../../core/errors';
import { FacebookVideoInfo, DownloadResult } from './types';
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

export async function downloadFacebookVideo(url: string, outDir: string): Promise<DownloadResult> {
  const normalizedUrl = normalizeFacebookUrl(url);
  logger.info('Starting Facebook video download', { url, normalizedUrl, outDir });

  // Common args kept minimal to mimic earlier successful behavior on first attempts
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

  // Prepare cookies file if provided (used only in later attempts)
  let cookiesPath: string | undefined;
  if (config.FACEBOOK_COOKIES_B64) {
    try {
      const cookieBuf = Buffer.from(config.FACEBOOK_COOKIES_B64, 'base64');
      cookiesPath = path.join(outDir, 'cookies.txt');
      await fs.writeFile(cookiesPath, cookieBuf);
      logger.info('Facebook cookies detected');
    } catch (e) {
      logger.warn('Failed to write Facebook cookies file; will proceed without', { error: e });
    }
  }

  const id = extractIdFromUrl(url) || extractIdFromUrl(normalizedUrl);
  const watchUrl = normalizeFacebookUrl(url);
  const reelMobile = id ? `https://m.facebook.com/reel/${id}` : undefined;

  type Attempt = { target: string; referer?: string; ua?: string; useCookies?: boolean };
  const attempts: Attempt[] = [];
  // 1) Raw URL, no cookies (closest to original working case)
  attempts.push({ target: url, referer: 'https://www.facebook.com/', ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', useCookies: false });
  // 2) Normalized watch URL, no cookies
  attempts.push({ target: watchUrl, referer: 'https://www.facebook.com/', ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', useCookies: false });
  // 3) Mobile reel URL with Android UA, no cookies
  if (reelMobile) {
    attempts.push({ target: reelMobile, referer: 'https://m.facebook.com/', ua: 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36', useCookies: false });
  }
  // 4..): Repeat with cookies if available
  if (cookiesPath) {
    attempts.push({ target: url, referer: 'https://www.facebook.com/', ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', useCookies: true });
    attempts.push({ target: watchUrl, referer: 'https://www.facebook.com/', ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', useCookies: true });
    if (reelMobile) attempts.push({ target: reelMobile, referer: 'https://m.facebook.com/', ua: 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36', useCookies: true });
  }

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
