import * as fs from 'fs-extra';
import * as path from 'path';
import { run } from '../../core/exec';
import { logger } from '../../core/logger';
import { ERROR_CODES, AppError } from '../../core/errors';
import { FacebookVideoInfo, DownloadResult } from './types';

export async function downloadFacebookVideo(url: string, outDir: string): Promise<DownloadResult> {
  logger.info('Starting Facebook video download', { url, outDir });

  // Build yt-dlp command arguments
  const args = [
    '--no-playlist',
    // Prefer MP4 if available, fall back to best
    '-f', 'best[ext=mp4]/best',
    '-o', path.join(outDir, '%(title).80B.%(id)s.%(ext)s'),
    url
  ];

  try {
    const result = await run('yt-dlp', args, { timeout: 300000 }); // 5 minutes timeout

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
    const videoInfo = parseVideoInfoFromPath(filePath, url);

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
