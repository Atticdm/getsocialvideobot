#!/usr/bin/env ts-node
/**
 * Migration script: Migrate cached file records from Redis to PostgreSQL
 * 
 * This script reads all file-cache:* keys from Redis and migrates them to PostgreSQL.
 * It is idempotent - can be run multiple times safely.
 * 
 * Usage:
 *   DATABASE_URL=postgresql://... REDIS_URL=redis://... npm run migrate-cache
 *   or
 *   ts-node scripts/migrate-cache-to-db.ts
 */

import Redis from 'ioredis';
import { Pool } from 'pg';
import { createHash } from 'crypto';
import { config } from '../src/core/config';
import { logger } from '../src/core/logger';
import type { CachedFileRecord } from '../src/core/fileCache';

const FILE_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function normalizeUrl(url: string): string {
  return url.trim();
}

function makeUrlHash(url: string): string {
  const normalized = normalizeUrl(url);
  return createHash('sha256').update(normalized).digest('hex');
}

async function migrateCache(): Promise<void> {
  // Проверка конфигурации
  if (!config.DATABASE_URL || config.DATABASE_URL.trim().length === 0) {
    logger.error('DATABASE_URL is not set. Please set it in environment variables.');
    process.exit(1);
  }

  if (!config.REDIS_URL || config.REDIS_URL.trim().length === 0) {
    logger.error('REDIS_URL is not set. Please set it in environment variables.');
    process.exit(1);
  }

  // Инициализация PostgreSQL
  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    min: 1,
    max: 5,
  });

  // Инициализация Redis
  const redis = new Redis(config.REDIS_URL, {
    lazyConnect: true,
  });

  try {
    await redis.connect();
    logger.info('Connected to Redis');

    // Проверка подключения к PostgreSQL
    await pool.query('SELECT 1');
    logger.info('Connected to PostgreSQL');

    // Проверка существования таблицы
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'cached_files'
      )
    `);

    if (!tableCheck.rows[0].exists) {
      logger.error('Table cached_files does not exist. Please run the migration SQL first.');
      logger.error('See: migrations/001_create_cached_files_table.sql');
      process.exit(1);
    }

    // Поиск всех ключей file-cache:*
    const cachePrefix = config.CACHE_PREFIX || 'yeet:';
    const pattern = `${cachePrefix}file-cache:*`;
    logger.info({ pattern }, 'Scanning Redis for cache keys...');

    let cursor = '0';
    let totalKeys = 0;
    let processedKeys = 0;
    let migratedKeys = 0;
    let skippedKeys = 0;
    let errorKeys = 0;

    const batchSize = 100;
    const insertQuery = `
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
        expires_at = EXCLUDED.expires_at
    `;

    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', batchSize);
      cursor = nextCursor;

      if (keys.length === 0) {
        continue;
      }

      totalKeys += keys.length;
      logger.info({ cursor, batchSize: keys.length, totalKeys }, 'Processing batch...');

      // Получаем значения для всех ключей в батче
      const values = await redis.mget(...keys);

      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const value = values[i];

        if (!value) {
          skippedKeys++;
          continue;
        }

        try {
          // Парсим JSON
          const record = JSON.parse(value) as CachedFileRecord;
          if (!record.fileId) {
            skippedKeys++;
            logger.debug({ key }, 'Skipping record without fileId');
            continue;
          }

          // Извлекаем оригинальный URL из ключа (если возможно) или используем placeholder
          // К сожалению, мы не можем восстановить оригинальный URL из хеша
          // Но можем использовать хеш как идентификатор
          const urlHash = key.replace(`${cachePrefix}file-cache:`, '');
          const originalUrl = `migrated:${urlHash}`; // Placeholder, так как оригинальный URL недоступен

          // Вычисляем expires_at
          const storedAt = record.storedAt || Date.now();
          const expiresAt = new Date(storedAt + FILE_CACHE_TTL_SECONDS * 1000);

          // Вставляем в PostgreSQL
          await pool.query(insertQuery, [
            urlHash,
            originalUrl,
            record.fileId,
            record.uniqueId || null,
            record.type,
            record.provider || null,
            record.durationSeconds || null,
            record.sizeBytes || null,
            expiresAt,
          ]);

          migratedKeys++;
          processedKeys++;

          if (processedKeys % 100 === 0) {
            logger.info(
              { processedKeys, migratedKeys, skippedKeys, errorKeys },
              'Migration progress'
            );
          }
        } catch (error) {
          errorKeys++;
          logger.warn({ error, key }, 'Failed to migrate cache entry');
        }
      }
    } while (cursor !== '0');

    logger.info(
      {
        totalKeys,
        processedKeys,
        migratedKeys,
        skippedKeys,
        errorKeys,
      },
      'Migration completed'
    );

    // Статистика из PostgreSQL
    const stats = await pool.query(`
      SELECT 
        COUNT(*) as total_records,
        COUNT(DISTINCT provider) as unique_providers,
        SUM(size_bytes) as total_size_bytes
      FROM cached_files
    `);

    logger.info({ stats: stats.rows[0] }, 'PostgreSQL cache statistics');
  } catch (error) {
    logger.error({ error }, 'Migration failed');
    throw error;
  } finally {
    await redis.quit();
    await pool.end();
    logger.info('Connections closed');
  }
}

// Запуск миграции
if (require.main === module) {
  migrateCache()
    .then(() => {
      logger.info('Migration script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      logger.error({ error }, 'Migration script failed');
      process.exit(1);
    });
}

export { migrateCache };

