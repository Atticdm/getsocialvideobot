import { Context } from 'telegraf';
import { config } from '../../core/config';
import { rateLimiter } from '../../core/rateLimit';
import { makeSessionDir, safeRemove } from '../../core/fs';
import { ensureBelowLimit } from '../../core/size';
import { translateInstagramReel } from '../../workflows/reelTranslate';
import {
  TranslationDirection,
  TranslationEngine,
  TranslationMode,
  TranslationOptions,
  TranslationStage,
} from '../../types/translation';
import { AppError, toUserMessage } from '../../core/errors';
import { logger } from '../../core/logger';
import * as path from 'path';
import { translationIntents } from '../telegraf';
import { mainKeyboard } from '../../ui/keyboard';
import { VoicePreset } from '../../types/voice';

const stageLabels: Record<TranslationStage['name'], string> = {
  download: 'Скачиваю видео',
  separate: 'Разделяю голос и музыку (LALAL.AI)',
  'analyze-audio': 'Анализирую голос и паузы',
  transcribe: 'Распознаю речь (Whisper)',
  translate: 'Перевожу текст (ChatGPT)',
  synthesize: 'Озвучиваю перевод (Hume)',
  'elevenlabs-dub': 'Озвучиваю через ElevenLabs',
  mux: 'Собираю видео с новой озвучкой',
  'select-voice': 'Выбираю голос Терминатора',
};

function parseDirection(token?: string): TranslationDirection {
  if (!token) return 'auto';
  const normalized = token.trim().toLowerCase();
  if (normalized === 'en-ru' || normalized === 'enru' || normalized === 'en_ru') return 'en-ru';
  if (normalized === 'ru-en' || normalized === 'ruen' || normalized === 'ru_en') return 'ru-en';
  if (normalized === 'identity-ru' || normalized === 'dubbing-ru') return 'identity-ru';
  if (normalized === 'identity-en' || normalized === 'dubbing-en') return 'identity-en';
  if (normalized === 'auto') return 'auto';
  return 'auto';
}

function deriveMode(direction: TranslationDirection): TranslationMode {
  return direction === 'identity-ru' || direction === 'identity-en' ? 'dubbing' : 'translate';
}

function normalizeVoicePresetToken(token?: string, direction?: TranslationDirection): VoicePreset['id'] | undefined {
  if (!token) return undefined;
  const normalized = token.trim().toLowerCase();
  if (normalized === 'terminator' || normalized === 'terminator-ru') return 'terminator-ru';
  if (normalized === 'terminator-en') return 'terminator-en';
  if (normalized === 'terminator-auto') {
    if (direction === 'ru-en' || direction === 'identity-en') return 'terminator-en';
    return 'terminator-ru';
  }
  return undefined;
}

function parseEngineAndVoice(
  token: string | undefined,
  direction: TranslationDirection
): { engine: TranslationEngine; voicePreset?: VoicePreset['id'] } {
  const voicePreset = normalizeVoicePresetToken(token, direction);
  if (voicePreset) {
    return { engine: 'elevenlabs', voicePreset };
  }

  if (!token) {
    return { engine: 'hume' };
  }

  const normalized = token.trim().toLowerCase();
  if (normalized.startsWith('eleven') || normalized.includes('elevenlabs')) {
    return { engine: 'elevenlabs' };
  }
  if (normalized === 'hume' || normalized === 'fast') {
    return { engine: 'hume' };
  }
  if (normalized === 'terminator') {
    const preset =
      direction === 'ru-en' || direction === 'identity-en' ? 'terminator-en' : ('terminator-ru' as VoicePreset['id']);
    return { engine: 'elevenlabs', voicePreset: preset };
  }
  return { engine: 'hume' };
}

function describeVoice(preset?: VoicePreset['id']): string | undefined {
  if (!preset) return undefined;
  if (preset === 'terminator-ru') return 'Terminator (RU)';
  if (preset === 'terminator-en') return 'Terminator (EN)';
  return preset;
}

