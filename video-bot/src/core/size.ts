import * as fs from 'fs-extra';
import { ERROR_CODES, AppError } from './errors';
import { config } from './config';
import { logger } from './logger';

export function bytesToMB(bytes: number): number {
  return bytes / (1024 * 1024);
}

export async function ensureBelowLimit(filePath: string, maxFileMB: number = config.MAX_FILE_MB): Promise<void> {
  try {
    const exists = await fs.pathExists(filePath);
    if (!exists) {
      throw new AppError(ERROR_CODES.ERR_FILE_NOT_FOUND, 'File not found for size check', { filePath });
    }
    const stats = await fs.stat(filePath);
    const fileSizeMB = bytesToMB(stats.size);
    
    logger.debug('File size check', { 
      filePath, 
      sizeBytes: stats.size, 
      sizeMB: fileSizeMB, 
      maxMB: maxFileMB 
    });

    if (fileSizeMB > maxFileMB) {
      logger.warn('File exceeds size limit', { 
        filePath, 
        sizeMB: fileSizeMB, 
        maxMB: maxFileMB 
      });
      throw new AppError(
        ERROR_CODES.ERR_TOO_LARGE,
        `File size ${fileSizeMB.toFixed(2)}MB exceeds limit of ${maxFileMB}MB`,
        { filePath, sizeMB: fileSizeMB, maxMB: maxFileMB }
      );
    }
  } catch (error) {
    if (error instanceof AppError) {
      logger.error('File size check error', { error: error.message, code: error.code, details: (error as any).details });
      throw error;
    }

    logger.error('Failed to check file size', { error, filePath });
    throw new AppError(
      ERROR_CODES.ERR_INTERNAL,
      'Failed to check file size',
      { filePath, originalError: error }
    );
  }
}
