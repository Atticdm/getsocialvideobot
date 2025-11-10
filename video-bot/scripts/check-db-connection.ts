#!/usr/bin/env ts-node
/**
 * Скрипт для проверки подключения к PostgreSQL
 * 
 * Usage:
 *   DATABASE_URL=postgresql://... ts-node scripts/check-db-connection.ts
 */

import { Pool } from 'pg';
import { config } from '../src/core/config';
import { logger } from '../src/core/logger';

async function checkConnection(): Promise<void> {
  if (!config.DATABASE_URL || config.DATABASE_URL.trim().length === 0) {
    logger.error('DATABASE_URL is not set in environment variables');
    logger.info('Please add DATABASE_URL to your .env file');
    process.exit(1);
  }

  logger.info('Checking PostgreSQL connection...');
  logger.info({ databaseUrl: config.DATABASE_URL.replace(/:[^:@]+@/, ':****@') }, 'Connection string (password hidden)');

  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    min: 1,
    max: 1,
  });

  try {
    // Проверка подключения
    const result = await pool.query('SELECT NOW() as current_time, version() as pg_version');
    logger.info('✅ Successfully connected to PostgreSQL');
    logger.info({ 
      currentTime: result.rows[0].current_time,
      version: result.rows[0].pg_version.split(',')[0].trim()
    }, 'Database info');

    // Проверка существования таблицы
    const tableCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_name = 'cached_files'
      ) as table_exists
    `);

    if (tableCheck.rows[0].table_exists) {
      logger.info('✅ Table cached_files exists');

      // Статистика таблицы
      const stats = await pool.query(`
        SELECT 
          COUNT(*) as total_records,
          COUNT(DISTINCT provider) as unique_providers
        FROM cached_files
      `);
      logger.info({ stats: stats.rows[0] }, 'Table statistics');
    } else {
      logger.warn('⚠️  Table cached_files does not exist');
      logger.info('Please run the migration: psql -d your_db -f migrations/001_create_cached_files_table.sql');
    }

    // Проверка индексов
    const indexes = await pool.query(`
      SELECT indexname 
      FROM pg_indexes 
      WHERE tablename = 'cached_files'
    `);
    
    if (indexes.rows.length > 0) {
      logger.info({ indexes: indexes.rows.map(r => r.indexname) }, 'Indexes found');
    } else {
      logger.warn('⚠️  No indexes found on cached_files table');
    }

    logger.info('✅ All checks passed!');
  } catch (error: unknown) {
    logger.error({ error }, '❌ Failed to connect to PostgreSQL');
    logger.info('Please check:');
    logger.info('  1. DATABASE_URL is correct');
    logger.info('  2. PostgreSQL server is running');
    logger.info('  3. Database exists');
    logger.info('  4. User has proper permissions');
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  checkConnection()
    .then(() => {
      process.exit(0);
    })
    .catch((error) => {
      logger.error({ error }, 'Script failed');
      process.exit(1);
    });
}

export { checkConnection };

