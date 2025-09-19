# Настройка YouTube Cookies для обхода ограничений

## Проблема
Многие YouTube видео стали требовать аутентификации или имеют возрастные ограничения. Для их скачивания необходимо настроить cookies.

## Решение

### 1. Получение cookies из браузера

#### Chrome/Edge:
1. Откройте YouTube в браузере и войдите в аккаунт
2. Откройте DevTools (F12)
3. Перейдите на вкладку **Application** (Chrome) или **Storage** (Edge)
4. В левой панели найдите **Cookies** → **https://www.youtube.com**
5. Выделите все cookies (Ctrl+A)
6. Скопируйте их в текстовый файл в формате Netscape

#### Firefox:
1. Откройте YouTube в браузере и войдите в аккаунт
2. Откройте DevTools (F12)
3. Перейдите на вкладку **Storage**
4. В левой панели найдите **Cookies** → **https://www.youtube.com**
5. Экспортируйте cookies через расширение или скопируйте вручную

### 2. Формат файла cookies

Создайте файл `youtube_cookies.txt` в формате Netscape:

```
# Netscape HTTP Cookie File
.youtube.com	TRUE	/	FALSE	1234567890	VISITOR_INFO1_LIVE	abc123
.youtube.com	TRUE	/	FALSE	1234567890	YSC	def456
.youtube.com	TRUE	/	FALSE	1234567890	PREF	ghi789
```

### 3. Кодирование в base64

```bash
# Linux/Mac
base64 -i youtube_cookies.txt

# Windows (PowerShell)
[Convert]::ToBase64String([IO.File]::ReadAllBytes("youtube_cookies.txt"))
```

### 4. Настройка переменной окружения

#### Локально (.env файл):
```env
YOUTUBE_COOKIES_B64=eyNfTmV0c2NhcGVfSFRUUF9Db29raWVfRmlsZQp9
```

#### Railway (Production):
1. Перейдите в настройки проекта на Railway
2. Добавьте переменную `YOUTUBE_COOKIES_B64` со значением base64

### 5. Дополнительные настройки

#### Гео-обход:
```env
GEO_BYPASS_COUNTRY=US
```

#### Отладка:
```env
DEBUG_YTDLP=true
LOG_LEVEL=debug
```

## Проверка работы

После настройки cookies попробуйте скачать видео, которое ранее выдавало ошибку `ERR_PRIVATE_OR_RESTRICTED`.

## Безопасность

⚠️ **Важно**: 
- Не делитесь файлом cookies с другими
- Регулярно обновляйте cookies (они имеют срок действия)
- Используйте отдельный аккаунт для бота, если возможно

## Альтернативы

Если cookies не помогают, попробуйте:
1. Изменить `GEO_BYPASS_COUNTRY` на другую страну
2. Использовать VPN для получения cookies из другой страны
3. Проверить, что видео действительно публичное
