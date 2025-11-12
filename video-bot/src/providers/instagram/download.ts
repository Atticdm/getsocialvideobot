import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { run } from '../../core/exec';
import { logger } from '../../core/logger';
import { ERROR_CODES, AppError } from '../../core/errors';
import { DownloadResult, VideoMetadata } from '../types';
import { config } from '../../core/config';
import { parseVideoInfoFromPath } from '../utils';

function extractReelCode(u: string): string | null {
  try {
    const m = u.match(/instagram\.com\/(?:reel|reels)\/([A-Za-z0-9_-]+)/);
    if (m && m[1]) return m[1];
  } catch {}
  return null;
}

function normalizeReelUrl(u: string): string {
  const code = extractReelCode(u);
  return code ? `https://www.instagram.com/reel/${code}/` : u;
}

function mapYtDlpError(stderr: string): string {
  const s = stderr.toLowerCase();
  // More specific error patterns to avoid false positives
  // Check for actual error messages, not just keywords that might appear in progress output
  // Look for error: prefix or specific error patterns
  const hasErrorPrefix = s.includes('error:') || s.includes('err:') || s.includes('fatal:');
  
  // Проверка на приватные видео и требование авторизации
  if (
    (hasErrorPrefix && (s.includes('private video') || s.includes('video is private'))) ||
    s.includes('login required') ||
    s.includes('sign in to') ||
    s.includes('only available to') ||
    s.includes('this video is not available') ||
    s.includes('content is not available') ||
    s.includes('private account') ||
    s.includes('private user') ||
    s.includes('private post') ||
    s.includes('this account is private') ||
    s.includes('user is private') ||
    (hasErrorPrefix && s.includes('private') && (s.includes('account') || s.includes('user') || s.includes('post'))) ||
    s.includes('authentication required') ||
    s.includes('please log in')
  ) {
    return ERROR_CODES.ERR_PRIVATE_OR_RESTRICTED;
  }
  
  // Проверка на rate limit и HTTP ошибки
  if (
    s.includes('http error 4') || 
    s.includes('429') || 
    s.includes('rate limit') || 
    s.includes('too many requests') ||
    s.includes('http 429') ||
    s.includes('http error 429')
  ) {
    return ERROR_CODES.ERR_FETCH_FAILED;
  }
  
  // Проверка на неподдерживаемый URL или отсутствие видео
  if (
    s.includes('unsupported url') ||
    s.includes('no video found') ||
    s.includes('cannot parse') ||
    s.includes('unable to extract') ||
    s.includes('video unavailable') ||
    s.includes('unable to download') ||
    s.includes('no video formats found') ||
    (hasErrorPrefix && s.includes('unable to extract video data')) ||
    (hasErrorPrefix && s.includes('unable to download video'))
  ) {
    return ERROR_CODES.ERR_UNSUPPORTED_URL;
  }
  
  // Проверка на геоблокировку
  if (
    s.includes('geo-blocked') || 
    s.includes('not available in your country') || 
    (s.includes('blocked') && s.includes('region')) ||
    s.includes('georestricted')
  ) {
    return ERROR_CODES.ERR_GEO_BLOCKED;
  }
  
  // Если есть явная ошибка, но она не распознана - логируем для анализа
  if (hasErrorPrefix) {
    logger.warn('Unrecognized yt-dlp error pattern', { 
      stderrPreview: stderr.slice(0, 500),
      errorKeywords: [
        s.includes('private') ? 'private' : null,
        s.includes('login') ? 'login' : null,
        s.includes('unable') ? 'unable' : null,
        s.includes('error') ? 'error' : null,
      ].filter(Boolean)
    });
  }
  
  return ERROR_CODES.ERR_INTERNAL;
}

type Attempt = { target: string; referer: string; ua: string; useCookies: boolean };

async function findDownloadedFile(outDir: string): Promise<string | null> {
  try {
    const files = await fs.readdir(outDir);
    // Include more video formats and also check for partial downloads
    const candidates = files.filter((f) => {
      const ext = path.extname(f).toLowerCase();
      return ['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v'].includes(ext) && !f.endsWith('.part');
    });
    if (candidates.length === 0) {
      logger.debug('No video files found in directory', { outDir, files });
      return null;
    }
    const stats = await Promise.all(
      candidates.map(async (f) => {
        const p = path.join(outDir, f);
        const st = await fs.stat(p);
        return { p, mtime: st.mtime, size: st.size };
      })
    );
    // Sort by modification time (newest first) and prefer larger files (likely complete downloads)
    stats.sort((a, b) => {
      const timeDiff = b.mtime.getTime() - a.mtime.getTime();
      if (Math.abs(timeDiff) < 1000) {
        // If files are created within 1 second, prefer larger one
        return b.size - a.size;
      }
      return timeDiff;
    });
    const found = stats[0]?.p || null;
    if (found) {
      logger.debug('Found downloaded file', { filePath: found, size: stats[0]?.size });
    }
    return found;
  } catch (error) {
    logger.error('Error finding downloaded file', { error, outDir });
    return null;
  }
}

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

