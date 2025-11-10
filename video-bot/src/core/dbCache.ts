import { Pool } from 'pg';
import { createHash } from 'crypto';
import { config } from './config';
import { logger } from './logger';
import type { CachedFileRecord } from './fileCache';
import { normalizeCacheUrl } from './fileCache';
import { cacheGet, cacheSet, cacheDelete } from './cache';

const FILE_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

let pool: Pool | null = null;
let isDbEnabled = false;

// Prepared statements для производительности
const GET_CACHED_FILE_QUERY = `
  SELECT 
    file_id,
    unique_id,
    type,
    provider,
    duration_seconds,
    size_bytes,
    stored_at
  FROM cached_files
  WHERE url_hash = $1 AND expires_at > NOW()
`;

const UPDATE_LAST_ACCESSED_QUERY = `
  UPDATE cached_files
  SET last_accessed_at = NOW()
  WHERE url_hash = $1
`;

const SET_CACHED_FILE_QUERY = `
  INSERT INTO cached_files (
    url_hash,
    original_url,
    file_id,
    unique_id,
    type,
    provider,
    duration_seconds,
    size_bytes,
    expires_at
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
  ON CONFLICT (url_hash) 
  DO UPDATE SET
    file_id = EXCLUDED.file_id,
    unique_id = EXCLUDED.unique_id,
    type = EXCLUDED.type,
    provider = EXCLUDED.provider,
    duration_seconds = EXCLUDED.duration_seconds,
    size_bytes = EXCLUDED.size_bytes,
    stored_at = NOW(),
    expires_at = EXCLUDED.expires_at,
    last_accessed_at = NOW()
`;

const DELETE_CACHED_FILE_QUERY = `
  DELETE FROM cached_files
  WHERE url_hash = $1
`;

function makeUrlHash(url: string): string {
  const normalized = normalizeCacheUrl(url);
  return createHash('sha256').update(normalized).digest('hex');
}

