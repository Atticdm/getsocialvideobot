import { Telegraf } from 'telegraf';
// Arena publishing functionality is temporarily disabled
// import { Markup } from 'telegraf';
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
import {
  translateEngineKeyboard,
  mainKeyboard,
  translateDirectionKeyboard,
  voiceChoiceKeyboard,
  voiceLanguageKeyboard,
  linkPromptKeyboard,
} from '../ui/keyboard';
import { getVoiceIdForPreset } from '../services/elevenlabs';
import { setupInlineHandlers } from './inline';
import type { VoiceLanguage, VoicePreset } from '../types/voice';
// Arena publishing functionality is temporarily disabled
// import { getArenaDisplayName, isArenaPublishingEnabled, publishCandidateToken } from './publish';
import { shutdownAnalytics, trackSystemEvent, trackUserEvent } from '../core/analytics';

type TranslationIntent =
  | { flow: 'translate'; stage: 'direction' }
  | { flow: 'translate'; stage: 'engine'; direction: TranslationDirection }
  | {
      flow: 'translate';
      stage: 'ready';
      direction: TranslationDirection;
      mode: TranslationMode;
      engine: TranslationEngine;
      voicePreset?: VoicePreset['id'];
    }
  | { flow: 'voice'; stage: 'language' }
  | { flow: 'voice'; stage: 'voice'; language: VoiceLanguage }
  | {
      flow: 'voice';
      stage: 'ready';
      direction: TranslationDirection;
      mode: TranslationMode;
      engine: TranslationEngine;
      voicePreset: VoicePreset['id'];
      language: VoiceLanguage;
    };

export const bot = new Telegraf(config.BOT_TOKEN!);

let handlersRegistered = false;
let signalsRegistered = false;
export const translationIntents = new Map<number, TranslationIntent>();
// Arena publishing functionality is temporarily disabled
// const arenaPublishRequests = new Set<number>();

// const ARENA_MEMBER_STATUSES = new Set(['member', 'administrator', 'creator']);

