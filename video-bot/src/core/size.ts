import * as fs from 'fs-extra';
import { ERROR_CODES, AppError } from './errors';
import { config } from './config';
import { logger } from './logger';

export function bytesToMB(bytes: number): number {
  return bytes / (1024 * 1024);
}

export async function ensureBelowLimit(filePath: string, maxFileMB: number = config.MAX_FILE_MB): Promise<void> {
  try {
    logger.debug('Checking file existence', { filePath });
    const exists = await fs.pathExists(filePath);
    if (!exists) {
      throw new AppError(ERROR_CODES.ERR_FILE_NOT_FOUND, 'File not found for size check', { filePath });
    }
    logger.debug('File exists, getting stats', { filePath });
    const stats = await fs.stat(filePath);
    const fileSizeMB = bytesToMB(stats.size);
    
    logger.debug('File size check successful', { 
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
      logger.error('AppError during size check', { code: error.code, message: error.message, details: error.details });
      throw error;
    }
    
    const err = error as Error;
    logger.error('Generic error during size check', { error: err.message, name: err.name, stack: err.stack, filePath });
    throw new AppError(
      ERROR_CODES.ERR_INTERNAL,
      'Failed to check file size',
      { filePath, originalError: err.message }
    );
  }
}