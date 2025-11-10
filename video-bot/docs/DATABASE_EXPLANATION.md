# Объяснение работы с базой данных

## 1. Connection Pool (Пул подключений)

### Что такое пул подключений?

**Connection Pool** — это набор готовых подключений к базе данных, которые переиспользуются для выполнения запросов.

### Зачем нужен пул?

Без пула:
- Каждый запрос создает новое подключение → медленно
- Закрытие/открытие подключений → накладные расходы
- При большом количестве запросов → перегрузка БД

С пулом:
- Подключения создаются заранее и переиспользуются → быстро
- Меньше накладных расходов → эффективнее
- Контроль нагрузки → защита БД

### Параметры пула в нашем проекте:

```typescript
min: 2        // Минимум 2 подключения всегда готовы
max: 10       // Максимум 10 одновременных подключений
```

**Что значит максимум 10?**
- Одновременно может быть открыто не более 10 подключений к БД
- Если все 10 заняты, новые запросы будут ждать освобождения
- Это защищает БД от перегрузки

**Пример:**
- 5 пользователей делают запросы → используется 5 подключений
- 15 пользователей делают запросы → 10 подключений работают, 5 ждут
- После завершения запросов подключения возвращаются в пул

### Почему именно 10?

- Для большинства ботов этого достаточно
- Можно увеличить до 20-50 для большей нагрузки
- Зависит от возможностей вашей БД (Railway, DigitalOcean и т.д.)

---

## 2. Как работает система кредитов

### Важно: Мы НЕ используем "подписку"!

Вместо подписки используется **система кредитов**:
- Каждый пользователь получает **1 бесплатный кредит** при первом использовании
- Кредиты можно **купить пакетами** (например, 10 кредитов за $5)
- **1 кредит = 1 операция** (перевод или озвучка)

### Структура таблиц

#### Таблица `user_credits` (Баланс пользователя)

```sql
user_id BIGINT PRIMARY KEY          -- ID пользователя Telegram (например, 123456789)
free_credit_used BOOLEAN            -- Использован ли бесплатный кредит (TRUE/FALSE)
paid_credits INTEGER                -- Количество купленных кредитов (0, 10, 20...)
total_operations INTEGER            -- Всего операций (для статистики)
first_used_at TIMESTAMP             -- Первое использование
last_used_at TIMESTAMP              -- Последнее использование
```

**Пример записи:**
```
user_id: 123456789
free_credit_used: TRUE              ← Бесплатный кредит использован
paid_credits: 7                     ← Осталось 7 платных кредитов
total_operations: 4                 ← Всего использовано 4 кредита
```

#### Таблица `payment_transactions` (История платежей)

```sql
id SERIAL PRIMARY KEY
user_id BIGINT                      -- ID пользователя Telegram
stars_amount INTEGER                -- Сумма в Stars (500 = $5)
credits_purchased INTEGER           -- Куплено кредитов (всегда 10)
telegram_payment_charge_id VARCHAR -- Уникальный ID платежа от Telegram
status VARCHAR                      -- 'pending', 'completed', 'failed'
created_at TIMESTAMP
completed_at TIMESTAMP
```

**Пример записи:**
```
user_id: 123456789
stars_amount: 500
credits_purchased: 10
telegram_payment_charge_id: "abc123xyz"
status: "completed"
```

#### Таблица `credit_usage_log` (Лог использования)

```sql
id SERIAL PRIMARY KEY
user_id BIGINT                      -- ID пользователя Telegram
feature VARCHAR                     -- 'translate' или 'voice_over'
credit_type VARCHAR                 -- 'free', 'paid', 'admin'
provider VARCHAR                    -- 'hume', 'elevenlabs'
operation_successful BOOLEAN        -- Успешна ли операция
created_at TIMESTAMP
```

---

## 3. Процесс работы с кредитами

### Шаг 1: Пользователь хочет перевести видео

```typescript
// 1. Проверяем кредиты
const check = await checkCreditsAvailable(userId, 'translate');

// 2. Если пользователя нет в БД - создаем запись автоматически
await ensureUserCreditsRecord(userId, pool);
// → INSERT INTO user_credits (user_id) VALUES (123456789)
//   ON CONFLICT DO NOTHING
```

