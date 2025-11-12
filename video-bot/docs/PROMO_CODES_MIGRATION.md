# Миграция таблиц промокодов

## Проблема

Если вы видите ошибку "Promo codes tables do not exist - migration required" в логах, значит таблицы промокодов не созданы в базе данных.

## Решение: Выполнить миграцию

### ⚠️ ВАЖНО: Если деплой падает на этапе "Pre-deploy command"

Если вы видите ошибку "Pre-deploy command failed" в Railway:

1. **Откройте Railway Dashboard** → ваш сервис → **Settings**
2. Найдите раздел **"Deploy"** или **"Pre-deploy Command"**
3. **Удалите или закомментируйте** команду `npm run migrate-promo` из pre-deploy
4. Выполните миграцию вручную после деплоя (см. способы ниже)

**Почему?** Pre-deploy команды выполняются до установки зависимостей и могут не иметь доступа к `ts-node` или `DATABASE_URL`.

### Способ 1: Через SSH на сервере (Рекомендуется)

1. Подключитесь к серверу через SSH:
   ```bash
   ssh user@your-server-ip
   ```

2. Перейдите в директорию проекта:
   ```bash
   cd /opt/getsocialvideobot/video-bot
   ```

3. Выполните миграцию:
   ```bash
   npm run migrate-promo
   ```

4. Проверьте результат:
   ```bash
   npm run check-promo-tables
   ```

### Способ 2: Через Railway CLI

Если у вас установлен Railway CLI:

```bash
railway run npm run migrate-promo
```

**Примечание:** Команда `migrate-promo` теперь использует скомпилированный JavaScript (`node`), а не `ts-node`, поэтому работает в production окружении.

### Способ 3: Через Railway Web Console

1. Откройте Railway Dashboard
2. Выберите ваш сервис `getsocialvideobot`
3. Перейдите в раздел "Deployments"
4. Нажмите на активный deployment
5. Откройте вкладку "Shell" или "Console"
6. Выполните команду:
   ```bash
   cd video-bot && npm run migrate-promo
   ```

### Способ 4: Добавить в GitHub Actions (Автоматически)

Можно добавить выполнение миграции в workflow деплоя. Откройте `.github/workflows/deploy.yml` и добавьте после `npm run build`:

```yaml
- name: Run promo codes migration
  run: |
    ssh -o StrictHostKeyChecking=no ${{ secrets.USER }}@${{ secrets.HOST }} "
      cd /opt/getsocialvideobot/video-bot &&
      npm run migrate-promo
    "
```

## Проверка результата

После выполнения миграции проверьте:

```bash
npm run check-promo-tables
```

Должны увидеть:
- ✅ promo_codes
- ✅ promo_code_usage  
- ✅ user_promo_status
- ✅ Промокод GODMODE найден

## Что создается при миграции

1. **Таблица `promo_codes`** - хранит все промокоды
2. **Таблица `promo_code_usage`** - отслеживает использование промокодов пользователями
3. **Таблица `user_promo_status`** - хранит статус безлимитных промокодов для пользователей
4. **Промокод `GODMODE`** - автоматически создается с безлимитным доступом

## После миграции

После успешной миграции промокоды начнут работать. Попробуйте:

```
/promo GODMODE
```

или просто отправьте:

```
GODMODE
```

