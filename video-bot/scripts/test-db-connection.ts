#!/usr/bin/env ts-node
/**
 * Скрипт для проверки подключения к PostgreSQL
 * Использование: npm run test-db или ts-node scripts/test-db-connection.ts
 */

import { config } from '../src/core/config';
import { getPool } from '../src/core/dbCache';
import { logger } from '../src/core/logger';

async function testConnection(): Promise<void> {
  console.log('🔍 Проверка подключения к PostgreSQL...\n');

  // Проверка наличия DATABASE_URL
  if (!config.DATABASE_URL || config.DATABASE_URL.trim().length === 0) {
    console.error('❌ DATABASE_URL не установлен!');
    console.log('\n💡 Установите переменную окружения DATABASE_URL:');
    console.log('   export DATABASE_URL="postgresql://user:password@host:port/database"');
    process.exit(1);
  }

  // Маскируем пароль в URL для вывода
  const maskedUrl = config.DATABASE_URL.replace(/:([^:@]+)@/, ':****@');
  console.log(`📝 DATABASE_URL: ${maskedUrl}`);
  console.log(`⚙️  DB_POOL_MIN: ${config.DB_POOL_MIN}`);
  console.log(`⚙️  DB_POOL_MAX: ${config.DB_POOL_MAX}\n`);

  // Получаем пул
  const pool = getPool();
  
  if (!pool) {
    console.error('❌ Не удалось создать пул подключений к PostgreSQL');
    console.log('\n💡 Возможные причины:');
    console.log('   1. DATABASE_URL указан неверно');
    console.log('   2. PostgreSQL сервер недоступен');
    console.log('   3. Неверные учетные данные');
    process.exit(1);
  }

  try {
    // Тест простого запроса
    console.log('🔄 Выполняю тестовый запрос...');
    const result = await pool.query('SELECT NOW() as current_time, version() as pg_version');
    
    console.log('✅ Подключение успешно!');
    console.log(`\n📊 Информация о БД:`);
    console.log(`   Текущее время БД: ${result.rows[0].current_time}`);
    console.log(`   Версия PostgreSQL: ${result.rows[0].pg_version.split(',')[0]}`);

    // Проверка существования таблиц для платежей
    console.log('\n🔍 Проверка таблиц для платежей...');
    const tablesCheck = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('user_credits', 'payment_transactions', 'credit_usage_log', 'cached_files')
      ORDER BY table_name
    `);

    const existingTables = tablesCheck.rows.map((row: { table_name: string }) => row.table_name);
    const requiredTables = ['user_credits', 'payment_transactions', 'credit_usage_log', 'cached_files'];
    
    console.log(`   Найдено таблиц: ${existingTables.length} из ${requiredTables.length}`);
    
    requiredTables.forEach((table) => {
      if (existingTables.includes(table)) {
        console.log(`   ✅ ${table}`);
      } else {
        console.log(`   ❌ ${table} - отсутствует!`);
      }
    });

    if (existingTables.length < requiredTables.length) {
      console.log('\n⚠️  Некоторые таблицы отсутствуют. Запустите миграции:');
      console.log('   npm run migrate-db');
    }

    // Проверка статистики пула
    const poolStats = {
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
    };
    
    console.log(`\n📈 Статистика пула подключений:`);
    console.log(`   Всего подключений: ${poolStats.totalCount}`);
    console.log(`   Свободных: ${poolStats.idleCount}`);
    console.log(`   Ожидающих: ${poolStats.waitingCount}`);

    console.log('\n✅ Все проверки пройдены успешно!');
    
    await pool.end();
    process.exit(0);
  } catch (error: unknown) {
    console.error('\n❌ Ошибка при выполнении запроса:');
    if (error instanceof Error) {
      console.error(`   ${error.message}`);
      if (error.stack) {
        console.error(`\n   Stack trace:\n${error.stack}`);
      }
    } else {
      console.error('   Неизвестная ошибка:', error);
    }
    
    await pool.end();
    process.exit(1);
  }
}

// Запуск проверки
testConnection().catch((error) => {
  logger.error({ error }, 'Unhandled error in test-db-connection');
  console.error('❌ Критическая ошибка:', error);
  process.exit(1);
});

