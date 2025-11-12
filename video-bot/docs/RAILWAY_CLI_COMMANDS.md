# Railway CLI - Полезные команды для управления сервером

## ✅ Railway CLI работает!

Теперь можно выполнять команды на сервере Railway через CLI.

## Основные команды

### 1. Проверка статуса проекта

```bash
cd /Users/attic/getsocialvideobot/video-bot
npx @railway/cli status
```

Показывает:
- Текущий проект
- Окружение (production)
- Связанный сервис

### 2. Выполнение команд на сервере

#### Вариант A: Через SSH (рекомендуется)

```bash
cd /Users/attic/getsocialvideobot/video-bot
npx @railway/cli ssh
```

После подключения выполните команды напрямую на сервере:
```bash
cd video-bot
npm run migrate-promo
npm run check-promo-tables
```

#### Вариант B: Через Shell (локально с переменными Railway)

```bash
cd /Users/attic/getsocialvideobot/video-bot
npx @railway/cli shell
```

Откроет локальную оболочку с переменными окружения из Railway.

**⚠️ Важно:** `railway run` выполняет команды **локально**, но использует переменные из Railway. Для выполнения команд **на сервере** используйте `railway ssh`.

### 3. Просмотр переменных окружения

```bash
npx @railway/cli variables
```

Показывает все переменные окружения для текущего проекта.

### 4. Выполнение миграции промокодов

#### На сервере (через SSH):
```bash
npx @railway/cli ssh
# После подключения:
cd video-bot
npm run migrate-promo
```

#### Локально (если DATABASE_URL доступен):
```bash
cd /Users/attic/getsocialvideobot/video-bot
npx @railway/cli run npm run migrate-promo
```

**Примечание:** Для локального выполнения нужен публичный DATABASE_URL (не `postgres.railway.internal`).

### 5. Просмотр логов

```bash
npx @railway/cli logs
```

Показывает логи сервиса в реальном времени.

### 6. Просмотр деплоев

```bash
npx @railway/cli deployment list
```

Показывает историю деплоев.

## Полезные команды для отладки

### Проверка таблиц промокодов на сервере:
```bash
npx @railway/cli ssh
cd video-bot
npm run check-promo-tables
```

### Проверка подключения к БД:
```bash
npx @railway/cli ssh
cd video-bot
npm run test-db
```

### Просмотр переменных окружения:
```bash
npx @railway/cli variables
```

### Перезапуск сервиса:
```bash
npx @railway/cli up
```

## Примеры использования

### Пример 1: Выполнить миграцию на сервере

```bash
cd /Users/attic/getsocialvideobot/video-bot
npx @railway/cli ssh
# В SSH сессии:
cd video-bot
npm run migrate-promo
exit
```

### Пример 2: Проверить логи

```bash
npx @railway/cli logs --tail 100
```

### Пример 3: Проверить статус деплоя

```bash
npx @railway/cli deployment list --limit 5
```

## Важные замечания

1. **`railway run`** - выполняет команды локально с переменными Railway
2. **`railway ssh`** - подключается к серверу и выполняет команды там
3. **`railway shell`** - открывает локальную оболочку с переменными Railway
4. **`postgres.railway.internal`** - доступен только внутри контейнера Railway

## Быстрая справка

```bash
# Все доступные команды
npx @railway/cli --help

# Помощь по конкретной команде
npx @railway/cli <command> --help
```

