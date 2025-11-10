# PostgreSQL Cache Migration Guide

Этот документ описывает миграцию системы кеширования file_id из Redis/in-memory на PostgreSQL.

## Обзор

Система кеширования была расширена для поддержки PostgreSQL в качестве основного хранилища кеша, с автоматическим fallback на Redis/in-memory при недоступности БД.

## Преимущества PostgreSQL кеша

- **Надежность**: Персистентное хранение данных
- **Аналитика**: Возможность запросов и статистики по использованию кеша
- **Масштабируемость**: Лучшая производительность при больших объемах данных
- **Индексы**: Быстрый поиск по URL хешу и другим полям

## Установка и настройка

### 1. Установка зависимостей

Зависимости уже добавлены в `package.json`:
- `pg` - PostgreSQL клиент для Node.js
- `@types/pg` - TypeScript типы

Установите зависимости:
```bash
npm install
```

### 2. Настройка PostgreSQL

Создайте базу данных PostgreSQL:
```bash
createdb video_bot_cache
```

Или используйте существующую базу данных.

### 3. Выполнение миграции

Примените SQL миграцию для создания таблицы:
```bash
psql -d video_bot_cache -f migrations/001_create_cached_files_table.sql
```

Или выполните SQL вручную:
```sql
CREATE TABLE IF NOT EXISTS cached_files (
  id SERIAL PRIMARY KEY,
  url_hash VARCHAR(64) UNIQUE NOT NULL,
  original_url TEXT NOT NULL,
  file_id VARCHAR(255) NOT NULL,
  unique_id VARCHAR(255),
  type VARCHAR(20) NOT NULL CHECK (type IN ('document', 'video')),
  provider VARCHAR(50),
  duration_seconds INTEGER,
  size_bytes BIGINT,
  stored_at TIMESTAMP DEFAULT NOW() NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  last_accessed_at TIMESTAMP DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cached_files_url_hash ON cached_files(url_hash);
CREATE INDEX IF NOT EXISTS idx_cached_files_expires_at ON cached_files(expires_at);
CREATE INDEX IF NOT EXISTS idx_cached_files_provider ON cached_files(provider) WHERE provider IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cached_files_last_accessed ON cached_files(last_accessed_at);
```

### 4. Настройка переменных окружения

Добавьте в ваш `.env` файл:

```bash
# PostgreSQL connection string
DATABASE_URL=postgresql://user:password@localhost:5432/video_bot_cache

# Опционально: настройка пула соединений
DB_POOL_MIN=2
DB_POOL_MAX=10

# Redis URL (для fallback и обратной совместимости)
REDIS_URL=redis://localhost:6379
```

Формат `DATABASE_URL`:
- `postgresql://user:password@host:port/database`
- Для SSL: `postgresql://user:password@host:port/database?ssl=true`

### 5. Миграция существующих данных из Redis

Если у вас уже есть данные в Redis, выполните миграцию:

```bash
npm run migrate-cache
```

Скрипт:
- Читает все ключи `file-cache:*` из Redis
- Парсит JSON значения
- Вставляет в PostgreSQL с обработкой дубликатов
- Логирует прогресс и статистику

Скрипт идемпотентен - можно запускать несколько раз безопасно.

## Архитектура

### Dual-Write Pattern

Система использует dual-write pattern для постепенной миграции:

1. **Чтение**:
   - Сначала проверяется PostgreSQL
   - Если нет в БД, fallback на Redis/in-memory
   - Логируется источник данных для мониторинга

2. **Запись**:
   - Если `DATABASE_URL` задан: запись в PostgreSQL + Redis (dual-write)
   - Если `DATABASE_URL` не задан: только Redis/in-memory

3. **Удаление**:
   - Удаление из обоих хранилищ (если БД доступна)

### Connection Pooling

PostgreSQL использует connection pooling для оптимизации производительности:
- Минимум соединений: `DB_POOL_MIN` (по умолчанию: 2)
- Максимум соединений: `DB_POOL_MAX` (по умолчанию: 10)
- Автоматическое управление пулом соединений

### Prepared Statements

