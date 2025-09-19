import * as fs from 'fs-extra';
import * as path from 'path';
import { run } from '../../core/exec';
import { logger } from '../../core/logger';
import { ERROR_CODES, AppError } from '../../core/errors';
import { VideoInfo, DownloadResult } from '../types';
import { config } from '../../core/config';

function mapYtDlpError(stderr: string): string {
  const s = (stderr || '').toLowerCase();
  if (s.includes('login') || s.includes('private') || s.includes('sign in') || s.includes('age') || s.includes('restricted') || s.includes('members-only')) return ERROR_CODES.ERR_PRIVATE_OR_RESTRICTED;
  if (s.includes('http error 4') || s.includes('429') || s.includes('rate limit')) return ERROR_CODES.ERR_FETCH_FAILED;
  if (s.includes('unsupported url') || s.includes('no video formats') || s.includes('video unavailable')) return ERROR_CODES.ERR_UNSUPPORTED_URL;
  if (s.includes('geo') || s.includes('blocked')) return ERROR_CODES.ERR_GEO_BLOCKED;
  return ERROR_CODES.ERR_INTERNAL;
}

function parseVideoInfoFromPath(filePath: string, url: string): VideoInfo {
  const fileName = path.basename(filePath);
  const ext = path.extname(fileName);
  const base = fileName.slice(0, -ext.length);
  const parts = base.split('.');
  const id = parts[parts.length - 1] || 'unknown';
  let title = base.replace(`.${id}`, '');
  if (title.length > 100) title = title.slice(0, 100) + '...';
  return { id, title, url };
}

async function findDownloadedFile(outDir: string): Promise<string | null> {
  const files = await fs.readdir(outDir);
  const candidates = files.filter((f) => ['.mp4', '.mkv', '.webm', '.mov'].includes(path.extname(f).toLowerCase()));
  if (candidates.length === 0) return null;
  const stats = await Promise.all(candidates.map(async (f) => {
    const p = path.join(outDir, f);
    const st = await fs.stat(p);
    return { p, mtime: st.mtime };
  }));
  stats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return stats[0]?.p || null;
}

export async function downloadYouTubeVideo(url: string, outDir: string): Promise<DownloadResult> {
  logger.info('Starting YouTube video download', { url, outDir });

  const base = [
    '--no-playlist',
    '--geo-bypass',
    '-4',
    '--retries', '3',
    '--fragment-retries', '10',
    '--sleep-requests', '1',
    '--ignore-config',
    '--postprocessor-args', 'ffmpeg:-movflags +faststart',
    '-o', path.join(outDir, '%(title).80B.%(id)s.%(ext)s'),
  ];
  if (config.GEO_BYPASS_COUNTRY) base.push('--geo-bypass-country', config.GEO_BYPASS_COUNTRY);
  if (config.LOG_LEVEL === 'debug' || config.LOG_LEVEL === 'trace') base.unshift('-v');

  // Optional cookies for age-restricted or members-only videos
  let cookiesPath: string | undefined;
  const canUseCookies = !!config['YOUTUBE_COOKIES_B64'] && !config['SKIP_COOKIES'];
  if (canUseCookies) {
    try {
      const buf = Buffer.from(config['YOUTUBE_COOKIES_B64'], 'base64');
      cookiesPath = path.join(outDir, 'yt_cookies.txt');
      await fs.writeFile(cookiesPath, buf);
      logger.info('YouTube cookies detected');
    } catch (e) {
      logger.warn('Failed to write YouTube cookies, proceeding without', { error: e });
      cookiesPath = undefined;
    }
  }

  // Optimized download strategies for better video+audio merging
  type Attempt = { name: string; useCookies: boolean; args: string[] };
  const desktopUA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

  const attempts: Attempt[] = [];

  // Attempt 1: Flexible Merge. The most reliable method.
  // Gets the best video and best audio streams regardless of container and merges them into an MP4 file.
  attempts.push({
    name: 'Flexible Merge',
    useCookies: false,
    args: ['-f', 'bestvideo*+bestaudio/best', '--merge-output-format', 'mp4']
  });

  // Attempt 2: Progressive Fallback.
  // Useful for lower resolutions or if merging fails. Gets the best pre-merged MP4 file.
  attempts.push({
    name: 'Progressive Fallback',
    useCookies: false,
    args: ['-f', 'best[ext=mp4]/best']
  });

  // Attempt 3: Flexible Merge with Cookies.
  // For age-restricted or members-only content.
  if (cookiesPath) {
    attempts.push({
      name: 'Flexible Merge with Cookies',
      useCookies: true,
      args: ['-f', 'bestvideo*+bestaudio/best', '--merge-output-format', 'mp4']
    });
  }

  try {
    let last: { code: number; stdout: string; stderr: string; durationMs: number } | null = null;
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i]!;
      const args = [...base, '--add-header', 'Referer:https://www.youtube.com', '--user-agent', desktopUA, ...a.args, url];
      if (a.useCookies && cookiesPath) args.push('--cookies', cookiesPath);
      if (config.DEBUG_YTDLP) logger.debug('yt-dlp args (youtube)', { attempt: a.name, args });
      const result = await run('yt-dlp', args, { timeout: 600000 });
      last = result;
      if (result.code === 0) {
        const filePath = await findDownloadedFile(outDir);
        if (!filePath) throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Downloaded file not found', { url, outDir });
        const info = parseVideoInfoFromPath(filePath, url);
        logger.info('YouTube video downloaded successfully', { attempt: a.name, url, filePath, info });
        return { filePath, videoInfo: info };
      }
      logger.warn('yt-dlp attempt failed (youtube)', { attempt: a.name, index: i + 1, code: result.code, stderrPreview: (result.stderr||'').slice(0,1200) });
    }

    const stderrPreview = (last?.stderr || '').slice(0, 1200);
    const stdoutPreview = (last?.stdout || '').slice(0, 400);
    logger.error('All yt-dlp attempts failed (youtube)', { url, stderrPreview, stdoutPreview });
    throw new AppError(mapYtDlpError(last?.stderr || ''), 'yt-dlp download failed', { url, stderr: last?.stderr, stdout: last?.stdout, code: last?.code });
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error('Unexpected error during YouTube download', { error, url, outDir });
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Unexpected error during download', { url, originalError: error });
  }
}
