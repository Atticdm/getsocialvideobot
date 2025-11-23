# Быстрый старт: Пул cookies для Instagram

## Проблема

При использовании бота 10,000+ пользователями одна cookie быстро заблокируется Instagram. Нужен пул cookies для ротации.

## Решение за 5 минут

### 1. Подготовьте cookies для каждого аккаунта

Для каждого аккаунта Instagram:
1. Экспортируйте cookies через расширение браузера
2. Конвертируйте в base64: `base64 -w0 cookies.txt > account1_b64.txt`

### 2. Создайте JSON пул

Создайте файл `cookie_pool.json`:

```json
[
  {"id": "account1", "cookiesB64": "PASTE_BASE64_HERE"},
  {"id": "account2", "cookiesB64": "PASTE_BASE64_HERE"},
  {"id": "account3", "cookiesB64": "PASTE_BASE64_HERE"}
]
```

### 3. Конвертируйте в Base64

```bash
base64 -w0 cookie_pool.json > cookie_pool_b64.txt
```

### 4. Установите в Railway

Variables → `INSTAGRAM_COOKIES_POOL_B64` → вставьте содержимое `cookie_pool_b64.txt`

## Готово!

Бот автоматически будет ротировать cookies между аккаунтами. Заблокированные cookies автоматически исключаются.

Подробная документация: [INSTAGRAM_COOKIE_POOL_SETUP.md](./INSTAGRAM_COOKIE_POOL_SETUP.md)

