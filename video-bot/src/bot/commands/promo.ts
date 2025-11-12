import { Context } from 'telegraf';
import { activatePromoCode } from '../../core/payments/promo';
import { logger } from '../../core/logger';
import { trackUserEvent } from '../../core/analytics';

export async function promoCommand(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username;
  const messageText = ctx.message && 'text' in ctx.message ? ctx.message.text : undefined;

  if (!userId) {
    await ctx.reply('Не удалось определить пользователя.');
    return;
  }

  // Извлекаем промокод из команды /promo CODE или из текста сообщения
  let promoCode = '';

  if (messageText) {
    const parts = messageText.split(/\s+/);
    if (parts.length > 1 && parts[1]) {
      // Промокод указан в команде: /promo PROMO2024
      promoCode = parts[1].toUpperCase().trim();
    }
  }

  if (!promoCode) {
    // Запрашиваем промокод у пользователя
    await ctx.reply(
      '🎁 **Активация промокода**\n\n' +
      'Введите промокод, который хотите активировать.\n\n' +
      'Пример: `/promo PROMO2024`\n\n' +
      'Или просто отправьте промокод в следующем сообщении.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  if (!promoCode || promoCode.length === 0) {
    await ctx.reply('❌ Промокод не указан. Используйте формат: `/promo КОД`', {
      parse_mode: 'Markdown',
    });
    return;
  }

  logger.info({ userId, username, promoCode }, 'Promo code activation attempt');

  try {
    const result = await activatePromoCode(userId, promoCode);

    if (result.success) {
      await ctx.reply(result.message, { parse_mode: 'Markdown' });
      trackUserEvent('promo.activated', userId, { username, promoCode, promoType: result.promoType });
      logger.info({ userId, promoCode, promoType: result.promoType }, 'Promo code activated successfully');
    } else {
      await ctx.reply(result.message);
      trackUserEvent('promo.failed', userId, { username, promoCode, reason: result.message });
      logger.warn({ userId, promoCode, reason: result.message }, 'Promo code activation failed');
    }
  } catch (error: unknown) {
    logger.error({ error, userId, promoCode }, 'Failed to activate promo code');
    await ctx.reply('❌ Произошла ошибка при активации промокода. Попробуйте позже или обратитесь в поддержку (/support).');
  }
}

/**
 * Обработчик текстового сообщения с промокодом
 * Используется когда пользователь отправляет промокод без команды /promo
 */
export async function handlePromoCodeMessage(ctx: Context): Promise<boolean> {
  const userId = ctx.from?.id;
  const messageText = ctx.message && 'text' in ctx.message ? ctx.message.text : '';

  if (!userId || !messageText) {
    return false;
  }

  // Проверяем, похоже ли сообщение на промокод (заглавные буквы, длина 4-50 символов)
  const promoPattern = /^[A-Z0-9]{4,50}$/;
  if (!promoPattern.test(messageText.trim())) {
    return false; // Не похоже на промокод
  }

  const promoCode = messageText.trim().toUpperCase();
  logger.info({ userId, promoCode }, 'Promo code detected in message');

  try {
    const result = await activatePromoCode(userId, promoCode);

    if (result.success) {
      await ctx.reply(result.message, { parse_mode: 'Markdown' });
      trackUserEvent('promo.activated', userId, { 
        username: ctx.from?.username, 
        promoCode, 
        promoType: result.promoType,
        source: 'message'
      });
      logger.info({ userId, promoCode, promoType: result.promoType }, 'Promo code activated from message');
      return true;
    } else {
      // Не отвечаем на неверные промокоды, чтобы не спамить пользователя
      // Просто возвращаем false, чтобы бот мог обработать сообщение как обычный текст
      return false;
    }
  } catch (error: unknown) {
    logger.error({ error, userId, promoCode }, 'Failed to process promo code from message');
    return false;
  }
}

