import type { Context } from 'telegraf';
import { config } from '../config';
import { logger } from '../logger';
import { addCredits } from './credits';
import type { PaymentPackage } from './types';
import { getPool } from '../dbCache';

// Prepared statements для проверки дублирования платежей
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

export function getPaymentPackage(): PaymentPackage {
  const credits = config.STARS_PACKAGE_CREDITS || 10;
  const starsAmount = config.STARS_PACKAGE_PRICE || 500;
  const priceUsd = starsAmount / 100; // 1 Star = $0.01

  return {
    credits,
    starsAmount,
    priceUsd,
    description: `Пакет из ${credits} кредитов для переводов и озвучки`,
  };
}

// Функция createPaymentInvoice будет вызываться через createPaymentButton
// которая использует ctx.telegram.createInvoiceLink напрямую

export async function handlePreCheckoutQuery(ctx: Context): Promise<void> {
  if (!('preCheckoutQuery' in ctx.update)) {
    return;
  }

  const query = ctx.update.preCheckoutQuery as {
    from?: { id?: number };
    invoice_payload?: string;
    total_amount?: number;
  };

  const userId = query.from?.id;
  const invoicePayload = query.invoice_payload;
  const totalAmount = query.total_amount;

  if (!userId || !invoicePayload || totalAmount === undefined) {
    await ctx.answerPreCheckoutQuery(false, 'Invalid payment data');
    return;
  }

  // Проверяем payload формат: payment_{userId}_{timestamp}
  if (!invoicePayload.startsWith('payment_')) {
    await ctx.answerPreCheckoutQuery(false, 'Invalid invoice payload');
    return;
  }

  const packageInfo = getPaymentPackage();

  // Валидация суммы
  if (totalAmount !== packageInfo.starsAmount) {
    logger.warn(
      { userId, totalAmount, expectedAmount: packageInfo.starsAmount },
      'Payment amount mismatch'
    );
    await ctx.answerPreCheckoutQuery(false, 'Invalid payment amount');
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
    logger.warn({ userId, payloadUserId }, 'User ID mismatch in payment payload');
    await ctx.answerPreCheckoutQuery(false, 'User mismatch');
    return;
  }

  // Все проверки пройдены
  await ctx.answerPreCheckoutQuery(true);
  logger.info({ userId, totalAmount }, 'Pre-checkout query approved');
}

export async function handleSuccessfulPayment(ctx: Context): Promise<void> {
  if (!('message' in ctx.update) || !ctx.update.message || !('successful_payment' in ctx.update.message)) {
    return;
  }

  const payment = ctx.update.message.successful_payment as {
    telegram_payment_charge_id?: string;
    total_amount?: number;
    invoice_payload?: string;
  };
  const userId = ctx.from?.id;
  const chargeId = payment.telegram_payment_charge_id;
  const totalAmount = payment.total_amount;
  const invoicePayload = payment.invoice_payload;

  if (!userId || !chargeId || !invoicePayload) {
    logger.error({ userId, chargeId, invoicePayload }, 'Invalid payment data in successful payment');
    return;
  }

  const packageInfo = getPaymentPackage();

  // Валидация суммы
  if (totalAmount !== packageInfo.starsAmount) {
    logger.error(
      { userId, totalAmount, expectedAmount: packageInfo.starsAmount },
      'Payment amount mismatch in successful payment'
    );
    await ctx.reply('❌ Ошибка: неверная сумма платежа. Обратитесь в поддержку.');
    return;
  }

  const pool = getPool();
  if (!pool) {
    logger.error({ userId, chargeId }, 'Database unavailable, cannot process payment');
    await ctx.reply('❌ Ошибка обработки платежа. Обратитесь в поддержку.');
    return;
  }

  try {
    // Проверка на дублирование платежа
    const existingPayment = await pool.query(CHECK_PAYMENT_EXISTS_QUERY, [chargeId]);
    
    if (existingPayment.rows.length > 0) {
      const existing = existingPayment.rows[0];
      if (existing.status === 'completed') {
        logger.warn({ userId, chargeId }, 'Duplicate payment detected, already processed');
        await ctx.reply('✅ Этот платеж уже был обработан ранее.');
        return;
      }
      // Если статус pending или failed, обновим его
    }

    // Создаем транзакцию в БД
    let transactionId: number;
    if (existingPayment.rows.length > 0) {
      // Обновляем существующую транзакцию
      await pool.query(COMPLETE_PAYMENT_TRANSACTION_QUERY, [existingPayment.rows[0].id]);
      transactionId = existingPayment.rows[0].id;
    } else {
      // Создаем новую транзакцию
      const result = await pool.query(INSERT_PAYMENT_TRANSACTION_QUERY, [
        userId,
        totalAmount,
        packageInfo.credits,
        chargeId,
      ]);
      transactionId = result.rows[0].id;
      await pool.query(COMPLETE_PAYMENT_TRANSACTION_QUERY, [transactionId]);
    }

    // Начисляем кредиты
    const creditsAdded = await addCredits(userId, packageInfo.credits, chargeId);
    
    if (!creditsAdded) {
      logger.error({ userId, chargeId, transactionId }, 'Failed to add credits after payment');
      await pool.query(FAIL_PAYMENT_TRANSACTION_QUERY, [transactionId]);
      await ctx.reply('❌ Ошибка начисления кредитов. Обратитесь в поддержку.');
      return;
    }

    logger.info(
      { userId, chargeId, transactionId, credits: packageInfo.credits, starsAmount: totalAmount },
      'Payment processed successfully'
    );

    await ctx.reply(
      `✅ Оплата успешна!\n\nВам начислено: ${packageInfo.credits} кредитов\nТекущий баланс: ${packageInfo.credits} кредитов\n\nМожете использовать функции перевода и озвучки!`
    );
  } catch (error: unknown) {
    logger.error({ error, userId, chargeId }, 'Failed to process successful payment');
    await ctx.reply('❌ Ошибка обработки платежа. Обратитесь в поддержку.');
  }
}

export async function createPaymentButton(ctx: Context, packageInfo: PaymentPackage): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) {
    await ctx.reply('Не удалось определить пользователя.');
    return;
  }

  try {
    const invoiceLink = await ctx.telegram.createInvoiceLink({
      title: `Пакет из ${packageInfo.credits} кредитов`,
      description: packageInfo.description,
      payload: `payment_${userId}_${Date.now()}`,
      provider_token: '', // Для Telegram Stars не требуется provider_token
      currency: 'XTR', // Telegram Stars
      prices: [
        {
          label: `${packageInfo.credits} кредитов`,
          amount: packageInfo.starsAmount,
        },
      ],
    });

    await ctx.reply(
      `💰 Пакеты кредитов:\n\n📦 Пакет "Стартовый"\n• ${packageInfo.credits} кредитов\n• Цена: ${packageInfo.starsAmount} ⭐ Stars ($${packageInfo.priceUsd})\n• 1 кредит = $${(packageInfo.priceUsd / packageInfo.credits).toFixed(2)}`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: `💳 Купить за ${packageInfo.starsAmount} ⭐`,
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
    logger.error({ error, userId }, 'Failed to create payment button');
    await ctx.reply('❌ Ошибка создания платежа. Попробуйте позже.');
  }
}

