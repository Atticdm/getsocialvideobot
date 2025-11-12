#!/usr/bin/env ts-node
/**
 * Скрипт для проверки существования таблиц промокодов
 * Использование: npm run check-promo-tables или ts-node scripts/check-promo-tables.ts
 */

import { config } from '../src/core/config';
import { getPool } from '../src/core/dbCache';
import { logger } from '../src/core/logger';

async function checkPromoTables(): Promise<void> {
  console.log('🔍 Проверка таблиц промокодов...\n');

  // Проверка наличия DATABASE_URL
  if (!config.DATABASE_URL || config.DATABASE_URL.trim().length === 0) {
    console.error('❌ DATABASE_URL не установлен!');
    console.log('\n💡 Установите переменную окружения DATABASE_URL:');
    console.log('   export DATABASE_URL="postgresql://user:password@host:port/database"');
    process.exit(1);
  }

  // Маскируем пароль в URL для вывода
  const maskedUrl = config.DATABASE_URL.replace(/:([^:@]+)@/, ':****@');
  console.log(`📝 DATABASE_URL: ${maskedUrl}\n`);

  // Получаем пул
  const pool = getPool();
  
  if (!pool) {
    console.error('❌ Не удалось создать пул подключений к PostgreSQL');
    process.exit(1);
  }

  try {
    // Проверка подключения
    console.log('🔄 Проверяю подключение...');
    await pool.query('SELECT NOW()');
    console.log('✅ Подключение успешно!\n');

    // Проверка таблиц
    const requiredTables = ['promo_codes', 'promo_code_usage', 'user_promo_status'];
    
    console.log('📋 Проверка таблиц:');
    for (const tableName of requiredTables) {
      const result = await pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = $1
        ) as exists
      `, [tableName]);
      
      if (result.rows[0]?.exists) {
        console.log(`   ✅ ${tableName}`);
        
        // Проверяем количество записей
        const countResult = await pool.query(`SELECT COUNT(*) as count FROM ${tableName}`);
        const count = countResult.rows[0]?.count || 0;
        console.log(`      Записей: ${count}`);
      } else {
        console.log(`   ❌ ${tableName} - отсутствует!`);
      }
    }

    // Проверка промокода GODMODE
    console.log('\n🎁 Проверка промокода GODMODE:');
    const promoCheck = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'promo_codes'
      ) as exists
    `);
    
    if (promoCheck.rows[0]?.exists) {
      const godmodeCheck = await pool.query(`
        SELECT code, type, max_uses, used_count, expires_at, description
        FROM promo_codes
        WHERE code = 'GODMODE'
      `);
      
      if (godmodeCheck.rows.length > 0) {
        const promo = godmodeCheck.rows[0];
        console.log(`   ✅ Промокод GODMODE найден`);
        console.log(`      Тип: ${promo.type}`);
        console.log(`      Использований: ${promo.used_count}`);
        console.log(`      Максимум: ${promo.max_uses === null ? 'безлимит' : promo.max_uses}`);
        console.log(`      Срок действия: ${promo.expires_at === null ? 'без срока' : promo.expires_at}`);
      } else {
        console.log(`   ⚠️  Промокод GODMODE не найден в таблице`);
        console.log(`   💡 Выполните миграцию: npm run migrate-promo`);
      }
    } else {
      console.log(`   ❌ Таблица promo_codes не существует`);
      console.log(`   💡 Выполните миграцию: npm run migrate-promo`);
    }

    console.log('\n✅ Проверка завершена!');
    
    await pool.end();
    process.exit(0);
  } catch (error: unknown) {
    console.error('\n❌ Ошибка при проверке:');
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
checkPromoTables().catch((error) => {
  logger.error({ error }, 'Unhandled error in check-promo-tables');
  console.error('❌ Критическая ошибка:', error);
  process.exit(1);
});

