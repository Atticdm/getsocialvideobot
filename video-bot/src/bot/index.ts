import { Telegraf } from 'telegraf';
import type { Context } from 'telegraf';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { ensureTempDir } from '../core/fs';
import { run } from '../core/exec';
import { startCommand } from './commands/start';
import { helpCommand } from './commands/help';
import { statusCommand } from './commands/status';
import { downloadCommand } from './commands/download';
import { diagCommand } from './commands/diag';
import { translateCommand } from './commands/translate';
import { TranslationDirection } from '../types/translation';

const translationIntents = new Map<number, TranslationDirection>();

async function main(): Promise<void> {
  try {
    logger.info('Starting Video Bot', { 
      nodeEnv: config.NODE_ENV,
      version: process.env['npm_package_version'] || '1.0.0'
    });

    try {
      const ytdlpVersion = await run('yt-dlp', ['--version']);
      const ffmpegVersion = await run('ffmpeg', ['-version']);
      logger.info({
        'yt-dlp': ytdlpVersion.stdout.trim(),
        'ffmpeg': ffmpegVersion.stdout.split('\n')[0],
      }, 'Tool versions');
    } catch (e) {
      logger.error(e, 'Failed to check tool versions on startup');
    }

    // Ensure temporary directory exists
    await ensureTempDir();

    // Create bot instance
    const bot = new Telegraf(config.BOT_TOKEN!);

    // Register commands
    bot.command('start', startCommand);
    bot.command('help', helpCommand);
    bot.command('status', statusCommand);
    bot.command('download', downloadCommand);
    bot.command('diag', diagCommand);
    bot.command('translate', async (ctx) => {
      try {
        await translateCommand(ctx);
      } finally {
        const userId = ctx.from?.id;
        if (userId) translationIntents.delete(userId);
      }
    });

    // Handle keyboard buttons
    bot.hears('📥 Download', (ctx) => {
      ctx.reply('Please use the /download command with a Facebook video URL.\n\nExample: /download https://www.facebook.com/watch/?v=123456789');
    });

    bot.hears('❓ Help', helpCommand);
    bot.hears('🔧 Status', statusCommand);

    const ensureTranslationEnabled = async (ctx: Context) => {
      if (!config.ENABLE_REEL_TRANSLATION) {
        await ctx.reply('⚙️ Функция перевода рилсов пока отключена. Установите ENABLE_REEL_TRANSLATION=1, чтобы включить её.');
        return false;
      }
      return true;
    };

    const registerTranslationIntent = async (ctx: Context, direction: TranslationDirection) => {
      const userId = ctx.from?.id;
      if (!userId) {
        await ctx.reply('Не удалось определить пользователя. Попробуйте ещё раз.');
        return;
      }

      const enabled = await ensureTranslationEnabled(ctx);
      if (!enabled) return;

      translationIntents.set(userId, direction);
      const directionLabel = direction === 'en-ru' ? 'английского на русский' : 'русского на английский';
      await ctx.reply(`Отлично! Пришлите ссылку на Instagram Reel для перевода с ${directionLabel}. Чтобы отменить режим перевода, нажмите «❌ Cancel».`);
    };

    bot.hears('🌐 EN→RU', (ctx) => registerTranslationIntent(ctx, 'en-ru'));
    bot.hears('🌐 RU→EN', (ctx) => registerTranslationIntent(ctx, 'ru-en'));
    bot.hears('❌ Cancel', async (ctx) => {
      const userId = ctx.from?.id;
      if (!userId) {
        await ctx.reply('Не удалось определить пользователя.');
        return;
      }
      translationIntents.delete(userId);
      await ctx.reply('Режим перевода отключён. Отправьте ссылку напрямую, чтобы скачать оригинал, или выберите нужную кнопку заново.');
    });

    // Handle unknown messages
    bot.on('text', async (ctx) => {
      const text = ctx.message?.text;
      const userId = ctx.from?.id;

      if (text && text.startsWith('http')) {
        if (userId && translationIntents.has(userId)) {
          const direction = translationIntents.get(userId)!;
          translationIntents.delete(userId);
          ctx.message.text = `/translate ${text} ${direction}`;
          return translateCommand(ctx);
        }

        // If user sends a URL directly, treat it as a download command
        ctx.message.text = `/download ${text}`;
        return downloadCommand(ctx);
      }

      if (userId && translationIntents.has(userId)) {
        await ctx.reply('Пожалуйста, пришлите ссылку на Instagram Reel, чтобы выполнить перевод, или нажмите «❌ Cancel».');
        return;
      }
      
      await ctx.reply('I don\'t understand that message. Use /help to see available commands.');
    });

    // Error handling
    bot.catch((err, ctx) => {
      logger.error('Bot error', { 
        error: err, 
        userId: ctx.from?.id,
        username: ctx.from?.username,
        message: ctx.message && 'text' in ctx.message ? ctx.message.text : 'unknown'
      });
      
      ctx.reply('Sorry, something went wrong. Please try again.');
    });

    // Start bot
    await bot.launch();
    
    logger.info('Bot started successfully');

    // Graceful shutdown
    process.once('SIGINT', () => {
      logger.info('Received SIGINT, shutting down gracefully');
      bot.stop('SIGINT');
    });

    process.once('SIGTERM', () => {
      logger.info('Received SIGTERM, shutting down gracefully');
      bot.stop('SIGTERM');
    });

  } catch (error) {
    logger.error('Failed to start bot', { error });
    process.exit(1);
  }
}

// Start the application
main().catch((error) => {
  logger.error('Unhandled error in main', { error });
  process.exit(1);
});
