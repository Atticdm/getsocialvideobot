import { Context } from 'telegraf';
import { mainKeyboard } from '../../ui/keyboard';
import { logger } from '../../core/logger';

export async function startCommand(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id;
    const username = ctx.from?.username;
    
    logger.info('Start command received', { userId, username });
    
    const message = `🎥 Welcome!

- Просто пришли ссылку на поддерживаемое видео, чтобы получить оригинал.
- Для перевода рилсов нажми «🌐 Перевести видео».
- Чтобы сразу опубликовать ролик в Reels Arena, выбери «📣 Опубликовать в канал» или команду /publish.

Команда /status покажет служебную информацию (если нужна).
Список команд: /help.`;

    await ctx.reply(message, { reply_markup: mainKeyboard.reply_markup });
  } catch (error) {
    logger.error('Error in start command', { error, userId: ctx.from?.id });
    await ctx.reply('Sorry, something went wrong. Please try again.');
  }
}
