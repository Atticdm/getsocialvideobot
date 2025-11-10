import { createHash } from 'crypto';
import { cacheDelete, cacheGet, cacheSet } from './cache';
import { logger } from './logger';
import { config } from './config';

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

// Lazy import для dbCache чтобы не блокировать инициализацию если БД недоступна
let dbCacheModule: typeof import('./dbCache') | null = null;

async function getDbCacheModule(): Promise<typeof import('./dbCache') | null> {
  if (!config.DATABASE_URL || config.DATABASE_URL.trim().length === 0) {
    return null;
  }

  if (!dbCacheModule) {
    try {
      dbCacheModule = await import('./dbCache');
    } catch (error) {
      logger.warn({ error }, 'Failed to load dbCache module, using Redis fallback');
      return null;
    }
  }

  return dbCacheModule;
}

export async function getCachedFile(url: string): Promise<CachedFileRecord | null> {
  // Если DATABASE_URL задан, используем PostgreSQL с fallback на Redis
  const dbCache = await getDbCacheModule();
  if (dbCache) {
    try {
      const result = await dbCache.getCachedFile(url);
      if (result) {
        return result;
      }
      // Если в БД нет, fallback на Redis уже выполнен внутри dbCache.getCachedFile
      return null;
    } catch (error) {
      logger.warn({ error, url }, 'Failed to get cached file from dbCache, falling back to Redis');
      // Продолжаем с Redis fallback ниже
    }
  }

  // Fallback на Redis/in-memory (оригинальная логика)
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
  // Если DATABASE_URL задан, используем dual-write (PostgreSQL + Redis)
  const dbCache = await getDbCacheModule();
  if (dbCache) {
    try {
      await dbCache.setCachedFile(url, record);
      // dbCache.setCachedFile уже записывает в оба места (PostgreSQL и Redis)
      return;
    } catch (error) {
      logger.warn({ error, url }, 'Failed to set cached file via dbCache, falling back to Redis');
      // Продолжаем с Redis fallback ниже
    }
  }

  // Fallback на Redis/in-memory (оригинальная логика)
  try {
    await cacheSet(makeKey(url), JSON.stringify(record), FILE_CACHE_TTL_SECONDS);
  } catch (error) {
    logger.warn({ error, url }, 'Failed to persist cached file record');
  }
}

export async function deleteCachedFile(url: string): Promise<void> {
  // Если DATABASE_URL задан, удаляем из обоих мест
  const dbCache = await getDbCacheModule();
  if (dbCache) {
    try {
      await dbCache.deleteCachedFile(url);
      // dbCache.deleteCachedFile уже удаляет из обоих мест
      return;
    } catch (error) {
      logger.warn({ error, url }, 'Failed to delete cached file via dbCache, falling back to Redis');
      // Продолжаем с Redis fallback ниже
    }
  }

  // Fallback на Redis/in-memory (оригинальная логика)
  try {
    await cacheDelete(makeKey(url));
  } catch (error) {
    logger.warn({ error, url }, 'Failed to delete cached file record');
  }
}

export function normalizeCacheUrl(url: string): string {
  return normalizeUrl(url);
}
