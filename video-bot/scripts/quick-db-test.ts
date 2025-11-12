#!/usr/bin/env ts-node
/**
 * Быстрая проверка подключения к PostgreSQL
 */

import { config } from '../src/core/config';
import { getPool } from '../src/core/dbCache';

async function quickTest(): Promise<void> {
  console.log('🔍 Быстрая проверка подключения...\n');

  if (!config.DATABASE_URL || config.DATABASE_URL.trim().length === 0) {
    console.error('❌ DATABASE_URL не установлен!');
    process.exit(1);
  }

  // Маскируем пароль
  const maskedUrl = config.DATABASE_URL.replace(/:([^:@]+)@/, ':****@');
  console.log(`📝 Используется: ${maskedUrl}`);
  
  // Проверяем тип endpoint
  if (config.DATABASE_URL.includes('railway.internal')) {
    console.log('✅ Используется приватный endpoint (railway.internal)');
  } else if (config.DATABASE_URL.includes('proxy.rlwy.net')) {
    console.log('⚠️  Используется публичный endpoint (proxy.rlwy.net)');
    console.log('   Рекомендуется использовать приватный endpoint для лучшей производительности');
  }

  const pool = getPool();
  
  if (!pool) {
    console.error('\n❌ Не удалось создать пул подключений');
    process.exit(1);
  }

  try {
    console.log('\n🔄 Тестирую подключение...');
    const startTime = Date.now();
    const result = await pool.query('SELECT NOW() as time, version() as version');
    const duration = Date.now() - startTime;
    
    console.log(`✅ Подключение успешно! (${duration}ms)`);
    console.log(`\n📊 Информация:`);
    console.log(`   Время БД: ${result.rows[0].time}`);
    console.log(`   Версия: ${result.rows[0].version.split(',')[0]}`);
    
    // Проверка таблиц
    const tables = await pool.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public'
      ORDER BY table_name
    `);
    
    console.log(`\n📋 Таблицы (${tables.rows.length}):`);
    tables.rows.forEach((row: { table_name: string }) => {
      console.log(`   ✅ ${row.table_name}`);
    });
    
    await pool.end();
    console.log('\n✅ Все проверки пройдены!');
    process.exit(0);
  } catch (error: unknown) {
    console.error('\n❌ Ошибка подключения:');
    if (error instanceof Error) {
      console.error(`   ${error.message}`);
    } else {
      console.error('   Неизвестная ошибка:', error);
    }
    await pool.end();
    process.exit(1);
  }
}

quickTest().catch((error) => {
  console.error('❌ Критическая ошибка:', error);
  process.exit(1);
});

