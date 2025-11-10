import type { Context } from 'telegraf';
import { config } from '../config';
import { logger } from '../logger';
import { addCredits } from './credits';
import type { PaymentPackage } from './types';
import { getPool } from '../dbCache';

// Prepared statements для проверки дублирования платежей
// Используем telegram_payment_charge_id для совместимости с существующей структурой БД
const CHECK_PAYMENT_EXISTS_QUERY = `
  SELECT id, status
  FROM payment_transactions
  WHERE telegram_payment_charge_id = $1
`;

const INSERT_PAYMENT_TRANSACTION_QUERY = `
  INSERT INTO payment_transactions (
    user_id,
    stars_amount,
    credits_purchased,
    telegram_payment_charge_id,
    status,
    created_at
  ) VALUES ($1, $2, $3, $4, 'pending', NOW())
  RETURNING id
`;

const COMPLETE_PAYMENT_TRANSACTION_QUERY = `
  UPDATE payment_transactions
  SET status = 'completed', completed_at = NOW()
  WHERE id = $1
`;

const FAIL_PAYMENT_TRANSACTION_QUERY = `
  UPDATE payment_transactions
  SET status = 'failed'
  WHERE id = $1
`;

export function isRedsysEnabled(): boolean {
  return config.REDSYS_ENABLED && !!config.REDSYS_PROVIDER_TOKEN && config.REDSYS_PROVIDER_TOKEN.trim().length > 0;
}

export function getRedsysPaymentPackage(): PaymentPackage {
  const credits = config.REDSYS_PACKAGE_CREDITS || 10;
  const rublesAmount = config.REDSYS_PACKAGE_PRICE_RUB || 50000; // 500 рублей в копейках
  const priceUsd = rublesAmount / 100 / 100; // Конвертация из копеек в рубли, затем в USD (примерно)

  return {
    credits,
    rublesAmount,
    priceUsd,
    description: `Пакет из ${credits} кредитов для переводов и озвучки`,
    provider: 'redsys',
    currency: config.REDSYS_CURRENCY || 'RUB',
  };
}

export async function handleRedsysPreCheckoutQuery(ctx: Context): Promise<void> {
  if (!('preCheckoutQuery' in ctx.update)) {
    return;
  }

  const query = ctx.update.preCheckoutQuery as {
    from?: { id?: number };
    invoice_payload?: string;
    total_amount?: number;
    currency?: string;
  };

  const userId = query.from?.id;
  const invoicePayload = query.invoice_payload;
  const totalAmount = query.total_amount;
  const currency = query.currency;

  if (!userId || !invoicePayload || totalAmount === undefined) {
    await ctx.answerPreCheckoutQuery(false, 'Invalid payment data');
    return;
  }

  // Проверяем payload формат: redsys_{userId}_{timestamp}
  if (!invoicePayload.startsWith('redsys_')) {
    await ctx.answerPreCheckoutQuery(false, 'Invalid invoice payload');
    return;
  }

  const packageInfo = getRedsysPaymentPackage();

  // Валидация суммы (в копейках для RUB)
  const expectedAmount = packageInfo.rublesAmount || 0;
  if (totalAmount !== expectedAmount) {
    logger.warn(
      { userId, totalAmount, expectedAmount, currency },
      'Redsys payment amount mismatch'
    );
    await ctx.answerPreCheckoutQuery(false, 'Invalid payment amount');
    return;
  }

  // Проверяем валюту
  const expectedCurrency = packageInfo.currency || 'RUB';
  if (currency && currency !== expectedCurrency) {
    logger.warn({ userId, currency, expectedCurrency }, 'Redsys payment currency mismatch');
    await ctx.answerPreCheckoutQuery(false, 'Invalid payment currency');
    return;
  }

  // Проверяем пользователя из payload
  const payloadParts = invoicePayload.split('_');
  if (payloadParts.length < 2 || !payloadParts[1]) {
    await ctx.answerPreCheckoutQuery(false, 'Invalid invoice payload format');
    return;
  }

  const payloadUserIdStr = payloadParts[1];
  const payloadUserId = parseInt(payloadUserIdStr, 10);
  if (isNaN(payloadUserId) || payloadUserId !== userId) {
    logger.warn({ userId, payloadUserId }, 'User ID mismatch in Redsys payment payload');
    await ctx.answerPreCheckoutQuery(false, 'User mismatch');
    return;
  }

  // Все проверки пройдены
  await ctx.answerPreCheckoutQuery(true);
  logger.info({ userId, totalAmount, currency }, 'Redsys pre-checkout query approved');
}