export async function translateCommand(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username;

  if (!config.ENABLE_REEL_TRANSLATION) {
    await ctx.reply('⚙️ Функция перевода рилсов пока отключена. Установите ENABLE_REEL_TRANSLATION=1, чтобы включить её.');
    return;
  }

  if (!userId) {
    await ctx.reply('Не удалось определить пользователя. Попробуйте ещё раз.');
    return;
  }

  const messageText = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const args = messageText.split(' ').slice(1).filter(Boolean);
  const url = args[0];
  const direction = parseDirection(args[1]);
  const { engine, voicePreset } = parseEngineAndVoice(args[2], direction);
  const mode = deriveMode(direction);

  if (!url) {
    await ctx.reply(
      'Использование: /translate <ссылка на рилс> [en-ru|ru-en|identity-ru|identity-en|auto] [hume|elevenlabs|terminator-ru|terminator-en]'
    );
    return;
  }

  const options: TranslationOptions = {
    direction,
    engine,
    mode,
    ...(voicePreset ? { voicePreset } : {}),
  };

  logger.info('Translate command received', {
    userId,
    username,
    url,
    direction,
    engine,
    mode,
    voicePreset,
  });

  const status = rateLimiter.getStatus(userId);
  if (status.active >= 2) {
    await ctx.reply('⏸️ Слишком много активных переводов. Дождитесь завершения текущих задач.');
    return;
  }

  const release = await rateLimiter.acquire(userId);

  const chatId = ctx.chat?.id;
  let statusMessageId: number | undefined;
  const progressLines: string[] = [];

  const appendProgress = async (line: string) => {
    progressLines.push(line);
    if (!chatId || statusMessageId === undefined) return;
    try {
      await ctx.telegram.editMessageText(chatId, statusMessageId, undefined, `🌐 Перевод рилса\n\n${progressLines.join('\n')}`);
    } catch (error) {
      logger.warn('Failed to edit translation status message', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  try {
    const statusMessage = await ctx.reply('🌐 Перевод рилса запущен...');
    statusMessageId = statusMessage.message_id;

    const sessionDir = await makeSessionDir();

    try {
      const stageObserver = async (stage: TranslationStage) => {
        const label = stageLabels[stage.name] || stage.name;
        const icon = stage.error ? '❌' : '✅';
        await appendProgress(`${icon} ${label}`);
      };

      const result = await translateInstagramReel(
        url,
        sessionDir,
        options,
        stageObserver
      );

      await ensureBelowLimit(result.videoPath);

      const fileName = path.basename(result.videoPath);
      await ctx.replyWithDocument(
        { source: result.videoPath, filename: fileName },
        statusMessageId
          ? {
              reply_parameters: {
                message_id: statusMessageId,
              },
            }
          : undefined
      );

      if (statusMessageId) {
        await appendProgress('🎉 Готово!');
        const voiceDescription = describeVoice(result.voicePreset);
        if (voiceDescription) {
          await appendProgress(`🎙 Голос: ${voiceDescription}`);
        }
      }
    } finally {
      await safeRemove(sessionDir);
    }
  } catch (error) {
    const appError = error instanceof AppError ? error : undefined;
    const rawCause = appError && appError.details && typeof appError.details === 'object' && 'cause' in appError.details
      ? (appError.details as Record<string, unknown>)['cause']
      : undefined;

    logger.error(
      {
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
        errorCode: appError?.code,
        errorDetails: appError?.details,
        causeMessage: rawCause instanceof Error ? rawCause.message : rawCause && typeof rawCause === 'object' && 'message' in rawCause ? (rawCause as any).message : undefined,
        causeStack: rawCause instanceof Error ? rawCause.stack : undefined,
        userId,
        username,
        url,
      },
      'Translation command failed'
    );

    let message: string;
    if (error instanceof AppError) {
      message = toUserMessage(error);
    } else {
      message = '❌ Не удалось выполнить перевод. Попробуйте позже.';
    }

    await ctx.reply(message);
  } finally {
    release();
    translationIntents.delete(userId);
    await ctx.reply('Готово. Выберите дальнейшее действие.', {
      reply_markup: mainKeyboard.reply_markup,
    });
  }
}
