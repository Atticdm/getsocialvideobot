# Настройка cookies для Sora

## Зачем нужны cookies?

Sora (sora.chatgpt.com) защищена Cloudflare и требует аутентификации. Для скачивания видео необходимо предоставить cookies из вашего браузера, где вы авторизованы в ChatGPT/Sora.

## Как получить cookies

### Способ 1: Расширение для браузера (Рекомендуется)

1. **Установите расширение для экспорта cookies:**
   - Chrome/Edge: [Get cookies.txt LOCALLY](https://chrome.google.com/webstore/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc)
   - Firefox: [cookies.txt](https://addons.mozilla.org/en-US/firefox/addon/cookies-txt/)

2. **Откройте Sora в браузере:**
   - Перейдите на https://sora.chatgpt.com
   - Авторизуйтесь (если ещё не авторизованы)
   - Откройте любое видео, убедитесь что всё работает

3. **Экспортируйте cookies:**
   - Нажмите на иконку расширения
   - Выберите "Export" или "Get cookies.txt"
   - Сохраните файл `cookies.txt`

4. **Конвертируйте в Base64:**
   ```bash
   # macOS/Linux
   base64 -i cookies.txt -o sora_cookies_b64.txt
   # или одной строкой без переносов:
   base64 -w0 cookies.txt > sora_cookies_b64.txt
   
   # Windows (PowerShell)
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("cookies.txt")) | Out-File -Encoding ASCII sora_cookies_b64.txt
   ```

5. **Установите переменную окружения:**
   ```bash
   # Локально
   export SORA_COOKIES_B64="<содержимое файла sora_cookies_b64.txt>"
   
   # В .env файле
   SORA_COOKIES_B64=<содержимое_файла>
   
   # Railway (в настройках проекта)
   Добавьте переменную SORA_COOKIES_B64 с содержимым файла
   ```

### Способ 2: Вручную из DevTools

1. **Откройте DevTools:**
   - Перейдите на https://sora.chatgpt.com
   - Нажмите F12 (или Cmd+Option+I на Mac)
   - Перейдите во вкладку "Network"

2. **Обновите страницу:**
   - Нажмите F5
   - Найдите первый запрос к sora.chatgpt.com
   - Кликните на него правой кнопкой
   - Выберите "Copy" > "Copy as cURL"

3. **Извлеките cookies:**
   - В скопированной команде найдите `-H 'Cookie: ...'`
   - Скопируйте всё между кавычками после `Cookie:`

4. **Создайте файл cookies.txt в формате Netscape:**
   ```
   # Netscape HTTP Cookie File
   .sora.chatgpt.com	TRUE	/	TRUE	0	_name1	value1
   .sora.chatgpt.com	TRUE	/	TRUE	0	_name2	value2
   ```
   
   Или используйте упрощённый формат (только важные):
   ```
   # Netscape HTTP Cookie File
   sora.chatgpt.com	FALSE	/	TRUE	2147483647	__Secure-next-auth.session-token	YOUR_TOKEN_HERE
   .chatgpt.com	TRUE	/	TRUE	2147483647	__cf_bm	YOUR_CLOUDFLARE_TOKEN
   ```

5. **Конвертируйте в Base64** (см. шаг 4 из Способа 1)

## Использование

### Локально

```bash
cd video-bot
export SORA_COOKIES_B64="<ваш_base64_токен>"
npm run start:web
```

### Railway

1. Откройте настройки вашего проекта на Railway
2. Перейдите в "Variables"
3. Добавьте новую переменную:
   - Name: `SORA_COOKIES_B64`
   - Value: `<содержимое файла sora_cookies_b64.txt>`
4. Deploy изменения

### Docker

```bash
docker run -d \
  -e SORA_COOKIES_B64="<ваш_base64_токен>" \
  -p 3000:3000 \
  video-bot
```

## Проверка

После настройки cookies:

1. **Через бота:**
   ```
   /download https://sora.chatgpt.com/p/s_68dc38a88fe48191a54a419d37554093
   ```

2. **Через веб-интерфейс:**
   - Откройте http://localhost:3000 (или ваш Railway URL)
   - Вставьте ссылку на Sora видео
   - Нажмите "Download"

## Troubleshooting

### "Cloudflare protection detected"

**Проблема:** Бот всё ещё видит страницу защиты Cloudflare.

**Решение:**
- Убедитесь, что cookies актуальные (не истекли)
- Проверьте формат cookies.txt (должен быть Netscape format)
- Попробуйте экспортировать cookies заново
- Проверьте, что переменная `SORA_COOKIES_B64` установлена корректно

### "Failed to fetch video"

**Проблема:** Страница загружается, но видео не найдено.

**Решение:**
- Проверьте, что видео публичное и доступно
- Убедитесь, что вы авторизованы в Sora
- Попробуйте открыть видео в браузере и проверить доступность

### Cookies истекли

**Проблема:** Через некоторое время скачивание перестаёт работать.

**Решение:**
- Cookies имеют срок действия
- Экспортируйте новые cookies и обновите `SORA_COOKIES_B64`
- Обычно cookies действуют 7-30 дней

## Безопасность

⚠️ **Важно:**
- Cookies содержат вашу сессию авторизации
- Не делитесь ими с другими людьми
- Храните их в безопасности
- Используйте переменные окружения, не коммитьте в git
- Регулярно обновляйте cookies

## Формат cookies.txt (Netscape)

```
# Netscape HTTP Cookie File
# This is a generated file! Do not edit.
.sora.chatgpt.com	TRUE	/	TRUE	1234567890	cookie_name	cookie_value
```

Формат: `domain  flag  path  secure  expiration  name  value`

- domain: домен cookie
- flag: TRUE для поддоменов
- path: путь (обычно /)
- secure: TRUE для HTTPS
- expiration: Unix timestamp
- name: имя cookie
- value: значение cookie


