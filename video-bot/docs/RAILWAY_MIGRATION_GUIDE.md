# Выполнение миграции промокодов на Railway

## Проблема: Railway CLI не установлен

Если Railway CLI не установлен, есть несколько способов выполнить миграцию:

## Способ 1: Установить Railway CLI (Рекомендуется)

```bash
# Установка Railway CLI
npm install -g @railway/cli

# Логин в Railway
railway login

# Перейти в директорию проекта
cd /Users/attic/getsocialvideobot/video-bot

# Выполнить миграцию
railway run npm run migrate-promo
```

## Способ 2: Через Railway Web Console (Без CLI)

1. Откройте Railway Dashboard: https://railway.app
2. Выберите ваш проект `getsocialvideobot`
3. Выберите сервис (production)
4. Перейдите в раздел **"Deployments"**
5. Найдите активный deployment и нажмите на него
6. Откройте вкладку **"Shell"** или **"Console"**
7. Выполните команды:

```bash
cd video-bot
npm run migrate-promo
```

## Способ 3: Выполнить миграцию локально (если есть DATABASE_URL)

Если у вас есть `DATABASE_URL` из Railway, можно выполнить миграцию локально:

```bash
cd /Users/attic/getsocialvideobot/video-bot

# Установите DATABASE_URL из Railway
export DATABASE_URL="postgresql://user:password@host:port/database"

# Выполните миграцию
node scripts/run-migration.js migrations/003_create_promo_codes_tables.sql
```

**Как получить DATABASE_URL из Railway:**
1. Railway Dashboard → ваш проект → **Variables**
2. Найдите переменную `DATABASE_URL`
3. Скопируйте значение (или используйте Railway CLI: `railway variables`)

## Способ 4: Добавить миграцию в start скрипт (временно)

Можно временно добавить проверку и выполнение миграции при старте приложения:

```javascript
// В src/bot/index.ts или где запускается бот
import { execSync } from 'child_process';

// Проверяем наличие таблиц и выполняем миграцию если нужно
try {
  execSync('node scripts/run-migration.js migrations/003_create_promo_codes_tables.sql', {
    stdio: 'inherit',
    env: process.env
  });
} catch (error) {
  console.warn('Migration check failed (this is OK if tables already exist):', error);
}
```

⚠️ **Не рекомендуется для production**, но может помочь в экстренных случаях.

## Проверка результата

После выполнения миграции проверьте:

```bash
# Через Railway CLI
railway run npm run check-promo-tables

# Или локально (если DATABASE_URL установлен)
node -e "
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query(\"SELECT code FROM promo_codes WHERE code = 'GODMODE'\")
  .then(r => { console.log('✅ GODMODE found:', r.rows); pool.end(); })
  .catch(e => { console.error('❌ Error:', e.message); process.exit(1); });
"
```

## Рекомендация

**Лучший способ:** Использовать Railway Web Console (Способ 2) - это самый простой и надежный метод без необходимости установки CLI.

