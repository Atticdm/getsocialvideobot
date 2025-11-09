import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { run } from '../../core/exec';
import { logger } from '../../core/logger';
import { ERROR_CODES, AppError } from '../../core/errors';
import { DownloadResult, VideoMetadata } from '../types';
import { config } from '../../core/config';
import { parseVideoInfoFromPath } from '../utils';

function mapYtDlpError(stderr: string): string {
  const s = (stderr || '').toLowerCase();
  if (s.includes('login') || s.includes('private') || s.includes('only available to')) return ERROR_CODES.ERR_PRIVATE_OR_RESTRICTED;
  if (s.includes('http error 4') || s.includes('429') || s.includes('rate limit')) return ERROR_CODES.ERR_FETCH_FAILED;
  if (s.includes('unsupported url') || s.includes('no video found') || s.includes('cannot parse')) return ERROR_CODES.ERR_UNSUPPORTED_URL;
  if (s.includes('geo') || s.includes('blocked')) return ERROR_CODES.ERR_GEO_BLOCKED;
  return ERROR_CODES.ERR_INTERNAL;
}

async function findDownloadedFile(outDir: string): Promise<string | null> {
  const files = await fs.readdir(outDir);
  const candidates = files.filter((f) => ['.mp4', '.mkv', '.webm', '.mov', '.avi'].includes(path.extname(f).toLowerCase()));
  if (candidates.length === 0) return null;
  const stats = await Promise.all(candidates.map(async (f) => {
    const p = path.join(outDir, f);
    const st = await fs.stat(p);
    return { p, mtime: st.mtime };
  }));
  stats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return stats[0]?.p || null;
}

type Attempt = { referer: string; ua: string; useCookies: boolean; target: string };

function createBaseArgs(outDir: string): string[] {
  const base = [
    '--no-playlist',
    '--geo-bypass',
    '-4',
    '--retries', '3',
    '--fragment-retries', '10',
    '--sleep-requests', '1',
    '-f', 'best[ext=mp4]/best',
    '-o', path.join(outDir, '%(title).80B.%(id)s.%(ext)s'),
  ];
  if (config.GEO_BYPASS_COUNTRY) base.push('--geo-bypass-country', config.GEO_BYPASS_COUNTRY);
  if (config.LOG_LEVEL === 'debug' || config.LOG_LEVEL === 'trace') base.unshift('-v');
  return base;
}

async function prepareLinkedInCookies(outDir: string): Promise<string | undefined> {
  const canUseCookies = !!config['LINKEDIN_COOKIES_B64'] && !config['SKIP_COOKIES'];
  if (!canUseCookies) return undefined;
  try {
    const buf = Buffer.from(config['LINKEDIN_COOKIES_B64'], 'base64');
    const cookiesPath = path.join(outDir, 'li_cookies.txt');
    await fs.writeFile(cookiesPath, buf);
    logger.info('LinkedIn cookies detected');
    return cookiesPath;
  } catch (error) {
    logger.warn('Failed to write LinkedIn cookies, proceeding without', { error });
    return undefined;
  }
}

function buildLinkedInAttempts(url: string, cookiesPath?: string): Attempt[] {
  const desktopUA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const mobileUA = 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
  const attempts: Attempt[] = [];
  attempts.push({ target: url, referer: 'https://www.linkedin.com/', ua: desktopUA, useCookies: false });
  attempts.push({ target: url, referer: 'https://m.linkedin.com/', ua: mobileUA, useCookies: false });
  if (cookiesPath) {
    attempts.push({ target: url, referer: 'https://www.linkedin.com/', ua: desktopUA, useCookies: true });
    attempts.push({ target: url, referer: 'https://m.linkedin.com/', ua: mobileUA, useCookies: true });
  }
  return attempts;
}

export async function downloadLinkedInVideo(url: string, outDir: string): Promise<DownloadResult> {
  logger.info('Starting LinkedIn video download', { url, outDir });

  const base = createBaseArgs(outDir);
  const cookiesPath = await prepareLinkedInCookies(outDir);
  const attempts = buildLinkedInAttempts(url, cookiesPath);

  try {
    let last: { code: number; stdout: string; stderr: string; durationMs: number } | null = null;
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i]!;
      const args = [...base, '--add-header', `Referer:${a.referer}`, '--user-agent', a.ua];
      if (a.useCookies && cookiesPath) args.push('--cookies', cookiesPath);
      args.push(a.target);
      logger.info('yt-dlp attempt (linkedin)', { attempt: i + 1, cookies: a.useCookies && !!cookiesPath, ua: a.ua.includes('Android') ? 'android' : 'desktop' });
      if (config.DEBUG_YTDLP) logger.debug('yt-dlp args (linkedin)', { args });
      const result = await run('yt-dlp', args, { timeout: 300000 });
      last = result;
      if (result.code === 0) {
        const filePath = await findDownloadedFile(outDir);
        if (!filePath) throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Downloaded file not found', { url: a.target, outDir });
        const info = await parseVideoInfoFromPath(filePath, a.target);
        logger.info('LinkedIn video downloaded successfully', { url: a.target, filePath, info });
        return { filePath, videoInfo: info };
      }
      logger.warn('yt-dlp attempt failed (linkedin)', { attempt: i + 1, code: result.code });
    }

    const stderrPreview = (last?.stderr || '').slice(0, 1200);
    const stdoutPreview = (last?.stdout || '').slice(0, 400);
    logger.error('All yt-dlp attempts failed (linkedin)', { url, stderrPreview, stdoutPreview });
    throw new AppError(mapYtDlpError(last?.stderr || ''), 'yt-dlp download failed', { url, stderr: last?.stderr, stdout: last?.stdout, code: last?.code });
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error('Unexpected error during LinkedIn download', { error, url, outDir });
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Unexpected error during download', { url, originalError: error });
  }
}

export async function fetchLinkedInMetadata(url: string): Promise<VideoMetadata> {
  logger.info('Fetching LinkedIn metadata', { url });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'li-meta-'));
  try {
    const cookiesPath = await prepareLinkedInCookies(tempDir);
    const attempts = buildLinkedInAttempts(url, cookiesPath);
    const base = createBaseArgs(tempDir);

    let lastError: AppError | Error | null = null;
    for (const attempt of attempts) {
      const args = [...base, '--dump-single-json', '--skip-download', '--add-header', `Referer:${attempt.referer}`, '--user-agent', attempt.ua];
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
          lastError = error instanceof Error ? error : new Error(String(error));
          logger.warn('Failed to parse LinkedIn metadata JSON', { url: attempt.target, error: lastError.message });
        }
      } else {
        lastError = new AppError(mapYtDlpError(result.stderr), 'Metadata attempt failed', { url: attempt.target, stderr: result.stderr, code: result.code });
      }
    }

    if (lastError instanceof AppError) throw lastError;
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Failed to resolve LinkedIn metadata', { url, lastError: lastError?.message });
  } finally {
    try { await fs.remove(tempDir); } catch (error) {
      logger.warn('Failed to cleanup temp dir after LinkedIn metadata', { url, error });
    }
  }
}

function extractMetadata(json: any, fallbackUrl: string): VideoMetadata {
  const requested = Array.isArray(json?.requested_downloads) && json.requested_downloads.length > 0 ? json.requested_downloads[0] : null;
  const downloadUrl: string | undefined = requested?.url || json?.url;
  const fileSize: number | undefined = requested?.filesize || requested?.filesizeApprox || json?.filesize || json?.filesizeApprox;
  const duration: number | undefined = json?.duration || requested?.duration;
  const title: string = json?.title || requested?.title || 'LinkedIn video';
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