Все SQL запросы используют prepared statements для:
- Безопасности (защита от SQL injection)
- Производительности (кэширование планов запросов)

## Использование

### Автоматическое использование

После настройки `DATABASE_URL`, система автоматически использует PostgreSQL кеш. Никаких изменений в коде не требуется - API остался идентичным.

### Проверка работы

Проверьте логи при запуске бота:
```
PostgreSQL cache pool initialized { min: 2, max: 10 }
```

При использовании кеша:
```
Cache hit from PostgreSQL { urlHash: '...', duration: 5 }
```

### Отключение PostgreSQL кеша

Просто удалите или закомментируйте `DATABASE_URL` в `.env`:
```bash
# DATABASE_URL=postgresql://...
```

Система автоматически переключится на Redis/in-memory кеш.

## Мониторинг и аналитика

### Статистика кеша

Выполните SQL запрос для получения статистики:

```sql
-- Общее количество записей
SELECT COUNT(*) FROM cached_files;

-- Количество по провайдерам
SELECT provider, COUNT(*) as count 
FROM cached_files 
WHERE provider IS NOT NULL 
GROUP BY provider 
ORDER BY count DESC;

-- Размер кеша
SELECT 
  COUNT(*) as total_records,
  SUM(size_bytes) as total_size_bytes,
  AVG(size_bytes) as avg_size_bytes
FROM cached_files;

-- Популярные URL (по количеству обращений)
SELECT 
  original_url,
  COUNT(*) as access_count,
  MAX(last_accessed_at) as last_access
FROM cached_files
GROUP BY original_url
ORDER BY access_count DESC
LIMIT 10;
```

### Очистка устаревших записей

Записи автоматически истекают через 30 дней. Для ручной очистки:

```sql
-- Удалить истекшие записи
DELETE FROM cached_files WHERE expires_at < NOW();

-- Или через cron (pg_cron extension)
SELECT cron.schedule(
  'cleanup-expired-cache',
  '0 2 * * *', -- Каждый день в 2:00
  $$DELETE FROM cached_files WHERE expires_at < NOW()$$
);
```

## Troubleshooting

### БД недоступна

Если PostgreSQL недоступна, система автоматически переключится на Redis fallback. Проверьте логи:
```
Failed to initialize PostgreSQL pool, falling back to Redis
```

### Медленные запросы

Если запросы медленные (> 10ms):
1. Проверьте индексы: `\d cached_files` в psql
2. Проверьте размер таблицы: `SELECT pg_size_pretty(pg_total_relation_size('cached_files'));`
3. Выполните `VACUUM ANALYZE cached_files;` для оптимизации

### Ошибки подключения

Проверьте:
- Правильность `DATABASE_URL`
- Доступность PostgreSQL сервера
- Права доступа пользователя БД
- Настройки firewall

### Проблемы с пулом соединений

Если видите ошибки "too many clients":
- Уменьшите `DB_POOL_MAX`
- Проверьте другие приложения, использующие ту же БД
- Увеличьте `max_connections` в PostgreSQL

## Производительность

### Ожидаемые показатели

- **Чтение из кеша**: < 10ms (с индексами)
- **Запись в кеш**: < 20ms
- **Миграция данных**: ~1000 записей/сек

### Оптимизация

1. **Индексы**: Все необходимые индексы созданы автоматически
2. **Connection Pooling**: Настроен оптимальный размер пула
3. **Prepared Statements**: Все запросы используют prepared statements
4. **Batch операции**: Миграция использует batch для эффективности

## Откат миграции

Если нужно откатиться к Redis-only кешу:

1. Удалите `DATABASE_URL` из `.env`
2. Перезапустите бота
3. Система автоматически переключится на Redis

Данные в PostgreSQL останутся, но не будут использоваться.

## Дальнейшее развитие

Возможные улучшения:
- Автоматическая очистка устаревших записей через cron
- Статистика использования кеша в `/status` команде
- Метрики производительности (Prometheus/Grafana)
- Репликация для высокой доступности

## Поддержка

При возникновении проблем:
1. Проверьте логи бота
2. Проверьте логи PostgreSQL
3. Выполните диагностические SQL запросы
4. Создайте issue с описанием проблемы и логами

