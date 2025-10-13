# 🍪 Как получить cookies для Sora

## Проблема
Sora защищена **Cloudflare** и требует аутентификации. Бот не может скачивать видео без ваших cookies из браузера.

## ✅ Быстрое решение (5 минут)

### Шаг 1: Установите расширение

**Chrome/Edge/Brave:**
1. Откройте [Get cookies.txt LOCALLY](https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc)
2. Нажмите "Установить"

**Firefox:**
1. Откройте [cookies.txt](https://addons.mozilla.org/en-US/firefox/addon/cookies-txt/)
2. Нажмите "Добавить в Firefox"

### Шаг 2: Авторизуйтесь в Sora

1. Откройте https://sora.chatgpt.com
2. Войдите в свой аккаунт ChatGPT
3. Откройте любое видео - убедитесь, что оно проигрывается

### Шаг 3: Экспортируйте cookies

1. Нажмите на иконку расширения "Get cookies.txt LOCALLY"
2. Нажмите "Export" или "Current Site"
3. Сохраните файл как `sora_cookies.txt`

### Шаг 4: Конвертируйте в Base64

**macOS/Linux:**
```bash
cd /Users/attic/getsocialvideobot
base64 -i sora_cookies.txt | tr -d '\n' > sora_b64.txt
cat sora_b64.txt | pbcopy  # Скопирует в буфер обмена
echo "✅ Cookies скопированы в буфер обмена!"
```

**Windows (PowerShell):**
```powershell
$content = [IO.File]::ReadAllBytes("sora_cookies.txt")
$base64 = [Convert]::ToBase64String($content)
$base64 | Set-Clipboard
Write-Host "✅ Cookies скопированы в буфер обмена!"
```

### Шаг 5: Установите переменную окружения

**Для локального теста:**
```bash
cd /Users/attic/getsocialvideobot/video-bot
export SORA_COOKIES_B64="<вставьте_сюда_из_буфера_обмена>"
npm run build
npm start
```

**Для Railway (продакшн):**
1. Откройте ваш проект на Railway
2. Перейдите в раздел "Variables"
3. Нажмите "New Variable"
4. Имя: `SORA_COOKIES_B64`
5. Значение: вставьте из буфера обмена
6. Сохраните и дождитесь redeploy

### Шаг 6: Протестируйте!

Теперь отправьте боту:
```
https://sora.chatgpt.com/p/s_68dc38a88fe48191a54a419d37554093
```

## 🔧 Как работает

1. **Playwright** запускает реальный браузер Chromium
2. Загружает ваши **cookies** (авторизация)
3. Открывает страницу Sora (обходит Cloudflare)
4. Перехватывает сетевые запросы и находит **.mp4** URL
5. Скачивает видео напрямую
6. Отправляет вам файл

## ⚠️ Важно

- **Cookies истекают** через 7-30 дней - нужно будет обновить
- **Не делитесь** cookies - это ваша сессия авторизации
- **Храните в безопасности** - не коммитьте в git
- Если не работает - проверьте что cookies свежие

## 🐛 Проблемы?

### "Could not extract video URL"
✅ Обновите cookies (они истекли)

### "Cloudflare protection detected"  
✅ Убедитесь, что установили SORA_COOKIES_B64

### "Failed to fetch video"
✅ Проверьте что видео публичное и доступно
✅ Попробуйте открыть в браузере

---

**После установки cookies бот будет работать автоматически!** 🚀



