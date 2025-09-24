import * as fs from 'fs-extra';
import * as path from 'path';
import { run } from '../../core/exec';
import { logger } from '../../core/logger';
import { ERROR_CODES, AppError } from '../../core/errors';
import { DownloadResult } from '../types';
import { config } from '../../core/config';
import { findDownloadedFile, parseVideoInfoFromPath } from '../utils';

function mapYtDlpError(stderr: string): string {
  const s = (stderr || '').toLowerCase();
  if (s.includes('login') || s.includes('private') || s.includes('sign in') || s.includes('age') || s.includes('restricted') || s.includes('members-only')) return ERROR_CODES.ERR_PRIVATE_OR_RESTRICTED;
  if (s.includes('http error 4') || s.includes('429') || s.includes('rate limit')) return ERROR_CODES.ERR_FETCH_FAILED;
  if (s.includes('unsupported url') || s.includes('no video formats') || s.includes('video unavailable')) return ERROR_CODES.ERR_UNSUPPORTED_URL;
  if (s.includes('geo') || s.includes('blocked')) return ERROR_CODES.ERR_GEO_BLOCKED;
  return ERROR_CODES.ERR_INTERNAL;
}

export async function downloadYouTubeVideo(url: string, outDir: string): Promise<DownloadResult> {
  logger.info('Starting YouTube video download', { url, outDir });

  const base = [
    '--no-playlist',
    '--geo-bypass',
    '--no-mtime',
    '--ffmpeg-location', process.env.FFMPEG_PATH || '/usr/bin/ffmpeg', // Explicitly provide ffmpeg path to ensure merging works
    '--sponsorblock-remove', 'all', // Skip sponsors, intros, etc.
    '--max-filesize', '2G', // Safety limit
    '-4',
    '--retries', '3',
    '--fragment-retries', '5',
    '--ignore-config',
    '--embed-metadata',
    '--embed-thumbnail',
    '--ppa', 'ffmpeg:-movflags +faststart',
    '-o', path.join(outDir, '%(title).80B.%(id)s.%(ext)s'),
  ];
  if (config.GEO_BYPASS_COUNTRY) base.push('--geo-bypass-country', config.GEO_BYPASS_COUNTRY);
  if (config.LOG_LEVEL === 'debug' || config.LOG_LEVEL === 'trace') base.unshift('-v');

  let cookiesPath: string | undefined;
  if (!!config.YOUTUBE_COOKIES_B64 && !config.SKIP_COOKIES) {
    try {
      const buf = Buffer.from(config.YOUTUBE_COOKIES_B64, 'base64');
      cookiesPath = path.join(outDir, 'yt_cookies.txt');
      await fs.writeFile(cookiesPath, buf);
      logger.info('YouTube cookies detected');
    } catch (e) {
      logger.warn('Failed to write YouTube cookies, proceeding without', { error: e });
      cookiesPath = undefined;
    }
  }

  type Attempt = { name: string; args: string[] };
  const attempts: Attempt[] = [];

  // Attempt 1: Flexible Merge (Most Reliable).
  attempts.push({
    name: 'Flexible Merge',
    args: ['-f', 'bestvideo*+bestaudio/best', '--merge-output-format', 'mp4'],
  });

  // Attempt 2: Flexible Merge with Cookies (for restricted content).
  if (cookiesPath) {
    attempts.push({
      name: 'Flexible Merge with Cookies',
      args: ['-f', 'bestvideo*+bestaudio/best', '--merge-output-format', 'mp4', '--cookies', cookiesPath],
    });
  }

  try {
    let last: { code: number; stdout: string; stderr: string; durationMs: number } | null = null;
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i]!;
      const desktopUA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
      const commonArgs = ['--user-agent', desktopUA, '--add-header', 'Referer:https://www.youtube.com/'];
      const args = [...base, ...a.args, ...commonArgs, url];

      logger.info(`yt-dlp attempt (youtube) #${i + 1}: ${a.name}`);
      if (config.DEBUG_YTDLP) logger.debug('yt-dlp args (youtube)', { args });

      const result = await run('yt-dlp', args, { timeout: 600000 });
      last = result;

      if (result.code === 0) {
        const filePath = await findDownloadedFile(outDir);
        if (!filePath) {
          throw new AppError(ERROR_CODES.ERR_FILE_NOT_FOUND, 'Downloaded file not found after yt-dlp success', { url, outDir });
        }
        
        const stats = await fs.stat(filePath);
        logger.info({ filePath, size: stats.size }, 'Downloaded file stats');

        const info = parseVideoInfoFromPath(filePath, url);
        // Final check: if we got an audio file, it's a failure for the user.
        if (['.m4a', '.mp3', '.opus'].includes(path.extname(filePath).toLowerCase())) {
            logger.warn('Merge likely failed, only an audio file was found', { filePath });
            // Continue to the next attempt if possible
            if (i < attempts.length - 1) continue;
            // Or fail if this was the last attempt
            throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Failed to merge video and audio, only audio was downloaded.', { url, outDir });
        }

        logger.info('YouTube video downloaded successfully', { attempt: a.name, url, filePath, info });
        return { filePath, videoInfo: info };
      }
      logger.warn('yt-dlp attempt failed (youtube)', { attempt: a.name, code: result.code, stderrPreview: (result.stderr||'').slice(0,1200) });
    }

    const stderrPreview = (last?.stderr || '').slice(0, 1200);
    logger.error('All yt-dlp attempts failed (youtube)', { url, stderrPreview });
    throw new AppError(mapYtDlpError(last?.stderr || ''), 'yt-dlp download failed', { url, stderr: last?.stderr, code: last?.code });
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error('Unexpected error during YouTube download', { error, url, outDir });
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Unexpected error during download', { url, originalError: error });
  }
}