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

function mapYtDlpError(stderr: string, exitCode?: number, url?: string): string {
  const s = stderr.toLowerCase();
  const fullStderr = stderr; // Сохраняем оригинальный stderr для логирования
  
  // More specific error patterns to avoid false positives
  // Check for actual error messages, not just keywords that might appear in progress output
  // Look for error: prefix or specific error patterns
  const hasErrorPrefix = s.includes('error:') || s.includes('err:') || s.includes('fatal:');
  
  // Детальное логирование для диагностики
  logger.debug('mapYtDlpError: Analyzing error', {
    url,
    exitCode,
    stderrLength: stderr.length,
    hasErrorPrefix,
    stderrPreview: stderr.slice(0, 1000),
    firstLine: stderr.split('\n')[0]?.slice(0, 200),
    lastLine: stderr.split('\n').filter(Boolean).pop()?.slice(0, 200),
  });
  
  // Проверка на приватные видео и требование авторизации
  const privatePatterns = [
    (hasErrorPrefix && (s.includes('private video') || s.includes('video is private'))),
    s.includes('login required'),
    s.includes('sign in to'),
    s.includes('only available to'),
    s.includes('this video is not available'),
    s.includes('content is not available'),
    s.includes('private account'),
    s.includes('private user'),
    s.includes('private post'),
    s.includes('this account is private'),
    s.includes('user is private'),
    (hasErrorPrefix && s.includes('private') && (s.includes('account') || s.includes('user') || s.includes('post'))),
    s.includes('authentication required'),
    s.includes('please log in'),
  ];
  
  if (privatePatterns.some(Boolean)) {
    logger.info('mapYtDlpError: Detected ERR_PRIVATE_OR_RESTRICTED', {
      url,
      exitCode,
      matchedPatterns: privatePatterns.map((p, i) => p ? i : null).filter((v): v is number => v !== null),
      stderrPreview: stderr.slice(0, 500),
    });
    return ERROR_CODES.ERR_PRIVATE_OR_RESTRICTED;
  }
  
  // Проверка на rate limit и HTTP ошибки
  const rateLimitPatterns = [
    s.includes('http error 4'),
    s.includes('429'),
    s.includes('rate limit'),
    s.includes('too many requests'),
    s.includes('http 429'),
    s.includes('http error 429'),
  ];
  
  if (rateLimitPatterns.some(Boolean)) {
    logger.info('mapYtDlpError: Detected ERR_FETCH_FAILED (rate limit)', {
      url,
      exitCode,
      matchedPatterns: rateLimitPatterns.map((p, i) => p ? i : null).filter((v): v is number => v !== null),
      stderrPreview: stderr.slice(0, 500),
    });
    return ERROR_CODES.ERR_FETCH_FAILED;
  }
  
  // Проверка на ошибки с cookies (неправильная кодировка или формат)
  if (
    s.includes('utf-8') && s.includes("codec can't decode") ||
    s.includes('unicodedecodeerror') ||
    (hasErrorPrefix && s.includes('cookies.py') && s.includes('decode'))
  ) {
    logger.warn('mapYtDlpError: Detected cookies encoding error', {
      url,
      exitCode,
      stderrPreview: stderr.slice(0, 500),
    });
    // Возвращаем ERR_INTERNAL, но это специфичная ошибка cookies
    // В будущем можно добавить отдельный код ошибки ERR_INVALID_COOKIES
    return ERROR_CODES.ERR_INTERNAL;
  }
  
  // Проверка на неподдерживаемый URL или отсутствие видео
  const unsupportedPatterns = [
    s.includes('unsupported url'),
    s.includes('no video found'),
    s.includes('cannot parse'),
    s.includes('unable to extract'),
    s.includes('video unavailable'),
    s.includes('unable to download'),
    s.includes('no video formats found'),
    (hasErrorPrefix && s.includes('unable to extract video data')),
    (hasErrorPrefix && s.includes('unable to download video')),
  ];
  
  if (unsupportedPatterns.some(Boolean)) {
    logger.info('mapYtDlpError: Detected ERR_UNSUPPORTED_URL', {
      url,
      exitCode,
      matchedPatterns: unsupportedPatterns.map((p, i) => p ? i : null).filter((v): v is number => v !== null),
      stderrPreview: stderr.slice(0, 500),
    });
    return ERROR_CODES.ERR_UNSUPPORTED_URL;
  }
  
  // Проверка на геоблокировку
  const geoBlockedPatterns = [
    s.includes('geo-blocked'),
    s.includes('not available in your country'),
    (s.includes('blocked') && s.includes('region')),
    s.includes('georestricted'),
  ];
  
  if (geoBlockedPatterns.some(Boolean)) {
    logger.info('mapYtDlpError: Detected ERR_GEO_BLOCKED', {
      url,
      exitCode,
      matchedPatterns: geoBlockedPatterns.map((p, i) => p ? i : null).filter((v): v is number => v !== null),
      stderrPreview: stderr.slice(0, 500),
    });
    return ERROR_CODES.ERR_GEO_BLOCKED;
  }
  
  // Если есть явная ошибка, но она не распознана - логируем для анализа
  if (hasErrorPrefix) {
    // Извлекаем все строки с ошибками для детального анализа
    const errorLines = stderr.split('\n').filter(line => {
      const lower = line.toLowerCase();
      return lower.includes('error:') || lower.includes('err:') || lower.includes('fatal:');
    });
    
    // Логируем прямо в сообщении для видимости в Railway
    const errorLinesStr = errorLines.join(' | ');
    const keywordsStr = [
      s.includes('private') ? 'private' : null,
      s.includes('login') ? 'login' : null,
      s.includes('unable') ? 'unable' : null,
      s.includes('error') ? 'error' : null,
      s.includes('http') ? 'http' : null,
      s.includes('blocked') ? 'blocked' : null,
      s.includes('unavailable') ? 'unavailable' : null,
      s.includes('not found') ? 'not found' : null,
      s.includes('failed') ? 'failed' : null,
      s.includes('timeout') ? 'timeout' : null,
    ].filter(Boolean).join(', ');
    
    logger.error(`mapYtDlpError: Unrecognized yt-dlp error pattern | URL: ${url} | ExitCode: ${exitCode} | stderrLength: ${stderr.length} | Keywords: [${keywordsStr}] | ErrorLines: [${errorLinesStr}] | FullStderr: ${fullStderr}`);
    
    // Также логируем как объект для структурированных логов
    logger.error('mapYtDlpError: Unrecognized yt-dlp error pattern', { 
      url,
      exitCode,
      stderrLength: stderr.length,
      stderrFull: fullStderr, // Полный stderr для анализа
      errorLines, // Только строки с ошибками
      errorKeywords: [
        s.includes('private') ? 'private' : null,
        s.includes('login') ? 'login' : null,
        s.includes('unable') ? 'unable' : null,
        s.includes('error') ? 'error' : null,
        s.includes('http') ? 'http' : null,
        s.includes('blocked') ? 'blocked' : null,
        s.includes('unavailable') ? 'unavailable' : null,
        s.includes('not found') ? 'not found' : null,
        s.includes('failed') ? 'failed' : null,
        s.includes('timeout') ? 'timeout' : null,
      ].filter(Boolean),
      // Дополнительные паттерны для анализа
      containsNumbers: /\d+/.test(stderr),
      containsUrls: /https?:\/\//.test(stderr),
      containsJson: stderr.includes('{') && stderr.includes('}'),
    });
  } else {
    // Даже если нет явного префикса ошибки, но exit code != 0, логируем
    if (exitCode !== undefined && exitCode !== 0) {
      logger.warn('mapYtDlpError: Non-zero exit code but no error prefix found', {
        url,
        exitCode,
        stderrLength: stderr.length,
        stderrFull: fullStderr,
        stdoutLength: 0, // stdout будет передан отдельно если нужно
      });
    }
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
  if (!canUseCookies) {
    logger.debug('Instagram cookies not available', { 
      hasCookies: !!config['INSTAGRAM_COOKIES_B64'],
      skipCookies: !!config['SKIP_COOKIES']
    });
    return undefined;
  }
  
  const cookiesB64 = config['INSTAGRAM_COOKIES_B64']?.trim();
  if (!cookiesB64 || cookiesB64.length === 0) {
    logger.debug('Instagram cookies B64 is empty, proceeding without cookies');
    return undefined;
  }
  
  try {
    let buf: Buffer;
    try {
      buf = Buffer.from(cookiesB64, 'base64');
      // Проверяем, что декодирование прошло успешно (не пустой буфер для непустой строки)
      if (buf.length === 0 && cookiesB64.length > 0) {
        throw new Error('Base64 decoding resulted in empty buffer');
      }
    } catch (base64Error) {
      logger.warn('Failed to decode Instagram cookies from base64', {
        error: base64Error instanceof Error ? base64Error.message : String(base64Error),
        cookiesB64Length: cookiesB64.length,
        cookiesB64Preview: cookiesB64.slice(0, 50),
      });
      return undefined;
    }
    
    const cookiesPath = path.join(outDir, 'ig_cookies.txt');
    
    // Пробуем декодировать как UTF-8
    let cookiesText: string;
    try {
      cookiesText = buf.toString('utf-8');
      // Проверяем, что это валидный UTF-8 и похож на формат cookies
      if (!cookiesText.includes('\t') && !cookiesText.includes('domain') && !cookiesText.includes('cookie')) {
        // Возможно, это не текстовый формат, пробуем другие кодировки
        throw new Error('Does not look like cookies format');
      }
    } catch (utf8Error) {
      // Пробуем другие кодировки
      try {
        // Пробуем UTF-16 (может быть BOM)
        if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) {
          // UTF-16 LE BOM
          cookiesText = buf.slice(2).toString('utf16le');
        } else if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
          // UTF-16 BE BOM
          const swapped = Buffer.alloc(buf.length - 2);
          for (let i = 2; i < buf.length; i += 2) {
            const byte1 = buf[i + 1];
            const byte2 = buf[i];
            if (byte1 !== undefined && byte2 !== undefined) {
              swapped[i - 2] = byte1;
              swapped[i - 1] = byte2;
            }
          }
          cookiesText = swapped.toString('utf16le');
        } else {
          // Пробуем latin1 (ISO-8859-1) как fallback
          cookiesText = buf.toString('latin1');
        }
        
        // Проверяем валидность после декодирования
        if (!cookiesText.includes('\t') && !cookiesText.includes('domain') && !cookiesText.includes('cookie')) {
          throw new Error('Decoded text does not look like cookies format');
        }
      } catch (decodeError) {
        logger.warn('Failed to decode Instagram cookies - invalid encoding or format', {
          error: decodeError instanceof Error ? decodeError.message : String(decodeError),
          utf8Error: utf8Error instanceof Error ? utf8Error.message : String(utf8Error),
          bufferLength: buf.length,
          firstBytes: Array.from(buf.slice(0, 10)).map(b => `0x${b.toString(16)}`).join(' '),
        });
        return undefined;
      }
    }
    
    // Записываем как UTF-8 текст
    await fs.writeFile(cookiesPath, cookiesText, 'utf-8');
    logger.info('Instagram cookies detected and written successfully', {
      cookiesLength: cookiesText.length,
      firstLine: cookiesText.split('\n')[0]?.slice(0, 100),
    });
    return cookiesPath;
  } catch (error) {
    logger.warn('Failed to write Instagram cookies, proceeding without', {
      error: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    });
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
  
  logger.info('Instagram download attempts prepared', {
    url,
    normalizedUrl,
    hasCookies: !!cookiesPath,
    attemptsCount: attempts.length,
    attemptsWithoutCookies: attempts.filter(a => !a.useCookies).length,
    attemptsWithCookies: attempts.filter(a => a.useCookies).length,
  });

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
        const errorLines = result.stderr.split('\n').filter(line => {
          const lower = line.toLowerCase();
          return lower.includes('error:') || lower.includes('err:') || lower.includes('fatal:');
        });
        const errorLinesStr = errorLines.join(' | ');
        
        // Логируем прямо в сообщении для видимости в Railway
        logger.warn(`yt-dlp attempt failed (instagram) | Attempt: ${i + 1} | URL: ${a.target} | Code: ${result.code} | Duration: ${result.durationMs}ms | stderrLength: ${result.stderr.length} | stdoutLength: ${result.stdout.length} | ErrorLines: [${errorLinesStr}] | FullStderr: ${result.stderr} | FullStdout: ${result.stdout}`);
        
        // Также логируем как объект для структурированных логов
        logger.warn('yt-dlp attempt failed (instagram)', {
          attempt: i + 1,
          target: a.target,
          code: result.code,
          durationMs: result.durationMs,
          stderrLength: result.stderr.length,
          stdoutLength: result.stdout.length,
          stderrPreview: result.stderr.slice(0, 500),
          stdoutPreview: result.stdout.slice(0, 200),
          // Дополнительная диагностика
          stderrFull: result.stderr, // Полный stderr для анализа
          stdoutFull: result.stdout, // Полный stdout для анализа
          hasErrorPrefix: result.stderr.toLowerCase().includes('error:') || 
                         result.stderr.toLowerCase().includes('err:') || 
                         result.stderr.toLowerCase().includes('fatal:'),
          errorLines,
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
    
    // Логируем stderr прямо в сообщении для видимости в Railway
    logger.error(`Full yt-dlp stderr (instagram) | URL: ${url} | Length: ${fullStderr.length} | stderr: ${fullStderr}`);
    
    // Логируем stdout отдельно
    if (fullStdout) {
      logger.error(`Full yt-dlp stdout (instagram) | URL: ${url} | Length: ${fullStdout.length} | stdout: ${fullStdout}`);
    }
    
    // Также логируем как объект для структурированных логов
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
    if (!fullStderr && !fullStdout && last && last.code !== 0) {
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
    
    // Детальное логирование перед маппингом ошибки
    logger.error('About to map yt-dlp error', {
      url,
      normalizedUrl,
      exitCode: last?.code,
      stderrLength: last?.stderr?.length || 0,
      stdoutLength: last?.stdout?.length || 0,
      stderrPreview: (last?.stderr || '').slice(0, 1000),
      stdoutPreview: (last?.stdout || '').slice(0, 500),
    });
    
    const errorCode = mapYtDlpError(last?.stderr || '', last?.code, url);
    
    logger.error('Error code mapped', {
      url,
      normalizedUrl,
      errorCode,
      exitCode: last?.code,
      stderrLength: last?.stderr?.length || 0,
    });
    
    throw new AppError(errorCode, 'yt-dlp download failed', { url, stderr: last?.stderr, stdout: last?.stdout, code: last?.code });
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
        logger.warn('Instagram metadata attempt failed, mapping error', {
          url: attempt.target,
          exitCode: result.code,
          stderrLength: result.stderr.length,
          stderrPreview: result.stderr.slice(0, 500),
        });
        const metadataErrorCode = mapYtDlpError(result.stderr, result.code, attempt.target);
        lastError = new AppError(metadataErrorCode, 'Metadata attempt failed', { url: attempt.target, stderr: result.stderr, code: result.code });
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
