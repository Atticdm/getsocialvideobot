import { createHash } from 'crypto';
import { cacheDelete, cacheGet, cacheSet } from './cache';
import { logger } from './logger';

export type CachedFileType = 'document' | 'video';

export interface CachedFileRecord {
  fileId: string;
  uniqueId: string;
  type: CachedFileType;
  provider?: string;
  durationSeconds?: number;
  sizeBytes?: number;
  storedAt: number;
}

const FILE_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function normalizeUrl(url: string): string {
  return url.trim();
}

function makeKey(url: string): string {
  const normalized = normalizeUrl(url);
  const hash = createHash('sha256').update(normalized).digest('hex');
  return `file-cache:${hash}`;
}

export async function getCachedFile(url: string): Promise<CachedFileRecord | null> {
  try {
    const raw = await cacheGet(makeKey(url));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedFileRecord | null;
    if (!parsed || !parsed.fileId) return null;
    return parsed;
  } catch (error) {
    logger.warn({ error, url }, 'Failed to load cached file record');
    return null;
  }
}

export async function setCachedFile(url: string, record: CachedFileRecord): Promise<void> {
  try {
    await cacheSet(makeKey(url), JSON.stringify(record), FILE_CACHE_TTL_SECONDS);
  } catch (error) {
    logger.warn({ error, url }, 'Failed to persist cached file record');
  }
}

export async function deleteCachedFile(url: string): Promise<void> {
  try {
    await cacheDelete(makeKey(url));
  } catch (error) {
    logger.warn({ error, url }, 'Failed to delete cached file record');
  }
}

export function normalizeCacheUrl(url: string): string {
  return normalizeUrl(url);
}
