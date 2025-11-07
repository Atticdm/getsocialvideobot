import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';
import { run } from '../../core/exec';
import { logger } from '../../core/logger';
import { ERROR_CODES, AppError, ErrorCode } from '../../core/errors';
import { DownloadResult, VideoMetadata } from '../types';
import { config } from '../../core/config';
import { findDownloadedFile, parseVideoInfoFromPath } from '../utils';

type YouTubeArgsOptions = {
  cookiesPath?: string;
  extra?: string[];
  geoBypassCountry?: string;
};

type YouTubeDownloadStrategy = {
  name: string;
  description: string;
  options: YouTubeArgsOptions;
  retryable?: boolean;
};

async function prepareYouTubeCookies(outDir: string): Promise<string | undefined> {
  if (!config.YOUTUBE_COOKIES_B64 || config.SKIP_COOKIES) return undefined;
  try {
    const buf = Buffer.from(config.YOUTUBE_COOKIES_B64, 'base64');
    const cookiesPath = path.join(outDir, 'yt_cookies.txt');
    await fs.writeFile(cookiesPath, buf);
    logger.info('YouTube cookies detected');
    return cookiesPath;
  } catch (error) {
    logger.warn('Failed to write YouTube cookies, proceeding without', { error });
    return undefined;
  }
}

function buildYouTubeArgs(outDir: string, options?: YouTubeArgsOptions): string[] {
  const opts = options ?? {};
  const args = [
    '--no-playlist',
    '--geo-bypass',
    '--no-mtime',
    '--ffmpeg-location',
    process.env['FFMPEG_PATH'] || '/usr/bin/ffmpeg',
    '--sponsorblock-remove',
    'all',
    '--max-filesize',
    '2G',
    '-4',
    '--retries',
    '3',
    '--ignore-config',
    '--embed-metadata',
    '--embed-thumbnail',
    '--merge-output-format',
    'mp4',
    '--concurrent-fragments',
    '8',
    '-f',
    'bestvideo[ext=mp4][vcodec^=avc]+bestaudio[ext=m4a]/bestvideo[vcodec^=avc]+bestaudio/bestvideo*+bestaudio/best[ext=mp4]/best',
    '-o',
    path.join(outDir, '%(title).80B.%(id)s.%(ext)s'),
  ];

  const geoCountry = opts.geoBypassCountry ?? config.GEO_BYPASS_COUNTRY;
  if (geoCountry) args.push('--geo-bypass-country', geoCountry);
  if (opts.cookiesPath) args.push('--cookies', opts.cookiesPath);
  if (opts.extra?.length) args.push(...opts.extra);
  if (config.LOG_LEVEL === 'debug' || config.LOG_LEVEL === 'trace') args.unshift('-v');
  return args;
}

const RETRYABLE_ERROR_CODES = new Set<ErrorCode>([
  ERROR_CODES.ERR_PRIVATE_OR_RESTRICTED,
  ERROR_CODES.ERR_GEO_BLOCKED,
]);

function buildYouTubeStrategies(cookiesPath?: string): YouTubeDownloadStrategy[] {
  const strategies: YouTubeDownloadStrategy[] = [];

  if (cookiesPath) {
    strategies.push({
      name: 'default-with-cookies',
      description: 'Standard yt-dlp call with cookies',
      options: { cookiesPath },
      retryable: true,
    });
  }

  strategies.push(
    {
      name: 'default-open',
      description: 'Standard yt-dlp call without cookies',
      options: {},
      retryable: true,
    },
    {
      name: 'android-client',
      description: 'Android player client without cookies',
      options: {
        extra: ['--extractor-args', 'youtube:player_client=android,player_skip=configs'],
      },
      retryable: true,
    },
    {
      name: 'ios-client',
      description: 'iOS player client without cookies',
      options: {
        extra: ['--extractor-args', 'youtube:player_client=ios'],
      },
      retryable: true,
    },
    {
      name: 'tv-relaxed',
      description: 'TV HTML5 client with relaxed media flags',
      options: {
        extra: [
          '--extractor-args',
          'youtube:player_client=tvhtml5',
          '--skip-dash-manifest',
          '--no-check-certificates',
        ],
      },
      retryable: true,
    },
    {
      name: 'android-relaxed',
      description: 'Android testsuite client with relaxed flags',
      options: {
        extra: [
          '--extractor-args',
          'youtube:player_client=android_testsuite,player_skip=configs',
          '--skip-dash-manifest',
          '--no-check-certificates',
        ],
      },
      retryable: true,
    }
  );

  return strategies;
}