### Шаг 2: Проверка баланса

```sql
-- Запрос к БД
SELECT free_credit_used, paid_credits 
FROM user_credits 
WHERE user_id = 123456789
FOR UPDATE;  -- Блокируем строку для предотвращения race conditions
```

**Результаты:**
- `free_credit_used = FALSE` → есть бесплатный кредит ✅
- `free_credit_used = TRUE, paid_credits > 0` → есть платные кредиты ✅
- `free_credit_used = TRUE, paid_credits = 0` → нет кредитов ❌

### Шаг 3: Списание кредита (после успешного перевода)

```sql
-- Если бесплатный кредит
UPDATE user_credits
SET free_credit_used = TRUE,
    total_operations = total_operations + 1,
    last_used_at = NOW()
WHERE user_id = 123456789 AND free_credit_used = FALSE;

-- Если платный кредит
UPDATE user_credits
SET paid_credits = paid_credits - 1,
    total_operations = total_operations + 1,
    last_used_at = NOW()
WHERE user_id = 123456789 AND paid_credits > 0;
```

### Шаг 4: Логирование использования

```sql
INSERT INTO credit_usage_log 
(user_id, feature, credit_type, provider, operation_successful)
VALUES (123456789, 'translate', 'free', 'hume', TRUE);
```

---

## 4. Процесс покупки кредитов

### Шаг 1: Пользователь нажимает "Купить"

```typescript
// Создаем инвойс через Telegram Stars или Redsys
const invoiceLink = await ctx.telegram.createInvoiceLink({...});
```

### Шаг 2: Пользователь оплачивает

```typescript
// Telegram отправляет событие successful_payment
bot.on('successful_payment', async (ctx) => {
  // Проверяем, что платеж не дубликат
  const existing = await pool.query(
    'SELECT id FROM payment_transactions WHERE telegram_payment_charge_id = $1',
    [chargeId]
  );
  
  if (existing.rows.length > 0) {
    // Платеж уже обработан
    return;
  }
  
  // Создаем запись о транзакции
  await pool.query(INSERT_PAYMENT_TRANSACTION_QUERY, [
    userId,      // 123456789
    500,          // Stars
    10,           // Кредитов
    chargeId      // Уникальный ID
  ]);
  
  // Начисляем кредиты
  await pool.query(ADD_CREDITS_QUERY, [userId, 10]);
  // → UPDATE user_credits SET paid_credits = paid_credits + 10
});
```

---

## 5. Примеры запросов к БД

### Проверка баланса пользователя

```sql
SELECT 
  free_credit_used,      -- FALSE = есть бесплатный кредит
  paid_credits,          -- 0, 10, 20... = количество платных кредитов
  total_operations       -- Всего использовано кредитов
FROM user_credits
WHERE user_id = 123456789;
```

### История платежей пользователя

```sql
SELECT 
  stars_amount,
  credits_purchased,
  status,
  created_at
FROM payment_transactions
WHERE user_id = 123456789
ORDER BY created_at DESC;
```

### Статистика использования

```sql
SELECT 
  COUNT(*) FILTER (WHERE feature = 'translate') as translations,
  COUNT(*) FILTER (WHERE feature = 'voice_over') as voice_overs,
  COUNT(*) as total_operations
FROM credit_usage_log
WHERE user_id = 123456789 AND operation_successful = TRUE;
```

---

## 6. Защита от race conditions

### Проблема:
Два запроса одновременно проверяют кредиты → оба видят, что кредит есть → оба списывают → списано 2 кредита вместо 1

### Решение:
```sql
SELECT ... FROM user_credits WHERE user_id = $1 FOR UPDATE;
-- ↑ Блокируем строку до завершения транзакции
```

Это гарантирует, что только один запрос может работать с балансом пользователя одновременно.

---

## Итого

1. **Максимум 10 подключений** = защита БД от перегрузки, одновременная обработка до 10 запросов
2. **ID пользователя Telegram** сохраняется в `user_id` (BIGINT)
3. **Нет подписки** — используется система кредитов (1 кредит = 1 операция)
4. **Автоматическое создание** записи при первом использовании
5. **Защита от дублирования** платежей через уникальный `telegram_payment_charge_id`

