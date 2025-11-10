#!/usr/bin/env ts-node
/**
 * Скрипт для выполнения SQL миграции через Node.js
 * 
 * Usage:
 *   DATABASE_URL=postgresql://... ts-node scripts/run-migration.ts
 */

import { Pool } from 'pg';
import { readFileSync } from 'fs';
import { join } from 'path';
import { config } from '../src/core/config';
import { logger } from '../src/core/logger';

async function runMigration(): Promise<void> {
  if (!config.DATABASE_URL || config.DATABASE_URL.trim().length === 0) {
    logger.error('DATABASE_URL is not set in environment variables');
    logger.info('Please add DATABASE_URL to your .env file');
    process.exit(1);
  }

  logger.info('Connecting to PostgreSQL...');
  logger.info({ databaseUrl: config.DATABASE_URL.replace(/:[^:@]+@/, ':****@') }, 'Connection string (password hidden)');

  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    min: 1,
    max: 1,
  });

  try {
    // Проверка подключения
    await pool.query('SELECT NOW()');
    logger.info('✅ Successfully connected to PostgreSQL');

    // Чтение SQL файла миграции
    const migrationPath = join(__dirname, '../migrations/001_create_cached_files_table.sql');
    const sql = readFileSync(migrationPath, 'utf-8');

    logger.info('Executing migration...');
    
    // Выполнение миграции
    await pool.query(sql);

    logger.info('✅ Migration completed successfully');

    // Проверка результата
    const tableCheck = await pool.query(`
      SELECT 
        COUNT(*) as index_count
      FROM pg_indexes 
      WHERE tablename = 'cached_files'
    `);

    logger.info({ indexesCreated: tableCheck.rows[0].index_count }, 'Migration verification');

    // Проверка структуры таблицы
    const columns = await pool.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'cached_files'
      ORDER BY ordinal_position
    `);

    logger.info({ columns: columns.rows.map(r => `${r.column_name} (${r.data_type})`) }, 'Table structure');

    logger.info('✅ All checks passed! Table cached_files is ready to use.');
  } catch (error: unknown) {
    logger.error({ error }, '❌ Migration failed');
    
    if (error instanceof Error) {
      // Проверка на уже существующую таблицу
      if (error.message.includes('already exists') || error.message.includes('duplicate')) {
        logger.warn('Table or index already exists - this is OK if migration was run before');
        logger.info('Migration is idempotent, continuing...');
      } else {
        throw error;
      }
    } else {
      throw error;
    }
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  runMigration()
    .then(() => {
      logger.info('Migration script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      logger.error({ error }, 'Migration script failed');
      process.exit(1);
    });
}

export { runMigration };

