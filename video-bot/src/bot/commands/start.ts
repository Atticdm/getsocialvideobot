import { Context } from 'telegraf';
import { mainKeyboard } from '../../ui/keyboard';
import { logger } from '../../core/logger';

export async function startCommand(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id;
    const username = ctx.from?.username;
    
    logger.info('Start command received', { userId, username });
    
    const message = `🎥 **Welcome to Video Bot!**

I can download public videos from Facebook and Instagram for you.

Use /help to see available commands.

Send me a video URL to download it!`;
    
    await ctx.reply(message, { parse_mode: 'Markdown', reply_markup: mainKeyboard.reply_markup });
  } catch (error) {
    logger.error('Error in start command', { error, userId: ctx.from?.id });
    await ctx.reply('Sorry, something went wrong. Please try again.');
  }
}
