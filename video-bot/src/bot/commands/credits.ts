import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { getCreditsBalance, getUsageStats } from '../../core/payments/credits';
import { getPaymentPackage, createPaymentButton } from '../../core/payments/stars';
import { getRedsysPaymentPackage, createRedsysPaymentButton, isRedsysEnabled } from '../../core/payments/redsys';
import { config } from '../../core/config';
import { logger } from '../../core/logger';
import { trackUserEvent } from '../../core/analytics';

export async function creditsCommand(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username;

  if (!userId) {
    await ctx.reply('Не удалось определить пользователя.');
    return;
  }

  try {
    const balance = await getCreditsBalance(userId);
    const stats = await getUsageStats(userId);

    if (!balance) {
      await ctx.reply('❌ Не удалось загрузить информацию о кредитах. Попробуйте позже.');
      return;
    }

    const freeStatus = balance.freeCreditUsed ? 'использован ✅' : 'доступен';
    const statsText = stats
      ? `\n📈 Статистика:\n• Всего операций: ${stats.totalOperations}\n• Переводов: ${stats.translations}\n• Озвучек: ${stats.voiceOvers}`
      : '';

    const message = `💳 Ваш баланс кредитов:\n\nБесплатный кредит: ${freeStatus}\nПлатных кредитов: ${balance.paidCredits}\nВсего доступно: ${balance.totalAvailable} кредитов${statsText}`;

    const keyboardButtons = [];
    
    // Показываем кнопку покупки только если платежи включены
    if (config.PAYMENT_ENABLED) {
      keyboardButtons.push([Markup.button.callback('💰 Купить еще кредитов', 'buy_credits')]);
    }

    const keyboard = Markup.inlineKeyboard(keyboardButtons);

    await ctx.reply(message, { reply_markup: keyboard.reply_markup });

    trackUserEvent('command.credits', userId, { username });
  } catch (error: unknown) {
    logger.error({ error, userId }, 'Failed to execute credits command');
    await ctx.reply('❌ Ошибка загрузки баланса. Попробуйте позже.');
  }
}

export async function buyCommand(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username;

  if (!userId) {
    await ctx.reply('Не удалось определить пользователя.');
    return;
  }

  if (!config.PAYMENT_ENABLED) {
    await ctx.reply('⚙️ Платежи временно отключены.');
    return;
  }

  try {
    const starsEnabled = true; // Stars всегда доступен если платежи включены
    const redsysEnabled = isRedsysEnabled();

    // Если доступны оба провайдера, показываем выбор
    if (starsEnabled && redsysEnabled) {
      const starsPackage = getPaymentPackage();
      const redsysPackage = getRedsysPaymentPackage();
      const priceRub = (redsysPackage.rublesAmount || 0) / 100;
      const starsAmount = starsPackage.starsAmount || 500;

      await ctx.reply(
        `💳 Выберите способ оплаты:\n\n⭐ Telegram Stars\n• ${starsPackage.credits} кредитов за ${starsAmount} ⭐ Stars ($${starsPackage.priceUsd})\n\n💳 Redsys (карта)\n• ${redsysPackage.credits} кредитов за ${priceRub} ${redsysPackage.currency || 'RUB'}`,
        {
          reply_markup: {
            inline_keyboard: [
              [
                Markup.button.callback('⭐ Оплатить Stars', 'buy_stars'),
                Markup.button.callback('💳 Оплатить картой', 'buy_redsys'),
              ],
              [Markup.button.callback('❌ Отмена', 'payment_cancel')],
            ],
          },
        }
      );
    } else if (redsysEnabled) {
      // Только Redsys
      const packageInfo = getRedsysPaymentPackage();
      await createRedsysPaymentButton(ctx, packageInfo);
    } else {
      // Только Stars (по умолчанию)
      const packageInfo = getPaymentPackage();
      await createPaymentButton(ctx, packageInfo);
    }

    trackUserEvent('command.buy', userId, { username });
  } catch (error: unknown) {
    logger.error({ error, userId }, 'Failed to execute buy command');
    await ctx.reply('❌ Ошибка создания платежа. Попробуйте позже.');
  }
}

