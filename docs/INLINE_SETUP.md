# 🎯 Настройка Inline-режима с Render

Полное руководство по настройке inline-режима с использованием temp-server на Render и основного бота на Railway.

## 📋 Архитектура решения

```
┌─────────────────┐         ┌──────────────────┐         ┌──────────────┐
│   Telegram      │ ◄──────►│  Bot (Railway)   │────────►│ Temp-Server  │
│   User          │         │                  │ upload  │  (Render)    │
└─────────────────┘         └──────────────────┘         └──────────────┘
        │                           │                             │
        │                           │                             │
        └───────────────────────────┴─────────────────────────────┘
                 Inline video URL: https://temp-server.onrender.com/tmp/video.mp4
```

**Почему два сервера?**
- **Railway**: Хостит основного бота, скачивает видео
- **Render**: Раздает видео файлы для Telegram (избегаем ограничений Railway)

---

## 🚀 Пошаговая настройка

### Шаг 1: Деплой temp-server на Render

Следуйте инструкции в [temp-server/RENDER_DEPLOY.md](../temp-server/RENDER_DEPLOY.md)

**Ключевые моменты:**
1. Root Directory: `temp-server`
2. План: **Starter** ($7/мес) для стабильности
3. Environment Variable: `UPLOAD_SECRET=<сгенерируйте-секретный-ключ>`

После деплоя вы получите URL:
```
https://temp-video-server-xxxx.onrender.com
```

### Шаг 2: Настройка основного бота на Railway

Откройте Railway Dashboard вашего бота и добавьте переменные окружения:

#### Обязательные переменные:

```env
TEMP_SERVER_URL=https://temp-video-server-xxxx.onrender.com
TEMP_SERVER_SECRET=<тот-же-секрет-что-на-render>
```

⚠️ **КРИТИЧНО**: `TEMP_SERVER_SECRET` должен **точно совпадать** с `UPLOAD_SECRET` на Render!

#### Генерация секретного ключа:

```bash
# Вариант 1: OpenSSL
openssl rand -base64 32

# Вариант 2: Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# Вариант 3: Python
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

### Шаг 3: Перезапуск бота

После добавления переменных Railway автоматически перезапустит сервис.

Проверьте логи:
```
✅ TEMP_SERVER_URL configured: https://temp-video-server-xxxx.onrender.com
✅ TEMP_SERVER_SECRET configured
```

---

## ✅ Тестирование

### 1. Проверка temp-server

```bash
curl https://temp-video-server-xxxx.onrender.com/healthz
```

Ожидаемый ответ:
```json
{"status":"ok","tmpDir":"/tmp"}
```

### 2. Тестирование inline-режима в Telegram

1. Откройте любой чат в Telegram
2. Введите: `@getsocialvideobot https://www.instagram.com/reel/XXXXXXXXXXX/`
3. Дождитесь появления карточки с видео
4. Выберите видео для отправки

**Ожидаемый результат:**
- ✅ Видео появляется в карточке (thumbnail)
- ✅ Видео воспроизводится при клике
- ✅ Нет красного восклицательного знака
- ✅ Нет ошибки "Your message could not be sent"

### 3. Проверка логов

#### Логи бота (Railway):

```
INFO: Inline download started
INFO: File uploaded to temp-server for inline
     videoUrl: https://temp-video-server-xxxx.onrender.com/tmp/video-123456.mp4
```

#### Логи temp-server (Render):

```
File uploaded: video-123456.mp4 (15234567 bytes)
GET /tmp/video-123456.mp4 200
```

---

## 🐛 Troubleshooting

### Проблема: "Your message could not be sent"

**Возможные причины:**

1. **Free план Render "спит"**
   ```
   Решение: Обновите на Starter план ($7/мес)
   ```

2. **Неверный UPLOAD_SECRET**
   ```
   Проверьте: Секреты на Render и Railway должны совпадать
   Логи Render покажут: 401 Unauthorized
   ```

3. **TEMP_SERVER_URL не настроен**
   ```
   Проверьте переменные окружения на Railway
   Бот должен показать в логах: TEMP_SERVER_URL configured
   ```

4. **Файл не загрузился на temp-server**
   ```
   Проверьте логи бота на Railway:
   - "Failed to upload to temp-server" - проблема с загрузкой
   - "Falling back to local URL" - используется локальный URL (не работает)
   ```

### Проблема: Видео загружается очень медленно

**Причины:**
- Free план Render просыпается ~30 секунд
- Большой размер файла
- Медленное соединение от Telegram серверов до Render

**Решение:**
1. Используйте Starter план Render
2. Оптимизируйте размер видео (MAX_FILE_MB)

### Проблема: 401 Unauthorized в логах temp-server

```
POST /upload 401 Unauthorized
```

**Решение:**
Проверьте, что:
1. `UPLOAD_SECRET` на Render установлен
2. `TEMP_SERVER_SECRET` на Railway совпадает с Render
3. Нет лишних пробелов в секретах

### Проблема: Бот не использует temp-server

Проверьте логи бота:
```bash
# Должно быть:
INFO: File uploaded to temp-server for inline

# Если вместо этого:
WARN: TEMP_SERVER_URL not configured
# Или:
ERROR: TEMP_SERVER_SECRET not configured
```

**Решение:** Убедитесь, что обе переменные установлены на Railway.

---

## 📊 Мониторинг

### Healthcheck temp-server

Создайте мониторинг (UptimeRobot, Cronitor, etc.):
```
GET https://temp-video-server-xxxx.onrender.com/healthz
Интервал: 5 минут
```

**Bonus**: Это также поможет "разбудить" Free план Render.

### Метрики для отслеживания

1. **Время ответа temp-server** (должно быть < 500ms)
2. **Успешность загрузок** (% успешных POST /upload)
3. **Uptime temp-server** (должно быть 100% на Starter)

---

## 💰 Стоимость

| Компонент | Сервис | План | Цена/мес |
|-----------|--------|------|----------|
| Бот | Railway | Hobby | $5 (500h free) |
| Temp-server | Render | Free | $0 (с ограничениями) |
| Temp-server | Render | Starter | $7 (рекомендуется) |

**Итого для production**: ~$12/мес

---

## 🔒 Безопасность

### Секретный ключ

- Минимум 32 символа
- Используйте криптографически стойкий генератор
- Храните в переменных окружения, не в коде
- Регулярно ротируйте (каждые 3-6 месяцев)

### CORS

Temp-server по умолчанию разрешает все источники (`*`).  
Для production рекомендуется ограничить:

```javascript
// temp-server/server.js
app.use(cors({
  origin: ['https://api.telegram.org']
}));
```

---

## 📚 Дополнительные ресурсы

- [temp-server README](../temp-server/README.md)
- [Render Deployment Guide](../temp-server/RENDER_DEPLOY.md)
- [Railway Deployment Guide](DEPLOY_RAILWAY.md)
- [Telegram Bot API: Inline Mode](https://core.telegram.org/bots/inline)

---

## 🎉 Готово!

После успешной настройки ваш бот должен:
- ✅ Работать в inline-режиме
- ✅ Раздавать видео через temp-server на Render
- ✅ Показывать видео в Telegram без ошибок
- ✅ Автоматически очищать старые файлы

**Следующие шаги:**
1. Протестируйте с разными платформами (Instagram, TikTok, YouTube)
2. Настройте мониторинг uptime
3. (Опционально) Обновите на Starter план для стабильности

