#!/usr/bin/env ts-node
import { Pool } from 'pg';
import { config } from '../src/core/config';
import { logger } from '../src/core/logger';

async function checkTables(): Promise<void> {
  if (!config.DATABASE_URL || config.DATABASE_URL.trim().length === 0) {
    logger.error('DATABASE_URL is not set');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: config.DATABASE_URL,
    min: 1,
    max: 1,
  });

  try {
    const result = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('user_credits', 'payment_transactions', 'credit_usage_log')
      ORDER BY table_name
    `);
    
    const tables = result.rows.map(r => r.table_name);
    if (tables.length === 3) {
      logger.info({ tables }, '✅ Все таблицы платежей созданы');
    } else {
      logger.warn({ found: tables, expected: ['user_credits', 'payment_transactions', 'credit_usage_log'] }, '⚠️ Не все таблицы найдены');
      logger.info('Выполните миграцию: npm run migrate-payments');
    }
  } catch (error: unknown) {
    logger.error({ error }, 'Ошибка проверки таблиц');
  } finally {
    await pool.end();
  }
}

checkTables().then(() => process.exit(0)).catch(() => process.exit(1));

