import * as fs from 'fs-extra';
import * as path from 'path';
import { run } from '../../core/exec';
import { logger } from '../../core/logger';
import { ERROR_CODES, AppError } from '../../core/errors';
import { VideoInfo, DownloadResult } from '../types';
import { config } from '../../core/config';

function mapYtDlpError(stderr: string): string {
  const s = stderr.toLowerCase();
  if (s.includes('private') || s.includes('login') || s.includes('only available to')) {
    return ERROR_CODES.ERR_PRIVATE_OR_RESTRICTED;
  }
  if (s.includes('http error 4') || s.includes('429') || s.includes('rate limit')) {
    return ERROR_CODES.ERR_FETCH_FAILED;
  }
  if (s.includes('unsupported url') || s.includes('no video found') || s.includes('cannot parse')) {
    return ERROR_CODES.ERR_UNSUPPORTED_URL;
  }
  if (s.includes('geo') || s.includes('blocked')) {
    return ERROR_CODES.ERR_GEO_BLOCKED;
  }
  return ERROR_CODES.ERR_INTERNAL;
}

function parseVideoInfoFromPath(filePath: string, url: string): VideoInfo {
  const fileName = path.basename(filePath);
  const ext = path.extname(fileName);
  const name = fileName.slice(0, -ext.length);
  const parts = name.split('.');
  const id = parts[parts.length - 1] || 'unknown';
  let title = name.replace(`.${id}`, '');
  if (title.length > 100) title = title.substring(0, 100) + '...';
  return { id, title, url };
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

export async function downloadInstagramVideo(url: string, outDir: string): Promise<DownloadResult> {
  logger.info('Starting Instagram video download', { url, outDir });

  const baseArgs = [
    '--no-playlist',
    '--geo-bypass',
    '-4',
    '--add-header', 'Referer:https://www.instagram.com/',
    '--user-agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    '-f', 'best[ext=mp4]/best',
    '-o', path.join(outDir, '%(title).80B.%(id)s.%(ext)s'),
  ];

  if (config.GEO_BYPASS_COUNTRY) {
    baseArgs.push('--geo-bypass-country', config.GEO_BYPASS_COUNTRY);
  }

  // Verbose if debug/trace
  if (config.LOG_LEVEL === 'debug' || config.LOG_LEVEL === 'trace') {
    baseArgs.unshift('-v');
  }

  let cookiesPath: string | undefined;
  if (config['INSTAGRAM_COOKIES_B64']) {
    try {
      const buf = Buffer.from(config['INSTAGRAM_COOKIES_B64'], 'base64');
      cookiesPath = path.join(outDir, 'ig_cookies.txt');
      await fs.writeFile(cookiesPath, buf);
      baseArgs.push('--cookies', cookiesPath);
      logger.info('Using Instagram cookies for yt-dlp');
    } catch (e) {
      logger.warn('Failed to write Instagram cookies, proceeding without', { error: e });
    }
  }

  try {
    let result = await run('yt-dlp', [...baseArgs, url], { timeout: 300000 });

    if (result.code !== 0) {
      // Retry with Android UA and m.instagram referer
      const retryArgs = [
        '--no-playlist',
        '--geo-bypass',
        '-4',
        '--add-header', 'Referer:https://m.instagram.com/',
        '--user-agent', 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
        '-f', 'best[ext=mp4]/best',
        '-o', path.join(outDir, '%(title).80B.%(id)s.%(ext)s'),
        url,
      ];
      if (cookiesPath) retryArgs.push('--cookies', cookiesPath);
      if (config.LOG_LEVEL === 'debug' || config.LOG_LEVEL === 'trace') retryArgs.unshift('-v');

      logger.warn('First yt-dlp attempt failed for Instagram, retrying with Android UA', { code: result.code });
      result = await run('yt-dlp', retryArgs, { timeout: 300000 });
    }

    if (result.code !== 0) {
      const stderrPreview = (result.stderr || '').slice(0, 1200);
      const stdoutPreview = (result.stdout || '').slice(0, 400);
      logger.error('yt-dlp download failed (instagram)', { url, code: result.code, stderrPreview, stdoutPreview });
      throw new AppError(
        mapYtDlpError(result.stderr),
        'yt-dlp download failed',
        { url, stderr: result.stderr, stdout: result.stdout, code: result.code }
      );
    }

    const filePath = await findDownloadedFile(outDir);
    if (!filePath) {
      throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Downloaded file not found', { url, outDir });
    }

    const videoInfo = parseVideoInfoFromPath(filePath, url);
    logger.info('Instagram video downloaded successfully', { url, filePath, videoInfo });
    return { filePath, videoInfo };
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error('Unexpected error during Instagram download', { error, url, outDir });
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Unexpected error during download', { url, originalError: error });
  }
}
