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
import { mainKeyboard, translationKeyboard } from '../ui/keyboard';
import { setupInlineHandlers } from './inline';

type TranslationState = TranslationDirection | 'pending';

export const bot = new Telegraf(config.BOT_TOKEN!);

let handlersRegistered = false;
let signalsRegistered = false;
const translationIntents = new Map<number, TranslationState>();

async function logToolVersions(): Promise<void> {
  try {
    const ytdlpVersion = await run('yt-dlp', ['--version']);
    const ffmpegVersion = await run('ffmpeg', ['-version']);
    logger.info(
      {
        'yt-dlp': ytdlpVersion.stdout.trim(),
        ffmpeg: ffmpegVersion.stdout.split('\n')[0],
      },
      'Tool versions'
    );
  } catch (error) {
    logger.error(error, 'Failed to check tool versions on startup');
  }
}

function ensureSignals(): void {
  if (signalsRegistered) return;
  signalsRegistered = true;
  process.once('SIGINT', () => {
    logger.info('Received SIGINT, shutting down gracefully');
    bot.stop('SIGINT');
  });

  process.once('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down gracefully');
    bot.stop('SIGTERM');
  });
}

export async function setupBot(): Promise<void> {
  if (handlersRegistered) return;
  handlersRegistered = true;

  bot.command('start', startCommand);
  bot.command('help', helpCommand);
  bot.command('status', statusCommand);
  bot.command('download', downloadCommand);
  bot.command('dl', downloadCommand);
  bot.command('get', downloadCommand);
  bot.command('diag', diagCommand);
  bot.command('translate', async (ctx) => {
    try {
      await translateCommand(ctx);
    } finally {
      const userId = ctx.from?.id;
      if (userId) translationIntents.delete(userId);
      await ctx.reply('Готово. Выберите дальнейшее действие.', {
        reply_markup: mainKeyboard.reply_markup,
      });
    }
  });

  setupInlineHandlers(bot);

  const ensureTranslationEnabled = async (ctx: Context) => {
    if (!config.ENABLE_REEL_TRANSLATION) {
      await ctx.reply(
        '⚙️ Функция перевода рилсов пока отключена. Установите ENABLE_REEL_TRANSLATION=1, чтобы включить её.'
      );
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
    await ctx.reply(`Отлично! Пришлите ссылку на Instagram Reel для перевода с ${directionLabel}.`, {
      reply_markup: translationKeyboard.reply_markup,
    });
  };

  bot.hears('🌐 Translate', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('Не удалось определить пользователя.');
      return;
    }
    const enabled = await ensureTranslationEnabled(ctx);
    if (!enabled) return;

    translationIntents.set(userId, 'pending');
    await ctx.reply('Выберите направление перевода:', {
      reply_markup: translationKeyboard.reply_markup,
    });
  });

  bot.hears('🇬🇧 → 🇷🇺', (ctx) => registerTranslationIntent(ctx, 'en-ru'));
  bot.hears('🇷🇺 → 🇬🇧', (ctx) => registerTranslationIntent(ctx, 'ru-en'));
  bot.hears('⬅️ Back', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('Не удалось определить пользователя.');
      return;
    }
    translationIntents.delete(userId);
    await ctx.reply('Режим перевода отключён.', {
      reply_markup: mainKeyboard.reply_markup,
    });
  });

  bot.on('text', async (ctx) => {
    const text = ctx.message?.text;
    const userId = ctx.from?.id;

    if (text && text.startsWith('http')) {
      if (userId && translationIntents.has(userId)) {
        const intent = translationIntents.get(userId);
        if (intent && intent !== 'pending') {
          translationIntents.delete(userId);
          ctx.message.text = `/translate ${text} ${intent}`;
          return translateCommand(ctx);
        }
        await ctx.reply('Сначала выберите направление перевода.', {
          reply_markup: translationKeyboard.reply_markup,
        });
        return;
      }

      ctx.message.text = `/download ${text}`;
      return downloadCommand(ctx);
    }

    if (userId && translationIntents.has(userId)) {
      const intent = translationIntents.get(userId);
      if (intent === 'pending') {
        await ctx.reply('Выберите направление перевода:', {
          reply_markup: translationKeyboard.reply_markup,
        });
      } else {
        await ctx.reply('Пожалуйста, пришлите ссылку на Instagram Reel для перевода.', {
          reply_markup: translationKeyboard.reply_markup,
        });
      }
      return;
    }

    await ctx.reply("I don't understand that message. Use /help to see available commands.");
  });

  bot.catch((err, ctx) => {
    logger.error('Bot error', {
      error: err,
      userId: ctx.from?.id,
      username: ctx.from?.username,
      message: ctx.message && 'text' in ctx.message ? ctx.message.text : 'unknown',
    });

    ctx.reply('Sorry, something went wrong. Please try again.');
  });
}

export async function startPolling(): Promise<void> {
  await ensureTempDir();
  await setupBot();
  await logToolVersions();
  await bot.launch();
  ensureSignals();
  logger.info('Bot started successfully (long polling)');
}

export async function configureWebhook(publicUrl: string): Promise<void> {
  await ensureTempDir();
  await setupBot();
  await logToolVersions();
  const base = publicUrl.replace(/\/$/, '');
  await bot.telegram.setWebhook(`${base}/bot`);
  ensureSignals();
  logger.info({ webhookUrl: `${base}/bot` }, 'Webhook configured');
}
