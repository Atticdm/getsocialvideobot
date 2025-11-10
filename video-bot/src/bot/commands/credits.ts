import { Context } from 'telegraf';
import { Markup } from 'telegraf';
import { getCreditsBalance, getUsageStats } from '../../core/payments/credits';
import { getPaymentPackage, createPaymentButton } from '../../core/payments/stars';
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

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('💰 Купить еще кредитов', 'buy_credits')],
    ]);

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

  try {
    const packageInfo = getPaymentPackage();
    await createPaymentButton(ctx, packageInfo);

    trackUserEvent('command.buy', userId, { username });
  } catch (error: unknown) {
    logger.error({ error, userId }, 'Failed to execute buy command');
    await ctx.reply('❌ Ошибка создания платежа. Попробуйте позже.');
  }
}

