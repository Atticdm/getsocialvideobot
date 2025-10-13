# ⚡ Быстрая настройка temp-server на Render

## 🎯 Цель
Развернуть temp-server на Render за 5 минут для работы inline-режима.

---

## 📝 Шаг 1: Создание Web Service (2 мин)

1. Откройте: https://dashboard.render.com
2. Нажмите **"New +"** → **"Web Service"**
3. Выберите **"Build and deploy from a Git repository"**
4. Подключите GitHub и выберите: **`Atticdm/getsocialvideobot`**

---

## ⚙️ Шаг 2: Настройки сервиса (2 мин)

Заполните форму:

| Поле | Значение |
|------|----------|
| **Name** | `temp-video-server` |
| **Region** | `Oregon (US West)` |
| **Branch** | `main` |
| **Root Directory** | `temp-server` ⚠️ **ВАЖНО!** |
| **Runtime** | `Node` |
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Instance Type** | **Starter** ($7/мес) 🔴 **Рекомендуется!** |

> **💡 Почему Starter?** Free план "засыпает" через 15 мин → видео не загрузится в inline

---

## 🔑 Шаг 3: Environment Variables (1 мин)

Нажмите **"Advanced"** → **"Add Environment Variable"**

### Сгенерируйте секретный ключ:
```bash
openssl rand -base64 32
```

Скопируйте результат (например: `kJ8vN2mP9xQ4wR5yT6zU7aB3cD1eF2gH3iJ4kL5mN6o=`)

### Добавьте переменную:
```
Key:   UPLOAD_SECRET
Value: kJ8vN2mP9xQ4wR5yT6zU7aB3cD1eF2gH3iJ4kL5mN6o=
```

⚠️ **Сохраните этот ключ** - он понадобится для Railway!

Нажмите **"Create Web Service"**

---

## ⏳ Шаг 4: Дождитесь деплоя (~2-3 мин)

Смотрите логи. Ищите строку:
```
Temp server listening on port 10000, serving /tmp
```

После успешного деплоя скопируйте URL сверху страницы:
```
https://temp-video-server-xxxx.onrender.com
```

---

## ✅ Шаг 5: Проверка (30 сек)

Откройте в браузере:
```
https://temp-video-server-xxxx.onrender.com/healthz
```

Ожидаемый ответ:
```json
{"status":"ok","tmpDir":"/tmp"}
```

---

## 🔗 Шаг 6: Настройка Railway (1 мин)

Откройте Railway Dashboard вашего бота:

**Variables** → **New Variable**:

```
TEMP_SERVER_URL=https://temp-video-server-xxxx.onrender.com
TEMP_SERVER_SECRET=kJ8vN2mP9xQ4wR5yT6zU7aB3cD1eF2gH3iJ4kL5mN6o=
```

⚠️ **Замените:**
- `xxxx` на ваш реальный Render URL
- Используйте **тот же секретный ключ**, что на Render!

Railway автоматически перезапустит бота.

---

## 🎉 Готово! Тестирование

В любом чате Telegram введите:
```
@getsocialvideobot https://www.instagram.com/reel/XXXXXXXXXXX/
```

**Ожидаемый результат:**
- ✅ Карточка с видео появилась
- ✅ Видео воспроизводится
- ❌ Нет красного восклицательного знака

---

## 🐛 Если не работает

### Видео не загружается:
1. Проверьте логи Render: POST /upload должен быть 200
2. Проверьте логи Railway: "File uploaded to temp-server for inline"
3. Проверьте секреты на обоих сервисах (должны совпадать!)

### Подробная документация:
- [docs/INLINE_SETUP.md](docs/INLINE_SETUP.md) - полное руководство
- [temp-server/RENDER_DEPLOY.md](temp-server/RENDER_DEPLOY.md) - детали деплоя

---

## 💰 Стоимость

- Render Starter: **$7/мес**
- Railway Hobby: **$5/мес** (750h free)
- **Итого**: ~$12/мес для production

---

**Время настройки**: 5-7 минут  
**Готово к production**: ✅