export async function handleRedsysSuccessfulPayment(ctx: Context): Promise<void> {
  if (!('message' in ctx.update) || !ctx.update.message || !('successful_payment' in ctx.update.message)) {
    return;
  }

  const payment = ctx.update.message.successful_payment as {
    telegram_payment_charge_id?: string;
    total_amount?: number;
    invoice_payload?: string;
    currency?: string;
  };
  const userId = ctx.from?.id;
  const chargeId = payment.telegram_payment_charge_id;
  const totalAmount = payment.total_amount;
  const invoicePayload = payment.invoice_payload;
  const currency = payment.currency;

  if (!userId || !chargeId || !invoicePayload) {
    logger.error({ userId, chargeId, invoicePayload }, 'Invalid payment data in Redsys successful payment');
    return;
  }

  const packageInfo = getRedsysPaymentPackage();

  // Валидация суммы
  const expectedAmount = packageInfo.rublesAmount || 0;
  if (totalAmount !== expectedAmount) {
    logger.error(
      { userId, totalAmount, expectedAmount, currency },
      'Redsys payment amount mismatch in successful payment'
    );
    await ctx.reply('❌ Ошибка: неверная сумма платежа. Обратитесь в поддержку.');
    return;
  }

  const pool = getPool();
  if (!pool) {
    logger.error({ userId, chargeId }, 'Database unavailable, cannot process Redsys payment');
    await ctx.reply('❌ Ошибка обработки платежа. Обратитесь в поддержку.');
    return;
  }

  try {
    // Проверка на дублирование платежа
    const existingPayment = await pool.query(CHECK_PAYMENT_EXISTS_QUERY, [chargeId]);

    if (existingPayment.rows.length > 0) {
      const existing = existingPayment.rows[0];
      if (existing.status === 'completed') {
        logger.warn({ userId, chargeId }, 'Duplicate Redsys payment detected, already processed');
        await ctx.reply('✅ Этот платеж уже был обработан ранее.');
        return;
      }
    }

    // Создаем транзакцию в БД
    let transactionId: number;
    if (existingPayment.rows.length > 0) {
      // Обновляем существующую транзакцию
      await pool.query(COMPLETE_PAYMENT_TRANSACTION_QUERY, [existingPayment.rows[0].id]);
      transactionId = existingPayment.rows[0].id;
    } else {
      // Создаем новую транзакцию
      // Используем stars_amount для совместимости, но это будет сумма в копейках для Redsys
      const result = await pool.query(INSERT_PAYMENT_TRANSACTION_QUERY, [
        userId,
        totalAmount, // Сохраняем как stars_amount для совместимости
        packageInfo.credits,
        chargeId,
      ]);
      transactionId = result.rows[0].id;
      await pool.query(COMPLETE_PAYMENT_TRANSACTION_QUERY, [transactionId]);
    }

    // Начисляем кредиты
    const creditsAdded = await addCredits(userId, packageInfo.credits, chargeId);

    if (!creditsAdded) {
      logger.error({ userId, chargeId, transactionId }, 'Failed to add credits after Redsys payment');
      await pool.query(FAIL_PAYMENT_TRANSACTION_QUERY, [transactionId]);
      await ctx.reply('❌ Ошибка начисления кредитов. Обратитесь в поддержку.');
      return;
    }

    logger.info(
      { userId, chargeId, transactionId, credits: packageInfo.credits, amount: totalAmount, currency },
      'Redsys payment processed successfully'
    );

    const priceRub = (totalAmount / 100).toFixed(2);
    await ctx.reply(
      `✅ Оплата успешна!\n\nВам начислено: ${packageInfo.credits} кредитов\nСумма: ${priceRub} ${currency || 'RUB'}\nТекущий баланс: ${packageInfo.credits} кредитов\n\nМожете использовать функции перевода и озвучки!`
    );
  } catch (error: unknown) {
    logger.error({ error, userId, chargeId }, 'Failed to process Redsys successful payment');
    await ctx.reply('❌ Ошибка обработки платежа. Обратитесь в поддержку.');
  }
}

export async function createRedsysPaymentButton(ctx: Context, packageInfo: PaymentPackage): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('Не удалось определить пользователя.');
    return;
  }

  if (!isRedsysEnabled()) {
    await ctx.reply('❌ Платежи через Redsys временно недоступны.');
    return;
  }

  try {
    const providerToken = config.REDSYS_PROVIDER_TOKEN;
    const currency = packageInfo.currency || config.REDSYS_CURRENCY || 'RUB';
    const amount = packageInfo.rublesAmount || 0;

    const invoiceLink = await ctx.telegram.createInvoiceLink({
      title: `Пакет из ${packageInfo.credits} кредитов`,
      description: packageInfo.description,
      payload: `redsys_${userId}_${Date.now()}`,
      provider_token: providerToken,
      currency: currency,
      prices: [
        {
          label: `${packageInfo.credits} кредитов`,
          amount: amount,
        },
      ],
    });

    const priceRub = (amount / 100).toFixed(2);
    await ctx.reply(
      `💰 Пакеты кредитов (Redsys):\n\n📦 Пакет "Стартовый"\n• ${packageInfo.credits} кредитов\n• Цена: ${priceRub} ${currency}\n• 1 кредит = ${(amount / packageInfo.credits / 100).toFixed(2)} ${currency}`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: `💳 Купить за ${priceRub} ${currency}`,
                url: invoiceLink,
              },
            ],
            [
              {
                text: '❌ Отмена',
                callback_data: 'payment_cancel',
              },
            ],
          ],
        },
      }
    );
  } catch (error: unknown) {
    logger.error({ error, userId }, 'Failed to create Redsys payment button');
    await ctx.reply('❌ Ошибка создания платежа. Попробуйте позже.');
  }
}

