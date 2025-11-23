# Настройка cookies для Instagram

## Зачем нужны cookies?

Instagram защищает контент и часто требует аутентификацию для доступа к Reels. Для скачивания видео необходимо предоставить cookies из вашего браузера, где вы авторизованы в Instagram.

## Как получить cookies

### Способ 1: Расширение для браузера (Рекомендуется)

1. **Установите расширение для экспорта cookies:**
   - Chrome/Edge: [Get cookies.txt LOCALLY](https://chrome.google.com/webstore/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc)
   - Firefox: [cookies.txt](https://addons.mozilla.org/en-US/firefox/addon/cookies-txt/)

2. **Откройте Instagram в браузере:**
   - Перейдите на https://www.instagram.com
   - Авторизуйтесь (если ещё не авторизованы)
   - Откройте любой Reel, убедитесь что всё работает

3. **Экспортируйте cookies:**
   - Нажмите на иконку расширения
   - Выберите домен `instagram.com` или `www.instagram.com`
   - Выберите "Export" или "Get cookies.txt"
   - Сохраните файл `instagram_cookies.txt`

4. **Конвертируйте в Base64:**
   ```bash
   # macOS/Linux
   base64 -i instagram_cookies.txt -o instagram_cookies_b64.txt
   # или одной строкой без переносов:
   base64 -w0 instagram_cookies.txt > instagram_cookies_b64.txt
   
   # Windows (PowerShell)
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("instagram_cookies.txt")) | Out-File -Encoding ASCII instagram_cookies_b64.txt
   ```

5. **Установите переменную окружения:**
   ```bash
   # Локально
   export INSTAGRAM_COOKIES_B64="<содержимое файла instagram_cookies_b64.txt>"
   
   # В .env файле
   INSTAGRAM_COOKIES_B64=<содержимое_файла>
   
   # Railway (в настройках проекта)
   Добавьте переменную INSTAGRAM_COOKIES_B64 с содержимым файла
   ```

### Способ 2: Вручную из DevTools

1. **Откройте DevTools:**
   - Перейдите на https://www.instagram.com
   - Нажмите F12 (или Cmd+Option+I на Mac)
   - Перейдите во вкладку "Application" (Chrome) или "Storage" (Firefox)
   - Раскройте "Cookies" в левой панели
   - Выберите `https://www.instagram.com`

2. **Скопируйте важные cookies:**
   - Найдите cookies: `sessionid`, `csrftoken`, `ds_user_id`, `mid`
   - Скопируйте их значения

3. **Создайте файл cookies.txt в формате Netscape:**
   ```
   # Netscape HTTP Cookie File
   # This is a generated file! Do not edit.
   .instagram.com	TRUE	/	TRUE	2147483647	sessionid	YOUR_SESSION_ID_HERE
   .instagram.com	TRUE	/	TRUE	2147483647	csrftoken	YOUR_CSRF_TOKEN_HERE
   .instagram.com	TRUE	/	TRUE	2147483647	ds_user_id	YOUR_USER_ID_HERE
   .instagram.com	TRUE	/	TRUE	2147483647	mid	YOUR_MID_HERE
   ```

4. **Конвертируйте в Base64** (см. шаг 4 из Способа 1)

## Использование

### Локально

```bash
cd video-bot
export INSTAGRAM_COOKIES_B64="<ваш_base64_токен>"
npm run start:bot
```

### Railway

1. Откройте настройки вашего проекта на Railway
2. Перейдите в "Variables"
3. Добавьте новую переменную:
   - Name: `INSTAGRAM_COOKIES_B64`
   - Value: `<содержимое файла instagram_cookies_b64.txt>`
4. Deploy изменения (Railway автоматически перезапустит приложение)

### Docker

```bash
docker run -d \
  -e INSTAGRAM_COOKIES_B64="<ваш_base64_токен>" \
  -p 3000:3000 \
  video-bot
```

## Проверка

После настройки cookies:

1. **Через бота:**
   ```
   /download https://www.instagram.com/reels/DRNyGm6kwf1/
   ```

2. **Проверьте логи:**
   - Должно появиться сообщение: `Instagram cookies detected and written successfully`
   - Попытки скачивания с cookies должны быть в логах

## Troubleshooting

### "Video is private, age-restricted, or requires login"

**Проблема:** Бот всё ещё не может скачать видео даже с cookies.

**Решение:**
- Убедитесь, что cookies актуальные (не истекли)
- Проверьте формат cookies.txt (должен быть Netscape format)
- Попробуйте экспортировать cookies заново
- Проверьте, что переменная `INSTAGRAM_COOKIES_B64` установлена корректно в Railway
- Убедитесь, что переменная `SKIP_COOKIES` не установлена в `true`

### "Failed to decode Instagram cookies"

**Проблема:** Ошибка декодирования cookies.

**Решение:**
- Убедитесь, что файл cookies.txt правильно закодирован в base64
- Проверьте формат файла (должен быть Netscape format с табуляциями)
- Попробуйте экспортировать cookies заново через расширение браузера

### Cookies истекли

**Проблема:** Через некоторое время скачивание перестаёт работать.

**Решение:**
- Cookies имеют срок действия (обычно 30-90 дней)
- Экспортируйте новые cookies и обновите `INSTAGRAM_COOKIES_B64` в Railway
- После обновления переменной Railway автоматически перезапустит приложение

### Rate limit

**Проблема:** Instagram блокирует запросы из-за слишком частых обращений.

**Решение:**
- Instagram имеет лимиты на количество запросов
- Подождите некоторое время перед повторной попыткой
- Используйте cookies от аккаунта с хорошей репутацией

## Безопасность

⚠️ **Важно:**
- Cookies содержат вашу сессию авторизации в Instagram
- Не делитесь ими с другими людьми
- Храните их в безопасности
- Используйте переменные окружения, не коммитьте в git
- Регулярно обновляйте cookies
- Используйте отдельный тестовый аккаунт, если возможно

## Формат cookies.txt (Netscape)

```
# Netscape HTTP Cookie File
# This is a generated file! Do not edit.
.instagram.com	TRUE	/	TRUE	1735689600	sessionid	abc123def456...
.instagram.com	TRUE	/	TRUE	1735689600	csrftoken	xyz789...
```

Формат: `domain  flag  path  secure  expiration  name  value`

- domain: домен cookie (`.instagram.com` для всех поддоменов)
- flag: `TRUE` для поддоменов, `FALSE` для точного домена
- path: путь (обычно `/`)
- secure: `TRUE` для HTTPS-only cookies
- expiration: Unix timestamp (2147483647 для сессионных cookies)
- name: имя cookie
- value: значение cookie

## Важные cookies для Instagram

Минимально необходимые cookies:
- `sessionid` - основная сессия авторизации
- `csrftoken` - токен защиты от CSRF
- `ds_user_id` - ID пользователя
- `mid` - идентификатор устройства

Рекомендуется экспортировать все cookies для домена `instagram.com` через расширение браузера.

