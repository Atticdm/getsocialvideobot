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
import { TranslationDirection, TranslationEngine, TranslationMode } from '../types/translation';
import type { VoicePreset } from '../types/voice';
import {
  modeChoiceKeyboard,
  mainKeyboard,
  translationKeyboard,
  removeKeyboard,
  voiceChoiceKeyboard,
  dubbingLanguageKeyboard,
} from '../ui/keyboard';
import { getVoiceIdForPreset } from '../services/elevenlabs';
import { setupInlineHandlers } from './inline';

type EntryPreference = 'standard' | 'voice';

type TranslationIntent =
  | { stage: 'direction'; preference: EntryPreference }
  | { stage: 'dubbing-language'; preference: EntryPreference }
  | { stage: 'mode'; direction: TranslationDirection; mode: TranslationMode }
  | { stage: 'voice'; direction: TranslationDirection; mode: TranslationMode; engine: TranslationEngine }
  | { stage: 'ready'; direction: TranslationDirection; mode: TranslationMode; engine: TranslationEngine; voicePreset?: VoicePreset['id'] };

export const bot = new Telegraf(config.BOT_TOKEN!);

let handlersRegistered = false;
let signalsRegistered = false;
export const translationIntents = new Map<number, TranslationIntent>();

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
  bot.command('translate', translateCommand);

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

  const registerTranslationDirection = async (ctx: Context, direction: TranslationDirection) => {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('Не удалось определить пользователя. Попробуйте ещё раз.');
      return;
    }

    const enabled = await ensureTranslationEnabled(ctx);
    if (!enabled) return;

    const intent = translationIntents.get(userId);
    if (!intent || (intent.stage !== 'direction' && intent.stage !== 'dubbing-language')) {
      await ctx.reply('Сначала выберите режим перевода.', {
        reply_markup: mainKeyboard.reply_markup,
      });
      return;
    }

    const mode: TranslationMode = direction.startsWith('identity') ? 'dubbing' : 'translate';
    translationIntents.set(userId, { stage: 'mode', direction, mode });

    if (mode === 'translate') {
      const directionLabel =
        direction === 'en-ru'
          ? 'английского на русский'
          : direction === 'ru-en'
          ? 'русского на английский'
          : 'выбранного направления';
      await ctx.reply(`Отличный выбор! Теперь укажите тип перевода для ${directionLabel}.`, {
        reply_markup: modeChoiceKeyboard.reply_markup,
      });
    } else {
      await ctx.reply('Выберите тип озвучки для переозвучивания ролика:', {
        reply_markup: modeChoiceKeyboard.reply_markup,
      });
    }
  };

  const startDirectionSelection = async (ctx: Context, preference: EntryPreference) => {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('Не удалось определить пользователя.');
      return;
    }
    const enabled = await ensureTranslationEnabled(ctx);
    if (!enabled) return;

    translationIntents.set(userId, { stage: 'direction', preference });
    await ctx.reply('Выберите направление перевода:', {
      reply_markup: translationKeyboard.reply_markup,
    });
  };

  bot.hears('🌐 Translate', async (ctx) => startDirectionSelection(ctx, 'standard'));
  bot.hears('🎙 Перевод с озвучкой', async (ctx) => startDirectionSelection(ctx, 'voice'));

  bot.hears('🇬🇧 → 🇷🇺', (ctx) => registerTranslationDirection(ctx, 'en-ru'));
  bot.hears('🇷🇺 → 🇬🇧', (ctx) => registerTranslationDirection(ctx, 'ru-en'));

  bot.hears('🎬 Переозвучить', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('Не удалось определить пользователя.');
      return;
    }
    const enabled = await ensureTranslationEnabled(ctx);
    if (!enabled) return;

    translationIntents.set(userId, { stage: 'dubbing-language', preference: 'voice' });
    await ctx.reply('Выберите язык для переозвучки:', {
      reply_markup: dubbingLanguageKeyboard.reply_markup,
    });
  });

  bot.hears('🇷🇺 Озвучить русским голосом', (ctx) => registerTranslationDirection(ctx, 'identity-ru'));
  bot.hears('🇬🇧 Озвучить английским голосом', (ctx) => registerTranslationDirection(ctx, 'identity-en'));

  const registerModeChoice = async (ctx: Context, choice: 'hume' | 'elevenlabs' | 'terminator') => {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('Не удалось определить пользователя. Попробуйте ещё раз.');
      return;
    }

    const intent = translationIntents.get(userId);
    if (!intent || intent.stage !== 'mode') {
      await ctx.reply('Сначала выберите направление перевода.', {
        reply_markup: translationKeyboard.reply_markup,
      });
      return;
    }

    const { direction, mode } = intent;

    if (choice === 'hume') {
      if (mode === 'dubbing') {
        await ctx.reply('Режим Hume не поддерживает переозвучивание без перевода. Выберите ElevenLabs.', {
          reply_markup: modeChoiceKeyboard.reply_markup,
        });
        return;
      }
      translationIntents.set(userId, { stage: 'ready', direction, mode, engine: 'hume' });
      await ctx.reply('Отлично! Пришлите ссылку на Instagram Reel для перевода.', {
        reply_markup: removeKeyboard.reply_markup,
      });
      return;
    }

    if (choice === 'elevenlabs') {
      translationIntents.set(userId, { stage: 'ready', direction, mode, engine: 'elevenlabs' });
      await ctx.reply('Отлично! Пришлите ссылку на Instagram Reel для обработки.', {
        reply_markup: removeKeyboard.reply_markup,
      });
      return;
    }

    if (choice === 'terminator') {
      translationIntents.set(userId, { stage: 'voice', direction, mode: 'voice', engine: 'elevenlabs' });
      const voiceLanguage =
        direction === 'en-ru' || direction === 'identity-ru'
          ? 'ru'
          : direction === 'ru-en' || direction === 'identity-en'
          ? 'en'
          : 'ru';
      await ctx.reply('Выберите голос для озвучки:', {
        reply_markup: voiceChoiceKeyboard(voiceLanguage).reply_markup,
      });
      return;
    }
  };

  bot.hears('🚀 Быстрый (Hume)', (ctx) => registerModeChoice(ctx, 'hume'));
  bot.hears('💎 Качественный (ElevenLabs)', (ctx) => registerModeChoice(ctx, 'elevenlabs'));
  bot.hears('🎯 Голос Терминатора', (ctx) => registerModeChoice(ctx, 'terminator'));

  const registerVoicePreset = async (ctx: Context, preset: VoicePreset['id']) => {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('Не удалось определить пользователя. Попробуйте ещё раз.');
      return;
    }
    const intent = translationIntents.get(userId);
    if (!intent || intent.stage !== 'voice') {
      await ctx.reply('Сначала выберите режим озвучки.', {
        reply_markup: mainKeyboard.reply_markup,
      });
      return;
    }

    const voiceId = getVoiceIdForPreset(preset);
    if (!voiceId) {
      const voiceLanguage =
        intent.direction === 'en-ru' || intent.direction === 'identity-ru'
          ? 'ru'
          : intent.direction === 'ru-en' || intent.direction === 'identity-en'
          ? 'en'
          : 'ru';
      await ctx.reply(
        '❌ Голос сейчас недоступен. Проверьте переменные ELEVENLABS_TERMINATOR_VOICE_RU / ELEVENLABS_TERMINATOR_VOICE_EN.',
        {
          reply_markup: voiceChoiceKeyboard(voiceLanguage).reply_markup,
        }
      );
      return;
    }

    translationIntents.set(userId, {
      stage: 'ready',
      direction: intent.direction,
      mode: intent.mode,
      engine: intent.engine,
      voicePreset: preset,
    });

    await ctx.reply('Голос выбран! Пришлите ссылку на ролик для озвучки.', {
      reply_markup: removeKeyboard.reply_markup,
    });
  };

  bot.hears('🤖 Terminator (RU)', (ctx) => registerVoicePreset(ctx, 'terminator-ru'));
  bot.hears('🤖 Terminator (EN)', (ctx) => registerVoicePreset(ctx, 'terminator-en'));

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
        const intent = translationIntents.get(userId)!;
        if (intent.stage === 'ready') {
          translationIntents.delete(userId);
          const token = intent.voicePreset ?? intent.engine;
          ctx.message.text = `/translate ${text} ${intent.direction} ${token}`;
          return translateCommand(ctx);
        }
        if (intent.stage === 'direction') {
          await ctx.reply('Сначала выберите направление перевода.', {
            reply_markup: translationKeyboard.reply_markup,
          });
          return;
        }
        if (intent.stage === 'dubbing-language') {
          await ctx.reply('Выберите язык для переозвучки:', {
            reply_markup: dubbingLanguageKeyboard.reply_markup,
          });
          return;
        }
        if (intent.stage === 'mode') {
          await ctx.reply('Выберите тип обработки:', {
            reply_markup: modeChoiceKeyboard.reply_markup,
          });
          return;
        }
        if (intent.stage === 'voice') {
          const voiceLanguage =
            intent.direction === 'en-ru' || intent.direction === 'identity-ru'
              ? 'ru'
              : intent.direction === 'ru-en' || intent.direction === 'identity-en'
              ? 'en'
              : 'ru';
          await ctx.reply('Выберите голос для озвучки:', {
            reply_markup: voiceChoiceKeyboard(voiceLanguage).reply_markup,
          });
          return;
        }
      }

      ctx.message.text = `/download ${text}`;
      return downloadCommand(ctx);
    }

    if (userId && translationIntents.has(userId)) {
      const intent = translationIntents.get(userId)!;
      if (intent.stage === 'direction') {
        await ctx.reply('Выберите направление перевода:', {
          reply_markup: translationKeyboard.reply_markup,
        });
        return;
      }
      if (intent.stage === 'dubbing-language') {
        await ctx.reply('Выберите язык для переозвучки:', {
          reply_markup: dubbingLanguageKeyboard.reply_markup,
        });
        return;
      }
      if (intent.stage === 'mode') {
        await ctx.reply('Выберите тип обработки:', {
          reply_markup: modeChoiceKeyboard.reply_markup,
        });
        return;
      }
      if (intent.stage === 'voice') {
        const voiceLanguage =
          intent.direction === 'en-ru' || intent.direction === 'identity-ru'
            ? 'ru'
            : intent.direction === 'ru-en' || intent.direction === 'identity-en'
            ? 'en'
            : 'ru';
        await ctx.reply('Выберите голос для озвучки:', {
          reply_markup: voiceChoiceKeyboard(voiceLanguage).reply_markup,
        });
        return;
      }
      if (intent.stage === 'ready') {
        await ctx.reply('Пожалуйста, пришлите ссылку на Instagram Reel для перевода.', {
          reply_markup: removeKeyboard.reply_markup,
        });
        return;
      }
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
