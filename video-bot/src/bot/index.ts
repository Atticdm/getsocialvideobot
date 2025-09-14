import { Telegraf } from 'telegraf';
import { config } from '../core/config';
import { logger } from '../core/logger';
import { ensureTempDir } from '../core/fs';
import { startCommand } from './commands/start';
import { helpCommand } from './commands/help';
import { statusCommand } from './commands/status';
import { downloadCommand } from './commands/download';

async function main(): Promise<void> {
  try {
    logger.info('Starting Video Bot', { 
      nodeEnv: config.NODE_ENV,
      version: process.env['npm_package_version'] || '1.0.0'
    });

    // Ensure temporary directory exists
    await ensureTempDir();

    // Create bot instance
    const bot = new Telegraf(config.BOT_TOKEN);

    // Register commands
    bot.command('start', startCommand);
    bot.command('help', helpCommand);
    bot.command('status', statusCommand);
    bot.command('download', downloadCommand);

    // Handle keyboard buttons
    bot.hears('📥 Download', (ctx) => {
      ctx.reply('Please use the /download command with a Facebook video URL.\n\nExample: /download https://www.facebook.com/watch/?v=123456789');
    });

    bot.hears('❓ Help', helpCommand);
    bot.hears('🔧 Status', statusCommand);

    // Handle unknown messages
    bot.on('text', async (ctx) => {
      const text = ctx.message?.text;
      if (text && text.startsWith('http')) {
        // If user sends a URL directly, treat it as a download command
        ctx.message.text = `/download ${text}`;
        return downloadCommand(ctx);
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
