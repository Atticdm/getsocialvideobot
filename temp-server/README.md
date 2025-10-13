# Temp Video Server

Простой Express-сервер для раздачи временных видеофайлов с поддержкой CORS и автоматической очисткой.

## Назначение

Этот сервер используется для inline-режима Telegram бота. Он:
- Раздает временные MP4 файлы через HTTP/HTTPS
- Поддерживает Range requests для стриминга
- Автоматически очищает старые файлы (> 1 часа) каждые 15 минут
- Предоставляет healthcheck endpoint для мониторинга

## Deployment на Render

### 1. Создание Web Service

1. Зайдите на [Render Dashboard](https://dashboard.render.com)
2. Нажмите **"New +"** → **"Web Service"**
3. Подключите GitHub репозиторий или загрузите код

### 2. Настройки сервиса

- **Name**: `temp-video-server` (или любое другое)
- **Region**: Oregon (или ближайший)
- **Branch**: `main`
- **Root Directory**: `temp-server`
- **Runtime**: Node
- **Build Command**: `npm install`
- **Start Command**: `npm start`
- **Plan**: Free (или Starter для production)

### 3. Environment Variables

Render автоматически установит `PORT`. Дополнительные переменные (опционально):

```
TMP_DIR=/tmp
```

### 4. После деплоя

После успешного деплоя вы получите URL вида:
```
https://temp-video-server-xxxx.onrender.com
```

Проверьте работоспособность:
```bash
curl https://your-service.onrender.com/healthz
# Ожидаемый ответ: {"status":"ok","tmpDir":"/tmp"}
```

## Использование

### Healthcheck
```
GET /healthz
Response: {"status":"ok","tmpDir":"/tmp"}
```

### Раздача файлов
```
GET /tmp/<filename>.mp4
Response: video/mp4 with Accept-Ranges: bytes
```

### Загрузка файлов (для бота)
```
POST /upload
Headers:
  Authorization: Bearer <UPLOAD_SECRET>
  Content-Type: multipart/form-data
Body:
  video: <file>

Response: 
{
  "success": true,
  "fileName": "video-123456789.mp4",
  "fileUrl": "/tmp/video-123456789.mp4",
  "size": 1234567
}
```

## Интеграция с основным ботом

В настройках основного бота (Railway) добавьте:

```env
TEMP_SERVER_URL=https://your-temp-server.onrender.com
TEMP_SERVER_SECRET=your-secret-key-here
```

⚠️ **ВАЖНО**: Используйте одинаковый секретный ключ на обоих сервисах!

После этого бот будет использовать этот URL для формирования inline-ссылок на видео.

## Автоматическая очистка

Cron job запускается каждые 15 минут и удаляет файлы старше 1 часа.

## Технические детали

- **Runtime**: Node.js 18+
- **Framework**: Express 5
- **CORS**: Enabled для всех источников
- **Logging**: Morgan (combined format)
- **Cleanup**: node-cron (каждые 15 минут)

