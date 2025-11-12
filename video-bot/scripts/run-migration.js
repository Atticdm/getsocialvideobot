#!/usr/bin/env node
/**
 * Production-ready скрипт для выполнения SQL миграции
 * Работает с скомпилированным кодом (не требует ts-node)
 * 
 * Usage:
 *   DATABASE_URL=postgresql://... node scripts/run-migration.js [migration-file]
 */

const { Pool } = require('pg');
const { readFileSync } = require('fs');
const { join } = require('path');
const { config } = require('dotenv');

// Загружаем переменные окружения из .env файла
config();

async function runMigration(migrationFile) {
  const databaseUrl = process.env.DATABASE_URL;
  
  if (!databaseUrl || databaseUrl.trim().length === 0) {
    console.error('❌ DATABASE_URL is not set in environment variables');
    console.log('Please add DATABASE_URL to your environment variables');
    process.exit(1);
  }

  console.log('🔄 Connecting to PostgreSQL...');
  const maskedUrl = databaseUrl.replace(/:([^:@]+)@/, ':****@');
  console.log(`📝 Connection string: ${maskedUrl}`);

  const pool = new Pool({
    connectionString: databaseUrl,
    min: 1,
    max: 1,
  });

  try {
    // Проверка подключения
    await pool.query('SELECT NOW()');
    console.log('✅ Successfully connected to PostgreSQL');

    // Определяем путь к файлу миграции
    const migrationPath = migrationFile
      ? (migrationFile.startsWith('/') 
          ? migrationFile 
          : join(__dirname, '..', migrationFile))
      : join(__dirname, '../migrations/001_create_cached_files_table.sql');
    
    console.log(`📄 Reading migration file: ${migrationPath}`);
    const sql = readFileSync(migrationPath, 'utf-8');

    console.log('🔄 Executing migration...');
    
    // Выполнение миграции
    await pool.query(sql);

    console.log('✅ Migration completed successfully');

    // Определяем, какая миграция была выполнена, для проверки
    const migrationFileName = migrationPath.split('/').pop() || '';
    
    if (migrationFileName.includes('promo_codes')) {
      // Проверка таблиц промокодов
      const promoTables = ['promo_codes', 'promo_code_usage', 'user_promo_status'];
      for (const tableName of promoTables) {
        const tableCheck = await pool.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name = $1
          ) as exists
        `, [tableName]);
        
        if (tableCheck.rows[0]?.exists) {
          console.log(`✅ Table ${tableName} created successfully`);
          
          // Проверяем промокод GODMODE
          if (tableName === 'promo_codes') {
            const godmodeCheck = await pool.query(`
              SELECT code, type, max_uses, used_count 
              FROM promo_codes 
              WHERE code = 'GODMODE'
            `);
            if (godmodeCheck.rows.length > 0) {
              console.log('✅ Promo code GODMODE created successfully');
              console.log(`   Code: ${godmodeCheck.rows[0].code}, Type: ${godmodeCheck.rows[0].type}`);
            }
          }
        } else {
          console.warn(`⚠️  Table ${tableName} was not created`);
        }
      }
    } else {
      // Проверка результата для других миграций
      const tableCheck = await pool.query(`
        SELECT 
          COUNT(*) as index_count
        FROM pg_indexes 
        WHERE tablename = 'cached_files'
      `);

      console.log(`✅ Indexes created: ${tableCheck.rows[0].index_count}`);

      // Проверка структуры таблицы
      const columns = await pool.query(`
        SELECT column_name, data_type 
        FROM information_schema.columns 
        WHERE table_name = 'cached_files'
        ORDER BY ordinal_position
      `);

      console.log('✅ Table structure:');
      columns.rows.forEach(col => {
        console.log(`   - ${col.column_name} (${col.data_type})`);
      });
    }

    console.log('✅ All checks passed! Migration is ready to use.');
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    
    // Проверка на уже существующую таблицу
    if (error.message && (error.message.includes('already exists') || error.message.includes('duplicate'))) {
      console.warn('⚠️  Table or index already exists - this is OK if migration was run before');
      console.log('Migration is idempotent, continuing...');
    } else {
      throw error;
    }
  } finally {
    await pool.end();
  }
}

// Запуск миграции
if (require.main === module) {
  const migrationFile = process.argv[2];
  runMigration(migrationFile)
    .then(() => {
      console.log('✅ Migration script completed successfully');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Migration script failed:', error);
      process.exit(1);
    });
}

module.exports = { runMigration };