async function prepareInstagramCookies(outDir: string): Promise<string | undefined> {
  const canUseCookies = !!config['INSTAGRAM_COOKIES_B64'] && !config['SKIP_COOKIES'];
  if (!canUseCookies) return undefined;
  try {
    const buf = Buffer.from(config['INSTAGRAM_COOKIES_B64'], 'base64');
    const cookiesPath = path.join(outDir, 'ig_cookies.txt');
    await fs.writeFile(cookiesPath, buf);
    logger.info('Instagram cookies detected');
    return cookiesPath;
  } catch (error) {
    logger.warn('Failed to write Instagram cookies, proceeding without', { error });
    return undefined;
  }
}

function buildInstagramAttempts(url: string, normalizedUrl: string, cookiesPath?: string): Attempt[] {
  const desktopUA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const mobileUA = 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

  const code = extractReelCode(url) || extractReelCode(normalizedUrl);
  const mobileUrl = code ? `https://m.instagram.com/reel/${code}/` : undefined;

  const attempts: Attempt[] = [];
  attempts.push({ target: url, referer: 'https://www.instagram.com/', ua: desktopUA, useCookies: false });
  attempts.push({ target: normalizedUrl, referer: 'https://www.instagram.com/', ua: desktopUA, useCookies: false });
  if (mobileUrl) attempts.push({ target: mobileUrl, referer: 'https://m.instagram.com/', ua: mobileUA, useCookies: false });
  if (cookiesPath) {
    attempts.push({ target: url, referer: 'https://www.instagram.com/', ua: desktopUA, useCookies: true });
    attempts.push({ target: normalizedUrl, referer: 'https://www.instagram.com/', ua: desktopUA, useCookies: true });
    if (mobileUrl) attempts.push({ target: mobileUrl, referer: 'https://m.instagram.com/', ua: mobileUA, useCookies: true });
  }
  return attempts;
}

