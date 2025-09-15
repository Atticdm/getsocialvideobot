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

  // Build yt-dlp attempts: original URL first, then normalized watch URL, then Android UA fallback
  const commonArgs = [
    '--no-playlist',
    '--geo-bypass',
    '-4',
    '-f', 'best[ext=mp4]/best',
    '-o', path.join(outDir, '%(title).80B.%(id)s.%(ext)s'),
  ];

  // Optional cookies support (base64-encoded netscape cookies)
  let cookiesPath: string | undefined;
  if (config.FACEBOOK_COOKIES_B64) {
    try {
      const cookieBuf = Buffer.from(config.FACEBOOK_COOKIES_B64, 'base64');
      cookiesPath = path.join(outDir, 'cookies.txt');
      await fs.writeFile(cookiesPath, cookieBuf);
      logger.info('Using Facebook cookies for yt-dlp');
    } catch (e) {
      logger.warn('Failed to write cookies file, proceeding without cookies', { error: e });
    }
  }

  const mkArgs = (referer: string, ua: string, targetUrl: string): string[] => {
    const a = [
      ...commonArgs,
      '--add-header', `Referer:${referer}`,
      '--user-agent', ua,
    ];
    if (cookiesPath) a.push('--cookies', cookiesPath);
    a.push(targetUrl);
    if (config.LOG_LEVEL === 'debug' || config.LOG_LEVEL === 'trace') a.unshift('-v');
    return a;
  };

  const id = extractIdFromUrl(normalizedUrl);
  const attemptArgs: string[][] = [
    mkArgs('https://www.facebook.com/', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', url),
    mkArgs('https://www.facebook.com/', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', normalizedUrl),
    mkArgs('https://m.facebook.com/', 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36', id ? `https://m.facebook.com/reel/${id}` : normalizedUrl),
  ];

  try {
    // Try attempts in sequence, stop on first success
    let result = { code: 1, stdout: '', stderr: '', durationMs: 0 } as any;
    for (let i = 0; i < attemptArgs.length; i++) {
      const a = attemptArgs[i];
      const target = a && a.length > 0 ? a[a.length - 1] : 'unknown';
      logger.info('yt-dlp attempt', { attempt: i + 1, target });
      result = await run('yt-dlp', a, { timeout: 300000 });
      if (result.code === 0) break;
      logger.warn('yt-dlp attempt failed', { attempt: i + 1, code: result.code });
    }

    if (result.code !== 0) {
      logger.error('yt-dlp download failed', {
        url,
        code: result.code,
        stderr: result.stderr,
        stdout: result.stdout
      });
      
      throw new AppError(
        mapYtDlpError(result.stderr),
        'yt-dlp download failed',
        { url, stderr: result.stderr, stdout: result.stdout, code: result.code }
      );
    }

    // Find the downloaded file
    const filePath = await findDownloadedFile(outDir);
    
    if (!filePath) {
      throw new AppError(
        ERROR_CODES.ERR_INTERNAL,
        'Downloaded file not found',
        { url, outDir }
      );
    }
    
    // Parse video info from filename
    const videoInfo = parseVideoInfoFromPath(filePath, normalizedUrl);

    logger.info('Facebook video downloaded successfully', { 
      url, 
      filePath, 
      videoInfo 
    });

    return {
      filePath,
      videoInfo,
    };
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    logger.error('Unexpected error during Facebook video download', { 
      error, 
      url, 
      outDir 
    });

    throw new AppError(
      ERROR_CODES.ERR_INTERNAL,
      'Unexpected error during download',
      { url, originalError: error }
    );
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