function initializePool(): Pool | null {
  if (!config.DATABASE_URL || config.DATABASE_URL.trim().length === 0) {
    logger.debug('DATABASE_URL not set, PostgreSQL cache disabled');
    return null;
  }

  try {
    const poolInstance = new Pool({
      connectionString: config.DATABASE_URL,
      min: config.DB_POOL_MIN,
      max: config.DB_POOL_MAX,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    poolInstance.on('error', (error) => {
      logger.error({ error }, 'Unexpected error on idle PostgreSQL client');
    });

    poolInstance.on('connect', () => {
      logger.info('PostgreSQL pool connected');
    });

    isDbEnabled = true;
    logger.info('PostgreSQL cache pool initialized', {
      min: config.DB_POOL_MIN,
      max: config.DB_POOL_MAX,
    });

    return poolInstance;
  } catch (error: unknown) {
    logger.error({ error }, 'Failed to initialize PostgreSQL pool, falling back to Redis');
    return null;
  }
}

function getPool(): Pool | null {
  if (!pool && isDbEnabled) {
    pool = initializePool();
  }
  return pool;
}

// Graceful shutdown
export async function closeDbPool(): Promise<void> {
  if (pool) {
    try {
      await pool.end();
      logger.info('PostgreSQL pool closed');
    } catch (error) {
      logger.error({ error }, 'Error closing PostgreSQL pool');
    } finally {
      pool = null;
      isDbEnabled = false;
    }
  }
}

function dbRecordToCachedFileRecord(row: {
  file_id: string;
  unique_id: string | null;
  type: string;
  provider: string | null;
  duration_seconds: number | null;
  size_bytes: string | number | null;
  stored_at: Date | string | null;
}): CachedFileRecord {
  const record: CachedFileRecord = {
    fileId: row.file_id,
    uniqueId: row.unique_id || '',
    type: row.type as 'document' | 'video',
    storedAt: row.stored_at ? new Date(row.stored_at).getTime() : Date.now(),
  };

  if (row.provider) {
    record.provider = row.provider;
  }
  if (row.duration_seconds !== null && row.duration_seconds !== undefined) {
    record.durationSeconds = row.duration_seconds;
  }
  if (row.size_bytes !== null && row.size_bytes !== undefined) {
    record.sizeBytes = typeof row.size_bytes === 'number' ? row.size_bytes : Number(row.size_bytes);
  }

  return record;
}

export async function getCachedFile(url: string): Promise<CachedFileRecord | null> {
  const urlHash = makeUrlHash(url);
  const dbPool = getPool();

  // Попытка получить из PostgreSQL
  if (dbPool) {
    try {
      const startTime = Date.now();
      const result = await dbPool.query(GET_CACHED_FILE_QUERY, [urlHash]);

      if (result.rows.length > 0) {
        const record = dbRecordToCachedFileRecord(result.rows[0]);
        const duration = Date.now() - startTime;

        // Обновляем last_accessed_at асинхронно (не блокируем ответ)
        dbPool.query(UPDATE_LAST_ACCESSED_QUERY, [urlHash]).catch((error: unknown) => {
          logger.warn({ error, urlHash }, 'Failed to update last_accessed_at');
        });

        logger.debug({ urlHash, duration }, 'Cache hit from PostgreSQL');
        return record;
      }

      const duration = Date.now() - startTime;
      logger.debug({ urlHash, duration }, 'Cache miss in PostgreSQL');
    } catch (error) {
      logger.warn({ error, urlHash }, 'Failed to get cached file from PostgreSQL, falling back to Redis');
    }
  }

  // Fallback на Redis/in-memory
  try {
    const cacheKey = `file-cache:${urlHash}`;
    const raw = await cacheGet(cacheKey);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as CachedFileRecord | null;
    if (!parsed || !parsed.fileId) return null;

    logger.debug({ urlHash }, 'Cache hit from Redis fallback');
    return parsed;
  } catch (error) {
    logger.warn({ error, urlHash }, 'Failed to load cached file record from fallback');
    return null;
  }
}

export async function setCachedFile(url: string, record: CachedFileRecord): Promise<void> {
  const urlHash = makeUrlHash(url);
  const normalizedUrl = normalizeCacheUrl(url);
  const expiresAt = new Date(Date.now() + FILE_CACHE_TTL_SECONDS * 1000);

  const dbPool = getPool();

  // Запись в PostgreSQL (dual-write)
  if (dbPool) {
    try {
      await dbPool.query(SET_CACHED_FILE_QUERY, [
        urlHash,
        normalizedUrl,
        record.fileId,
        record.uniqueId || null,
        record.type,
        record.provider || null,
        record.durationSeconds || null,
        record.sizeBytes || null,
        expiresAt,
      ]);

      logger.debug({ urlHash }, 'Cached file saved to PostgreSQL');
    } catch (error) {
      // Ошибки БД не должны блокировать запись в Redis
      logger.warn({ error, urlHash }, 'Failed to save cached file to PostgreSQL, continuing with Redis');
    }
  }

  // Всегда записываем в Redis для обратной совместимости и fallback
  try {
    const cacheKey = `file-cache:${urlHash}`;
    await cacheSet(cacheKey, JSON.stringify(record), FILE_CACHE_TTL_SECONDS);
  } catch (error) {
    logger.warn({ error, urlHash }, 'Failed to save cached file to Redis');
  }
}

export async function deleteCachedFile(url: string): Promise<void> {
  const urlHash = makeUrlHash(url);
  const dbPool = getPool();

  // Удаление из PostgreSQL
  if (dbPool) {
    try {
      await dbPool.query(DELETE_CACHED_FILE_QUERY, [urlHash]);
      logger.debug({ urlHash }, 'Cached file deleted from PostgreSQL');
    } catch (error) {
      logger.warn({ error, urlHash }, 'Failed to delete cached file from PostgreSQL');
    }
  }

  // Удаление из Redis
  try {
    const cacheKey = `file-cache:${urlHash}`;
    await cacheDelete(cacheKey);
  } catch (error) {
    logger.warn({ error, urlHash }, 'Failed to delete cached file from Redis');
  }
}

