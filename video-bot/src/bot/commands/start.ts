import { Context } from 'telegraf';
import { mainKeyboard } from '../../ui/keyboard';
import { logger } from '../../core/logger';
import { trackUserEvent } from '../../core/analytics';
import { acceptAgreement } from '../../core/agreement';

export async function startCommand(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id;
    const username = ctx.from?.username;
    
    if (!userId) {
      await ctx.reply('Не удалось определить пользователя.');
      return;
    }
    
    logger.info('Start command received', { userId, username });
    trackUserEvent('command.start', userId, { username });
    
    // Автоматически принимаем соглашение при использовании /start
    await acceptAgreement(userId);
    
    const message = `🎥 Welcome!

- Просто пришли ссылку на поддерживаемое видео, чтобы получить оригинал.
- Для перевода рилсов нажми «🌐 Перевести видео».
// Arena publishing functionality is temporarily disabled
// - Чтобы сразу опубликовать ролик в Reels Arena, выбери «📣 Опубликовать в канал» или команду /publish.

Команда /status покажет служебную информацию (если нужна).
Список команд: /help.

⚠️ **Важно:** Используя бота, вы автоматически соглашаетесь с условиями использования (/terms). Переозвучка голоса является симуляцией и не имеет отношения к реальным людям. Пользователь несет полную ответственность за скачиваемый контент.`;

    await ctx.reply(message, { 
      reply_markup: mainKeyboard.reply_markup,
      parse_mode: 'Markdown',
    });
  } catch (error) {
    logger.error('Error in start command', { error, userId: ctx.from?.id });
    trackUserEvent('command.start.error', ctx.from?.id, {
      error: error instanceof Error ? error.message : String(error),
    });
    await ctx.reply('Sorry, something went wrong. Please try again.');
  }
}
