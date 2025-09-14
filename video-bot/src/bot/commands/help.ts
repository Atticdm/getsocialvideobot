import { Context } from 'telegraf';
import { logger } from '../../core/logger';

export async function helpCommand(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id;
    const username = ctx.from?.username;
    
    logger.info('Help command received', { userId, username });
    
    const message = `📖 **Help - Video Bot Commands**

**Commands:**
/start - Show welcome message
/help - Show this help message
/status - Check bot status and system info
/download <url> - Download a Facebook video

**Usage:** /download <facebook_url>

**Example:** /download https://www.facebook.com/watch/?v=123456789

**Notes:**
• Only public videos are supported
• File size limit: ~2GB
• Processing may take a few minutes`;
    
    await ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('Error in help command', { error, userId: ctx.from?.id });
    await ctx.reply('Sorry, something went wrong. Please try again.');
  }
}
