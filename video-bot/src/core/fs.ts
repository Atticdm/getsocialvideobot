import * as fs from 'fs-extra';
import * as path from 'path';
import { config } from './config';
import { logger } from './logger';
import { run } from './exec';

export async function ensureTempDir(): Promise<void> {
  try {
    await fs.ensureDir(config.DOWNLOAD_DIR);
    logger.debug('Temporary directory ensured', { dir: config.DOWNLOAD_DIR });
  } catch (error) {
    logger.error('Failed to ensure temporary directory', { error, dir: config.DOWNLOAD_DIR });
    throw error;
  }
}

export async function makeSessionDir(): Promise<string> {
  const sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  const sessionDir = path.join(config.DOWNLOAD_DIR, sessionId);
  
  try {
    await fs.ensureDir(sessionDir);
    logger.debug('Session directory created', { sessionDir });
    return sessionDir;
  } catch (error) {
    logger.error('Failed to create session directory', { error, sessionDir });
    throw error;
  }
}

export async function safeRemove(pathToRemove: string): Promise<void> {
  try {
    const exists = await fs.pathExists(pathToRemove);
    if (exists) {
      await fs.remove(pathToRemove);
      logger.debug('Path removed successfully', { path: pathToRemove });
    }
  } catch (error) {
    logger.error('Failed to remove path', { error, path: pathToRemove });
    // Don't throw - this is a cleanup operation
  }
}

export async function getFreeDiskSpace(): Promise<number> {
  try {
    // Try to read free space using portable `df` (POSIX). Parse available KB from output.
    const result = await run('df', ['-kP', '.']);
    if (result.code === 0) {
      const lines = result.stdout.trim().split('\n');
      // Expect header + one line for current filesystem
      const dataLine = lines[lines.length - 1] || '';
      const parts = dataLine.split(/\s+/);
      // POSIX df -kP columns: Filesystem 1024-blocks Used Available Capacity Mounted on
      const availableKB = Number(parts[3]);
      if (!Number.isNaN(availableKB)) {
        return availableKB * 1024; // bytes
      }
    }
    logger.warn('df parsing failed, falling back to 0', { stdout: result.stdout, stderr: result.stderr });
    return 0;
  } catch (error) {
    logger.error('Failed to get disk space', { error });
    return 0;
  }
}
