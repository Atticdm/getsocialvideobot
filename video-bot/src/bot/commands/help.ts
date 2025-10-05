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
/download <url> - Download a video (Facebook, Instagram, LinkedIn, YouTube)
/translate <url> [en-ru|ru-en|auto] - Переводит Instagram Reels с новой озвучкой (при ENABLE_REEL_TRANSLATION)
🌐 EN→RU / 🌐 RU→EN - Быстрый выбор режима перевода через клавиатуру. После нажатия пришлите ссылку.
❌ Cancel - Отменяет выбранный режим перевода.

**Usage:** /download <video_url>

**Translation:**
/translate https://www.instagram.com/reel/XXXXXXXXXXX/ en-ru
Или нажмите кнопку «🌐 EN→RU»/«🌐 RU→EN», затем пришлите ссылку.

Перевод доступен для английского <-> русского и требует настроенных 'OPENAI_API_KEY' и 'HUME_*' ключей.

**Examples:**
/download https://www.facebook.com/watch/?v=123456789
/download https://www.instagram.com/reel/XXXXXXXXXXX/
/download https://www.linkedin.com/feed/update/urn:li:activity:XXXXXXXXXXXX/
/download https://youtu.be/XXXXXXXXXXX

**Notes:**
• Only public videos are supported (some may require cookies)
• File size limit: ~2GB
• Processing may take a few minutes`;
    
    await ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('Error in help command', { error, userId: ctx.from?.id });
    await ctx.reply('Sorry, something went wrong. Please try again.');
  }
}