// Arena publishing functionality is temporarily disabled
// @ts-expect-error - Function is temporarily disabled but kept for future use
async function _ensureArenaSubscription(_ctx: Context): Promise<boolean> {
  // if (!isArenaPublishingEnabled()) return true;
  // const userId = ctx.from?.id;
  // if (!userId) {
  //   await ctx.reply('Не удалось определить пользователя.');
  //   return false;
  // }

  // try {
  //   const member = await ctx.telegram.getChatMember(config.ARENA_CHANNEL_ID!, userId);
  //   if (ARENA_MEMBER_STATUSES.has(member.status)) return true;
  // } catch (error) {
  //   logger.warn({ error, userId }, 'Failed to verify arena subscription');
  //   await ctx.reply('⚠️ Не удалось проверить подписку. Попробуйте позже.');
  //   return false;
  // }

  // const channelLink = config.ARENA_CHANNEL_URL || (config.ARENA_CHANNEL_ID?.startsWith('@')
  //   ? `https://t.me/${config.ARENA_CHANNEL_ID.slice(1)}`
  //   : undefined);

  // const message = `Сначала вступите в ${getArenaDisplayName()}, чтобы публиковать ролики.`;
  // if (channelLink) {
  //   await ctx.reply(message, {
  //     reply_markup: Markup.inlineKeyboard([Markup.button.url('Перейти в канал', channelLink)]).reply_markup,
  //   });
  // } else {
  //   await ctx.reply(message);
  // }
  // return false;
  return false;
}

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
    void shutdownAnalytics();
    bot.stop('SIGINT');
  });

  process.once('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down gracefully');
    void shutdownAnalytics();
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

  const showDownloadInfo = async (ctx: Context) => {
    const userId = ctx.from?.id;
    if (userId) {
      translationIntents.delete(userId);
      // arenaPublishRequests.delete(userId); // Arena publishing disabled
    }
    trackUserEvent('menu.download_info', userId, { username: ctx.from?.username });
    const instructions = `📥 Как скачать видео\n\nПросто пришлите ссылку на поддерживаемое видео, и бот скачает оригинал и вернёт файл в чат.\n\nПоддерживаемые источники:\n• Facebook и Reels\n• Instagram (Reels)\n• YouTube\n• TikTok\n• LinkedIn\n• Sora\n\nСовет: отправляйте одну ссылку в отдельном сообщении, чтобы бот распознал её автоматически.`;
    await ctx.reply(instructions, {
      reply_markup: mainKeyboard.reply_markup,
    });
  };

  const ensureTranslationEnabled = async (ctx: Context) => {
    if (!config.ENABLE_REEL_TRANSLATION) {
      await ctx.reply(
        '⚙️ Функция перевода рилсов пока отключена. Установите ENABLE_REEL_TRANSLATION=1, чтобы включить её.'
      );
      return false;
    }
    return true;
  };


  const startTranslateFlow = async (ctx: Context) => {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('Не удалось определить пользователя.');
      return;
    }
    const enabled = await ensureTranslationEnabled(ctx);
    if (!enabled) return;

    translationIntents.set(userId, { flow: 'translate', stage: 'direction' });
    await ctx.reply('Выберите направление перевода:', {
      reply_markup: translateDirectionKeyboard.reply_markup,
    });
  };

  const startVoiceFlow = async (ctx: Context) => {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('Не удалось определить пользователя.');
      return;
    }
    const enabled = await ensureTranslationEnabled(ctx);
    if (!enabled) return;

    translationIntents.set(userId, { flow: 'voice', stage: 'language' });
    await ctx.reply('Выберите язык оригинального ролика:', {
      reply_markup: voiceLanguageKeyboard.reply_markup,
    });
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
    if (!intent || intent.flow !== 'translate' || intent.stage !== 'direction') {
      await ctx.reply('Сначала выберите режим перевода.', {
        reply_markup: mainKeyboard.reply_markup,
      });
      return;
    }

    translationIntents.set(userId, { flow: 'translate', stage: 'engine', direction });
    await ctx.reply('Выберите тип перевода:', {
      reply_markup: translateEngineKeyboard.reply_markup,
    });
  };

  const registerTranslateEngine = async (ctx: Context, choice: 'hume' | 'elevenlabs' | 'terminator') => {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('Не удалось определить пользователя. Попробуйте ещё раз.');
      return;
    }

    const intent = translationIntents.get(userId);
    if (!intent || intent.flow !== 'translate' || intent.stage !== 'engine') {
      await ctx.reply('Сначала выберите направление перевода.', {
        reply_markup: translateDirectionKeyboard.reply_markup,
      });
      return;
    }

    const direction = intent.direction;
    if (choice === 'hume') {
      translationIntents.set(userId, {
        flow: 'translate',
        stage: 'ready',
        direction,
        mode: 'translate',
        engine: 'hume',
      });
      await ctx.reply('Отличный выбор! Пришлите ссылку на ролик.', {
        reply_markup: linkPromptKeyboard.reply_markup,
      });
      return;
    }

    if (choice === 'elevenlabs') {
      translationIntents.set(userId, {
        flow: 'translate',
        stage: 'ready',
        direction,
        mode: 'translate',
        engine: 'elevenlabs',
      });
      await ctx.reply('Отлично! Пришлите ссылку на ролик.', {
        reply_markup: linkPromptKeyboard.reply_markup,
      });
      return;
    }

    if (choice === 'terminator') {
      const voicePreset: VoicePreset['id'] = direction === 'en-ru' ? 'terminator-ru' : 'terminator-en';
      translationIntents.set(userId, {
        flow: 'translate',
        stage: 'ready',
        direction,
        mode: 'voice',
        engine: 'elevenlabs',
        voicePreset,
      });
      await ctx.reply('Терминатор готов! Пришлите ссылку на ролик.', {
        reply_markup: linkPromptKeyboard.reply_markup,
      });
      return;
    }
  };

  // Arena publishing functionality is temporarily disabled
  // @ts-expect-error - Function is temporarily disabled but kept for future use
  const _startArenaPublishFlow = async (ctx: Context): Promise<void> => {
    // if (!isArenaPublishingEnabled()) {
    //   await ctx.reply('⚙️ Публикация в канал временно недоступна. Свяжитесь с администратором.');
    //   return;
    // }
    // const subscribed = await ensureArenaSubscription(ctx);
    // if (!subscribed) return;
    // const userId = ctx.from?.id;
    // if (!userId) {
    //   await ctx.reply('Не удалось определить пользователя.');
    //   return;
    // }
    // arenaPublishRequests.add(userId);
    // translationIntents.delete(userId);
    // await ctx.reply(
    //   `📣 Пришлите ссылку на ролик, и после скачивания я опубликую его в ${getArenaDisplayName()}.\n\nНажмите Отмена, чтобы выйти.`,
    //   {
    //     reply_markup: linkPromptKeyboard.reply_markup,
    //   }
    // );
    await ctx.reply('⚙️ Публикация в канал временно недоступна.');
  };

  const registerVoiceLanguage = async (ctx: Context, language: VoiceLanguage) => {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('Не удалось определить пользователя. Попробуйте ещё раз.');
      return;
    }
    const intent = translationIntents.get(userId);
    if (!intent || intent.flow !== 'voice' || intent.stage !== 'language') {
      await ctx.reply('Сначала выберите режим озвучки.', {
        reply_markup: mainKeyboard.reply_markup,
      });
      return;
    }

    translationIntents.set(userId, { flow: 'voice', stage: 'voice', language });
    await ctx.reply('Выберите голос для озвучки:', {
      reply_markup: voiceChoiceKeyboard(language).reply_markup,
    });
  };

  const registerVoicePreset = async (ctx: Context, preset: VoicePreset['id']) => {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('Не удалось определить пользователя. Попробуйте ещё раз.');
      return;
    }
    const intent = translationIntents.get(userId);
    if (!intent || intent.flow !== 'voice' || intent.stage !== 'voice') {
      await ctx.reply('Сначала выберите язык ролика.', {
        reply_markup: voiceLanguageKeyboard.reply_markup,
      });
      return;
    }

    const voiceId = getVoiceIdForPreset(preset);
    if (!voiceId) {
      await ctx.reply(
        '❌ Голос сейчас недоступен. Проверьте переменные ELEVENLABS_TERМИNАТОР_VOICE_RU / ELEVENLABS_TERMINATOR_VOICE_EN.',
        {
          reply_markup: voiceChoiceKeyboard(intent.language).reply_markup,
        }
      );
      return;
    }

    const direction: TranslationDirection = intent.language === 'ru' ? 'identity-ru' : 'identity-en';

    translationIntents.set(userId, {
      flow: 'voice',
      stage: 'ready',
      direction,
      mode: 'voice',
      engine: 'elevenlabs',
      voicePreset: preset,
      language: intent.language,
    });

    await ctx.reply('Голос выбран! Пришлите ссылку на ролик для озвучки.', {
      reply_markup: linkPromptKeyboard.reply_markup,
    });
  };

  bot.hears('🌐 Перевести видео', startTranslateFlow);
  bot.hears('🎙 Озвучить видео', startVoiceFlow);
  // Arena publishing functionality is temporarily disabled
  // bot.hears('📣 Опубликовать в канал', startArenaPublishFlow);
  bot.hears('⬇️ Скачать видео', showDownloadInfo);
  // bot.command('publish', startArenaPublishFlow);

  bot.hears('🇬🇧 → 🇷🇺', (ctx) => registerTranslationDirection(ctx, 'en-ru'));
  bot.hears('🇷🇺 → 🇬🇧', (ctx) => registerTranslationDirection(ctx, 'ru-en'));

  bot.hears('🚀 Быстрый (Hume)', (ctx) => registerTranslateEngine(ctx, 'hume'));
  bot.hears('💎 Качественный (ElevenLabs)', (ctx) => registerTranslateEngine(ctx, 'elevenlabs'));
  bot.hears('🎯 Голос Терминатора', (ctx) => registerTranslateEngine(ctx, 'terminator'));

  bot.hears('🇷🇺 Ролик на русском', (ctx) => registerVoiceLanguage(ctx, 'ru'));
  bot.hears('🇬🇧 Video in English', (ctx) => registerVoiceLanguage(ctx, 'en'));

  bot.hears('🤖 Terminator (RU)', (ctx) => registerVoicePreset(ctx, 'terminator-ru'));
  bot.hears('🤖 Terminator (EN)', (ctx) => registerVoicePreset(ctx, 'terminator-en'));

  const cancelFlow = async (ctx: Context) => {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('Не удалось определить пользователя.');
      return;
    }
    translationIntents.delete(userId);
    // arenaPublishRequests.delete(userId); // Arena publishing disabled
    await ctx.reply('Режим перевода отключён.', {
      reply_markup: mainKeyboard.reply_markup,
    });
  };

  bot.command('cancel', cancelFlow);
  bot.hears('Отмена', cancelFlow);

  bot.hears('⬅️ Назад', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) {
      await ctx.reply('Не удалось определить пользователя.');
      return;
    }
    // arenaPublishRequests.delete(userId); // Arena publishing disabled
    const intent = translationIntents.get(userId);
    if (!intent) {
      await ctx.reply('Возвращаюсь в главное меню.', {
        reply_markup: mainKeyboard.reply_markup,
      });
      return;
    }

    if (intent.stage === 'ready') {
      if (intent.flow === 'translate') {
        translationIntents.set(userId, { flow: 'translate', stage: 'engine', direction: intent.direction });
        await ctx.reply('Выберите тип перевода:', {
          reply_markup: translateEngineKeyboard.reply_markup,
        });
        return;
      }
      if (intent.flow === 'voice') {
        translationIntents.set(userId, { flow: 'voice', stage: 'voice', language: intent.language });
        await ctx.reply('Выберите голос для озвучки:', {
          reply_markup: voiceChoiceKeyboard(intent.language).reply_markup,
        });
        return;
      }
    }

    if (intent.stage === 'engine') {
      translationIntents.set(userId, { flow: 'translate', stage: 'direction' });
      await ctx.reply('Выберите направление перевода:', {
        reply_markup: translateDirectionKeyboard.reply_markup,
      });
      return;
    }

    if (intent.stage === 'voice') {
      translationIntents.set(userId, { flow: 'voice', stage: 'language' });
      await ctx.reply('Выберите язык оригинального ролика:', {
        reply_markup: voiceLanguageKeyboard.reply_markup,
      });
      return;
    }

    if (intent.stage === 'language' || intent.stage === 'direction') {
      await cancelFlow(ctx);
      return;
    }

    await cancelFlow(ctx);
  });

  // Arena publishing functionality is temporarily disabled
  // bot.action(/publish:([a-f0-9]+)/i, async (ctx) => {
  //   const token = ctx.match && ctx.match[1];
  //   await ctx.answerCbQuery();
  //   if (!token) {
  //     await ctx.reply('Кнопка устарела. Попробуйте скачать ролик заново.');
  //     return;
  //   }
  //   if (!ctx.from?.id) {
  //     await ctx.reply('Не удалось определить пользователя.');
  //     return;
  //   }
  //   const subscribed = await ensureArenaSubscription(ctx);
  //   if (!subscribed) {
  //     return;
  //   }
  //   const result = await publishCandidateToken(token, ctx.telegram, ctx.from);
  //   if (result.ok) {
  //     await ctx.reply(`📣 Видео отправлено в ${getArenaDisplayName()}!`);
  //   } else {
  //     let errorMessage = '⚠️ Не удалось опубликовать видео. Попробуйте ещё раз.';
  //     if (result.reason === 'disabled') {
  //       errorMessage = '⚙️ Публикация временно отключена. Сообщите администратору.';
  //     } else if (result.reason === 'not_found') {
  //       errorMessage = '⚠️ Видео больше недоступно. Скачайте его снова.';
  //     } else if (result.reason === 'forbidden') {
  //       errorMessage = '❌ Эту кнопку может использовать только автор скачанного ролика.';
  //     }
  //     await ctx.reply(errorMessage);
  //   }
  // });

  bot.on('text', async (ctx) => {
    const text = ctx.message?.text;
    const userId = ctx.from?.id;

    if (text && text.startsWith('/')) {
      return;
    }

     // Arena publishing functionality is temporarily disabled
     // const awaitingArenaLink = userId ? arenaPublishRequests.has(userId) : false;
     // if (awaitingArenaLink) {
     //   if (text && text.startsWith('http')) {
     //     arenaPublishRequests.delete(userId!);
     //     translationIntents.delete(userId!);
     //     const publishState = ctx.state as { publishToArena?: boolean };
     //     publishState.publishToArena = true;
     //     await ctx.reply('📣 Публикация включена. Скачиваю ролик и загружу его в канал.', {
     //       reply_markup: mainKeyboard.reply_markup,
     //     });
     //   } else {
     //     await ctx.reply('Пожалуйста, пришлите ссылку на ролик или нажмите Отмена.', {
     //       reply_markup: linkPromptKeyboard.reply_markup,
     //     });
     //     return;
     //   }
     // }

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
            reply_markup: translateDirectionKeyboard.reply_markup,
          });
          return;
        }
        if (intent.stage === 'engine') {
          await ctx.reply('Сначала выберите тип перевода.', {
            reply_markup: translateEngineKeyboard.reply_markup,
          });
          return;
        }
        if (intent.stage === 'language') {
          await ctx.reply('Сначала выберите язык ролика.', {
            reply_markup: voiceLanguageKeyboard.reply_markup,
          });
          return;
        }
        if (intent.stage === 'voice') {
          await ctx.reply('Сначала выберите голос для озвучки.', {
            reply_markup: voiceChoiceKeyboard(intent.language).reply_markup,
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
          reply_markup: translateDirectionKeyboard.reply_markup,
        });
        return;
      }
      if (intent.stage === 'engine') {
        await ctx.reply('Выберите тип перевода:', {
          reply_markup: translateEngineKeyboard.reply_markup,
        });
        return;
      }
      if (intent.stage === 'voice') {
        await ctx.reply('Выберите голос для озвучки:', {
          reply_markup: voiceChoiceKeyboard(intent.language).reply_markup,
        });
        return;
      }
      if (intent.stage === 'language') {
        await ctx.reply('Выберите язык оригинального ролика:', {
          reply_markup: voiceLanguageKeyboard.reply_markup,
        });
        return;
      }
      if (intent.stage === 'ready') {
        await ctx.reply('Пожалуйста, пришлите ссылку на Instagram Reel или нажмите Отмена.', {
          reply_markup: linkPromptKeyboard.reply_markup,
        });
        return;
      }
    }

    await ctx.reply("I don't understand that message. Use /help to see available commands.");
  });

  bot.catch((err, ctx) => {
    logger.error(
      {
        error: err,
        userId: ctx.from?.id,
        username: ctx.from?.username,
        message: ctx.message && 'text' in ctx.message ? ctx.message.text : 'unknown',
      },
      'Bot error'
    );

    const messageText = ctx.message && 'text' in ctx.message ? ctx.message.text : undefined;
    const commandToken = messageText && messageText.startsWith('/') ? messageText.split(' ')[0] : undefined;
    trackUserEvent('bot.error', ctx.from?.id, {
      error: err instanceof Error ? err.message : String(err),
      command: commandToken,
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
  trackSystemEvent('bot.started', { transport: 'polling' });
}

export async function configureWebhook(publicUrl: string): Promise<void> {
  await ensureTempDir();
  await setupBot();
  await logToolVersions();
  const base = publicUrl.replace(/\/$/, '');
  await bot.telegram.setWebhook(`${base}/bot`);
  ensureSignals();
  logger.info({ webhookUrl: `${base}/bot` }, 'Webhook configured');
  trackSystemEvent('bot.webhook_configured', { webhookUrl: `${base}/bot` });
}