function resolveGeoCountryList(): (string | undefined)[] {
  if (config.YOUTUBE_GEO_COUNTRIES_LIST.length) {
    return config.YOUTUBE_GEO_COUNTRIES_LIST;
  }
  if (config.GEO_BYPASS_COUNTRY) {
    return [config.GEO_BYPASS_COUNTRY.toUpperCase()];
  }
  return [undefined];
}

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

  const cookiesPath = await prepareYouTubeCookies(outDir);
  const strategies = buildYouTubeStrategies(cookiesPath);
  const geoCountries = resolveGeoCountryList();
  const attempts = geoCountries.flatMap((geoCountry) =>
    strategies.map((strategy) => ({ strategy, geoCountry }))
  );

  let lastError: AppError | null = null;

  for (let i = 0; i < attempts.length; i++) {
    const attempt = attempts[i]!;
    const strategy = attempt.strategy;
    const strategyOptions: YouTubeArgsOptions = { ...strategy.options };
    if (attempt.geoCountry) {
      strategyOptions.geoBypassCountry = attempt.geoCountry;
    }
    const args = buildYouTubeArgs(outDir, strategyOptions);
    args.push(url);

    logger.info(
      { url, attempt: strategy.name, description: strategy.description, geoCountry: attempt.geoCountry },
      'Executing yt-dlp strategy for YouTube'
    );
    if (config.DEBUG_YTDLP) {
      logger.debug('yt-dlp args (youtube)', { attempt: strategy.name, geoCountry: attempt.geoCountry, args });
    }

    try {
      const result = await run('yt-dlp', args, { timeout: 900000 });

      if (result.code === 0) {
        const filePath = await findDownloadedFile(outDir);
        if (!filePath) {
          throw new AppError(ERROR_CODES.ERR_FILE_NOT_FOUND, 'Downloaded file not found after yt-dlp success', {
            url,
            outDir,
            stderr: result.stderr,
          });
        }

        const stats = await fs.stat(filePath);
        logger.info(
          { filePath, size: stats.size, attempt: strategy.name, geoCountry: attempt.geoCountry },
          'Downloaded file stats'
        );

        const info = parseVideoInfoFromPath(filePath, url);
        logger.info('YouTube video downloaded and processed successfully', { url, filePath, info });
        return { filePath, videoInfo: info };
      }

      logger.error('yt-dlp command failed (youtube)', {
        url,
        attempt: strategy.name,
        geoCountry: attempt.geoCountry,
        code: result.code,
        stderrPreview: (result.stderr || '').slice(0, 1200),
      });
      throw new AppError(mapYtDlpError(result.stderr), 'yt-dlp download failed', {
        url,
        stderr: result.stderr,
        code: result.code,
        attempt: strategy.name,
        geoCountry: attempt.geoCountry,
      });
    } catch (error) {
      if (error instanceof AppError) {
        lastError = error;
        const shouldRetry =
          strategy.retryable &&
          RETRYABLE_ERROR_CODES.has(error.code as ErrorCode) &&
          i < attempts.length - 1;

        if (shouldRetry) {
          logger.warn(
            { url, attempt: strategy.name, geoCountry: attempt.geoCountry, errorCode: error.code },
            'YouTube strategy failed, trying next fallback'
          );
          continue;
        }
        throw error;
      }

      logger.error('Unexpected error during YouTube download attempt', {
        error,
        url,
        outDir,
        attempt: strategy.name,
        geoCountry: attempt.geoCountry,
      });
      throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Unexpected error during download', {
        url,
        originalError: error,
        attempt: strategy.name,
        geoCountry: attempt.geoCountry,
      });
    }
  }

  logger.error('All YouTube download strategies failed', { url });
  if (lastError) throw lastError;
  throw new AppError(ERROR_CODES.ERR_INTERNAL, 'YouTube download failed with no strategy result', { url });
}

export async function fetchYouTubeMetadata(url: string): Promise<VideoMetadata> {
  logger.info('Fetching YouTube metadata', { url });
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yt-meta-'));
  try {
    const cookiesPath = await prepareYouTubeCookies(tempDir);
    const options: YouTubeArgsOptions = {
      extra: ['--dump-single-json', '--skip-download'],
    };
    if (cookiesPath) options.cookiesPath = cookiesPath;
    const geoCountry = resolveGeoCountryList().find((code) => !!code);
    if (geoCountry) options.geoBypassCountry = geoCountry;
    const args = buildYouTubeArgs(tempDir, options);
    args.push(url);

    const result = await run('yt-dlp', args, { timeout: 300000 });
    if (result.code !== 0) {
      logger.error('yt-dlp metadata attempt failed (youtube)', { url, code: result.code, stderrPreview: (result.stderr || '').slice(0, 800) });
      throw new AppError(mapYtDlpError(result.stderr), 'Failed to resolve metadata', { url, stderr: result.stderr, code: result.code });
    }

    try {
      const parsed = JSON.parse(result.stdout || '{}');
      const metadata = extractMetadata(parsed, url);
      if (!metadata.downloadUrl) {
        throw new Error('Missing downloadUrl in yt-dlp JSON');
      }
      return metadata;
    } catch (error) {
      logger.error('Failed to parse yt-dlp metadata JSON (youtube)', { url, error });
      throw new AppError(ERROR_CODES.ERR_INTERNAL, 'Failed to parse metadata response', { url, originalError: String(error) });
    }
  } finally {
    try {
      await fs.remove(tempDir);
    } catch (error) {
      logger.warn('Failed to cleanup temp directory after metadata fetch', { url, error });
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
  const title: string = json?.title || requested?.title || 'Untitled video';

  let thumbnail: string | undefined;
  if (json?.thumbnail && typeof json.thumbnail === 'string') {
    thumbnail = json.thumbnail;
  } else if (Array.isArray(json?.thumbnails) && json.thumbnails.length > 0) {
    const best = json.thumbnails[json.thumbnails.length - 1];
    if (best && typeof best.url === 'string') thumbnail = best.url;
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