export async function downloadInstagramVideo(url: string, outDir: string): Promise<DownloadResult> {
  const normalizedUrl = normalizeReelUrl(url);
  logger.info('Starting Instagram video download', { url, normalizedUrl, outDir });

  // Проверяем доступность yt-dlp перед началом
  try {
    const { run } = await import('../../core/exec');
    const versionCheck = await run('yt-dlp', ['--version'], { timeout: 5000 });
    if (versionCheck.code !== 0) {
      logger.error('yt-dlp is not available or not working', { 
        stderr: versionCheck.stderr,
        stdout: versionCheck.stdout 
      });
      throw new AppError(ERROR_CODES.ERR_INTERNAL, 'yt-dlp is not available. Please check installation.');
    }
    logger.debug('yt-dlp version check passed', { version: versionCheck.stdout.trim() });
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error('Failed to check yt-dlp availability', { error });
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Failed to verify yt-dlp installation', { originalError: error });
  }

  const base = createBaseArgs(outDir);
  const cookiesPath = await prepareInstagramCookies(outDir);
  const attempts = buildInstagramAttempts(url, normalizedUrl, cookiesPath);

  try {
    let last: { code: number; stdout: string; stderr: string; durationMs: number } | null = null;
    for (let i = 0; i < attempts.length; i++) {
      const a = attempts[i]!;
      const args = [...base, '--add-header', `Referer:${a.referer}`, '--user-agent', a.ua];
      if (a.useCookies && cookiesPath) args.push('--cookies', cookiesPath);
      args.push(a.target);
      logger.info('yt-dlp attempt (instagram)', { attempt: i + 1, target: a.target, cookies: a.useCookies && !!cookiesPath, ua: a.ua.includes('Android') ? 'android' : 'desktop' });
      if (config.DEBUG_YTDLP || config.LOG_LEVEL === 'debug') {
        logger.debug('yt-dlp args (instagram)', { args });
      }
      
      const result = await run('yt-dlp', args, { timeout: 300000 });
      last = result;
      
      // Логируем результат каждой попытки для диагностики
      if (result.code !== 0) {
        logger.warn('yt-dlp attempt failed (instagram)', {
          attempt: i + 1,
          target: a.target,
          code: result.code,
          stderrLength: result.stderr.length,
          stdoutLength: result.stdout.length,
          stderrPreview: result.stderr.slice(0, 500),
          stdoutPreview: result.stdout.slice(0, 200),
        });
      }

      if (result.code === 0) {
        const filePath = await findDownloadedFile(outDir);
        if (filePath) {
        const videoInfo = await parseVideoInfoFromPath(filePath, a.target);
          logger.info('Instagram video downloaded successfully', { url: a.target, filePath, videoInfo, exitCode: result.code });
          return { filePath, videoInfo };
        }

        logger.warn('yt-dlp returned success but no file found (instagram)', {
          attempt: i + 1,
          outDir,
          stderrPreview: (result.stderr || '').slice(0, 500),
          stdoutPreview: (result.stdout || '').slice(0, 200),
        });
        continue;
      }

      logger.warn('yt-dlp attempt failed (instagram)', {
        attempt: i + 1,
        code: result.code,
        stderrPreview: (result.stderr || '').slice(0, 500),
        stdoutPreview: (result.stdout || '').slice(0, 200),
      });
    }

    // Final check: maybe file was downloaded in the last attempt but we missed it
    const finalFilePath = await findDownloadedFile(outDir);
    if (finalFilePath) {
      logger.info('Found file after all attempts (instagram)', { filePath: finalFilePath, url });
      const videoInfo = await parseVideoInfoFromPath(finalFilePath, url);
      return { filePath: finalFilePath, videoInfo };
    }

    const stderrPreview = (last?.stderr || '').slice(0, 1200);
    const stdoutPreview = (last?.stdout || '').slice(0, 400);
    
    // Log directory contents for debugging
    try {
      const dirContents = await fs.readdir(outDir);
      logger.error('All yt-dlp attempts failed (instagram)', {
        url,
        normalizedUrl,
        stderrPreview,
        stdoutPreview,
        attemptsCount: attempts.length,
        lastExitCode: last?.code,
        outDirContents: dirContents,
      });
    } catch {
      logger.error('All yt-dlp attempts failed (instagram)', {
        url,
        normalizedUrl,
        stderrPreview,
        stdoutPreview,
        attemptsCount: attempts.length,
        lastExitCode: last?.code,
      });
    }
    
    // Log full stderr/stdout for troubleshooting (always log in case of failure)
    const fullStderr = last?.stderr || '';
    const fullStdout = last?.stdout || '';
    
    logger.error('Full yt-dlp stderr (instagram)', { 
      stderr: fullStderr,
      stderrLength: fullStderr.length,
      url,
      normalizedUrl,
    });
    logger.error('Full yt-dlp stdout (instagram)', { 
      stdout: fullStdout,
      stdoutLength: fullStdout.length,
      url,
      normalizedUrl,
    });
    
    // Если stderr пустой, это может означать проблему с запуском yt-dlp
    if (!fullStderr && !fullStdout && last?.code !== 0) {
      logger.error('yt-dlp returned error code but no output - possible installation issue', {
        code: last.code,
        url,
        normalizedUrl,
      });
    }
    
    // Analyze stderr more carefully before mapping error
    const stderrText = (last?.stderr || '').toLowerCase();
    const hasActualError = stderrText.includes('error:') || 
                          stderrText.includes('warning:') ||
                          stderrText.includes('fatal:') ||
                          last?.code !== 0;
    
    if (!hasActualError && last?.code === 0) {
      // Exit code is 0 but no file found - this is a different error
      logger.error('yt-dlp succeeded but no file found (instagram)', {
        url,
        outDir,
        stderr: last?.stderr,
        stdout: last?.stdout,
      });
      throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Download completed but file not found', { 
        url, 
        stderr: last?.stderr, 
        stdout: last?.stdout 
      });
    }
    
    throw new AppError(mapYtDlpError(last?.stderr || ''), 'yt-dlp download failed', { url, stderr: last?.stderr, stdout: last?.stdout, code: last?.code });
  } catch (error) {
    if (error instanceof AppError) throw error;
    logger.error('Unexpected error during Instagram download', { error, url, outDir });
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Unexpected error during download', { url, originalError: error });
  }
}

export async function fetchInstagramMetadata(url: string): Promise<VideoMetadata> {
  logger.info('Fetching Instagram metadata', { url });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ig-meta-'));
  try {
    const normalizedUrl = normalizeReelUrl(url);
    const cookiesPath = await prepareInstagramCookies(tempDir);
    const attempts = buildInstagramAttempts(url, normalizedUrl, cookiesPath);
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
          logger.warn('Failed to parse Instagram metadata JSON', { url: attempt.target, error: lastError.message });
        }
      } else {
        lastError = new AppError(mapYtDlpError(result.stderr), 'Metadata attempt failed', { url: attempt.target, stderr: result.stderr, code: result.code });
      }
    }

    if (lastError instanceof AppError) throw lastError;
    throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Failed to resolve Instagram metadata', { url, lastError: lastError?.message });
  } finally {
    try { await fs.remove(tempDir); } catch (error) {
      logger.warn('Failed to cleanup temp dir after Instagram metadata', { url, error });
    }
  }
}

function extractMetadata(json: any, fallbackUrl: string): VideoMetadata {
  const requested = Array.isArray(json?.requested_downloads) && json.requested_downloads.length > 0 ? json.requested_downloads[0] : null;
  const downloadUrl: string | undefined = requested?.url || json?.url;
  const fileSize: number | undefined = requested?.filesize || requested?.filesizeApprox || json?.filesize || json?.filesizeApprox;
  const duration: number | undefined = json?.duration || requested?.duration;
  const title: string = json?.title || requested?.title || 'Instagram video';
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
