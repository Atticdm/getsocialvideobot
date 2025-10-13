# 🚀 Деплой temp-server на Render

## Пошаговая инструкция

### 1️⃣ Создание Web Service

1. Откройте [Render Dashboard](https://dashboard.render.com)
2. Нажмите **"New +"** → **"Web Service"**
3. Выберите **"Build and deploy from a Git repository"**
4. Нажмите **"Connect account"** и выберите GitHub
5. Найдите репозиторий: **`Atticdm/getsocialvideobot`**
6. Нажмите **"Connect"**

### 2️⃣ Настройки сервиса

Заполните форму следующими значениями:

| Параметр | Значение |
|----------|----------|
| **Name** | `temp-video-server` (или свое название) |
| **Region** | `Oregon (US West)` (или ближайший) |
| **Branch** | `main` |
| **Root Directory** | `temp-server` ⚠️ **ВАЖНО!** |
| **Runtime** | `Node` (автоопределится) |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |

### 3️⃣ Выбор плана

**⚠️ Важное замечание о планах:**

#### 🆓 Free Plan
- **Цена**: $0
- **Ограничения**: 
  - Сервис "засыпает" после **15 минут** неактивности
  - Первый запрос после сна занимает **~30 секунд**
  - **Проблема для inline**: Telegram может показать ошибку при загрузке видео
- **Подходит**: Только для тестирования

#### 💎 Starter Plan ($7/месяц)
- **Цена**: $7/мес (требуется карта)
- **Преимущества**: 
  - Сервис **всегда активен**
  - Мгновенная отдача файлов
  - Стабильный inline-режим
- **Подходит**: Для production использования

**Рекомендация**: Для стабильного inline-режима нужен **Starter Plan** минимум.

### 4️⃣ Environment Variables

В разделе **"Environment"** добавьте **обязательные** переменные:

```
UPLOAD_SECRET=<ваш-секретный-ключ>
```

**Опциональные**:
```
TMP_DIR=/tmp
```

Render автоматически установит `PORT`.

⚠️ **ВАЖНО**: 
- Сгенерируйте надежный секретный ключ (минимум 32 символа)
- Используйте **одинаковый** `UPLOAD_SECRET` на Render и Railway!

### 5️⃣ Деплой

1. Прокрутите вниз и нажмите **"Create Web Service"**
2. Дождитесь завершения деплоя (логи покажутся автоматически)
3. Ищите в логах строку: `Temp server listening on port ...`

### 6️⃣ Получение публичного URL

После успешного деплоя вы увидите URL вверху страницы:
```
https://temp-video-server-xxxx.onrender.com
```

**Скопируйте этот URL** - он понадобится для следующего шага.

### 7️⃣ Проверка работоспособности

Откройте в браузере или через curl:

```bash
curl https://your-service.onrender.com/healthz
```

**Ожидаемый ответ:**
```json
{"status":"ok","tmpDir":"/tmp"}
```

---

## 🔗 Интеграция с основным ботом

После успешного деплоя temp-server:

### 1. Откройте Railway Dashboard вашего основного бота

### 2. Добавьте переменные окружения

**Variables** → **New Variable**:
```
TEMP_SERVER_URL=https://temp-video-server-xxxx.onrender.com
TEMP_SERVER_SECRET=<тот-же-секретный-ключ-что-на-render>
```

⚠️ **Замените**:
- `xxxx` на ваш реальный URL от Render
- `<тот-же-секретный-ключ-что-на-render>` на точно такой же ключ, как UPLOAD_SECRET на Render!

### 3. Перезапустите бот

После добавления переменной Railway автоматически перезапустит сервис.

---

## ✅ Тестирование inline-режима

### 1. Проверьте логи бота на Railway

Убедитесь, что бот стартовал с новой переменной:
```
TEMP_SERVER_URL: https://temp-video-server-xxxx.onrender.com
```

### 2. Отправьте inline-запрос в Telegram

```
@getsocialvideobot <ссылка на видео>
```

Например:
```
@getsocialvideobot https://www.instagram.com/reel/XXXXXXXXXXX/
```

### 3. Проверьте результат

✅ **Успех**: Видео появилось в карточке и воспроизводится  
❌ **Ошибка**: Красный восклицательный знак или "Your message could not be sent"

### 4. Проверьте логи Render

Откройте **Logs** в Render Dashboard temp-server.

При успешном inline-запросе вы должны увидеть:
```
GET /tmp/session_xxx_video.mp4 200
```

---

## 🐛 Troubleshooting

### Проблема: Видео не загружается в inline

**Возможные причины:**

1. **Free план спит**
   - Решение: Обновите на Starter план
   
2. **TEMP_SERVER_URL не установлен**
   - Проверьте переменные окружения на Railway
   
3. **Неверный URL**
   - Убедитесь, что URL без слэша в конце
   - Правильно: `https://temp-server.onrender.com`
   - Неправильно: `https://temp-server.onrender.com/`

4. **Файл не найден на Render**
   - Проверьте, что бот корректно загружает файлы в `/tmp`
   - Проверьте логи обоих сервисов

### Проблема: Render сервис падает

Проверьте логи:
```
Error: ENOENT: no such file or directory, scandir '/tmp'
```

**Решение**: Убедитесь, что Root Directory установлен в `temp-server`

---

## 📊 Мониторинг

### Проверка здоровья сервиса

Настройте мониторинг healthcheck:
```bash
*/5 * * * * curl https://your-service.onrender.com/healthz
```

Это также поможет "разбудить" Free план каждые 5 минут (но не решит проблему полностью).

---

## 💰 Стоимость

| План | Цена/мес | Uptime | Рекомендация |
|------|----------|--------|--------------|
| Free | $0 | Спит после 15 мин | Только тестирование |
| Starter | $7 | 100% | Production ✅ |
| Standard | $25+ | 100% + больше ресурсов | High traffic |

---

## 📝 Следующие шаги

После успешного деплоя:
- [ ] Проверить healthcheck endpoint
- [ ] Добавить TEMP_SERVER_URL в Railway
- [ ] Протестировать inline-режим
- [ ] Проверить логи на обоих сервисах
- [ ] (Опционально) Настроить мониторинг uptime

---

## 🔗 Полезные ссылки

- [Render Dashboard](https://dashboard.render.com)
- [Railway Dashboard](https://railway.app/dashboard)
- [Render Documentation](https://render.com/docs)
- [Node.js Deployment Guide](https://render.com/docs/deploy-node-express-app)

