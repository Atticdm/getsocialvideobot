import { Context, Markup } from 'telegraf';
import { detectProvider, getProvider } from '../../providers';
import type { ProviderName } from '../../providers';
import { rateLimiter } from '../../core/rateLimit';
import { makeSessionDir, safeRemove } from '../../core/fs';
import { ensureBelowLimit } from '../../core/size';
import { toUserMessage, AppError } from '../../core/errors';
import { logger } from '../../core/logger';
import { trackUserEvent } from '../../core/analytics';
import * as path from 'path';
import * as fs from 'fs-extra';
import type { Message } from 'telegraf/typings/core/types/typegram';
import {
  getArenaDisplayName,
  isArenaPublishingEnabled,
  publishFileDirectlyToArena,
  registerPublishCandidate,
} from '../publish';
import {
  deleteCachedFile,
  getCachedFile,
  normalizeCacheUrl,
  setCachedFile,
  type CachedFileRecord,
} from '../../core/fileCache';

type TelegramUploadType = 'document' | 'video';

interface UploadOptions {
  chatId: number;
  filePath: string;
  fileName: string;
  replyToMessageId?: number;
  type: TelegramUploadType;
}

interface UploadResult {
  message: Message.DocumentMessage | Message.VideoMessage;
  type: TelegramUploadType;
}

async function getFileSize(filePath: string): Promise<number> {
  try {
    const stats = await fs.stat(filePath);
    return stats.size;
  } catch (error) {
    logger.warn({ error, filePath }, 'Failed to stat file for upload');
    return 0;
  }
}

async function uploadToTelegram(
  ctx: Context,
  options: UploadOptions
): Promise<Message.DocumentMessage | Message.VideoMessage> {
  const { chatId, filePath, fileName, replyToMessageId, type } = options;
  const sizeBytes = await getFileSize(filePath);
  const start = Date.now();
  const startIso = new Date(start).toISOString();
  logger.info(
    {
      chatId,
      filePath,
      fileName,
      sizeBytes,
      type,
      startedAt: startIso,
    },
    'Telegram upload started'
  );

  try {
    const result =
      type === 'video'
        ? await ctx.replyWithVideo(
            { source: filePath, filename: fileName },
            {
              supports_streaming: true,
              ...(typeof replyToMessageId === 'number'
                ? {
                    reply_parameters: {
                      message_id: replyToMessageId,
                    },
                  }
                : {}),
            }
          )
        : await ctx.replyWithDocument(
            { source: filePath, filename: fileName },
            {
              ...(typeof replyToMessageId === 'number'
                ? {
                    reply_parameters: {
                      message_id: replyToMessageId,
                    },
                  }
                : {}),
            }
          );

    const finish = Date.now();
    logger.info(
      {
        chatId,
        filePath,
        fileName,
        sizeBytes,
        type,
        startedAt: startIso,
        finishedAt: new Date(finish).toISOString(),
        durationMs: finish - start,
      },
      '✅ Telegram upload success'
    );

    return result as Message.DocumentMessage | Message.VideoMessage;
  } catch (error) {
    const finish = Date.now();
    logger.error(
      {
        chatId,
        filePath,
        fileName,
        sizeBytes,
        type,
        startedAt: startIso,
        finishedAt: new Date(finish).toISOString(),
        durationMs: finish - start,
        error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
      },
      '❌ Telegram upload failed'
    );
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      throw new AppError('ERR_TELEGRAM_TIMEOUT', 'Telegram upload timed out', {
        chatId,
        filePath,
        fileName,
        sizeBytes,
        type,
      });
    }
    throw error;
  }
}

async function sendFileWithFallback(
  ctx: Context,
  params: { filePath: string; fileName: string; replyToMessageId?: number }
): Promise<UploadResult> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    throw new AppError('ERR_TELEGRAM_UPLOAD', 'Unable to determine chat id for upload');
  }

  const baseOptions: Omit<UploadOptions, 'type'> & { type?: TelegramUploadType } = {
    chatId,
    filePath: params.filePath,
    fileName: params.fileName,
  };
  if (typeof params.replyToMessageId === 'number') {
    baseOptions.replyToMessageId = params.replyToMessageId;
  }

  try {
    const message = await uploadToTelegram(ctx, {
      ...baseOptions,
      type: 'document',
    });
    return { message: message as Message.DocumentMessage, type: 'document' };
  } catch (error) {
    logger.warn({ error }, 'Retrying Telegram upload as video');
    const message = await uploadToTelegram(ctx, {
      ...baseOptions,
      type: 'video',
    });
    return { message: message as Message.VideoMessage, type: 'video' };
  }
}

export async function downloadCommand(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username;
  let providerName: ProviderName | null = null;
  
  if (!userId) {
    await ctx.reply('User ID not found. Please try again.');
    return;
  }

  // Parse URL from command arguments
  const messageText = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const args = messageText.split(' ').slice(1);
  const url = args[0];

  if (!url) {
    await ctx.reply('Please provide a video URL.\n\nUsage: /download <video_url>\n\nSupported platforms: Facebook, Instagram, LinkedIn, YouTube, TikTok, Sora');
    return;
  }

  logger.info('Download command received', { userId, username, url });
  trackUserEvent('command.download', userId, {
    username,
    hasUrl: Boolean(url),
  });

  // Check rate limit
  const status = rateLimiter.getStatus(userId);
  if (status.active >= 3) {
    await ctx.reply('⏸️ You have too many downloads in progress. Please wait.');
    return;
  }

  // Acquire rate limit slot
  const release = await rateLimiter.acquire(userId);
  
  try {
    // Detect provider
    providerName = detectProvider(url);
    if (!providerName) {
      await ctx.reply('❌ Unsupported video provider. Supported platforms: Facebook, Instagram, LinkedIn, YouTube, TikTok, Sora.');
      return;
    }

    trackUserEvent('download.requested', userId, {
      provider: providerName,
    });

    // Send initial message
    const normalizedUrl = normalizeCacheUrl(url);

    const cachedRecord = await getCachedFile(normalizedUrl);

    const persistCache = async (
      message: Message.DocumentMessage | Message.VideoMessage | undefined,
      durationSeconds?: number,
      sizeBytes?: number
    ): Promise<void> => {
      if (!message) return;
      const document = 'document' in message ? message.document : undefined;
      const video = 'video' in message ? message.video : undefined;
      const fileId = video?.file_id ?? document?.file_id;
      const uniqueId = video?.file_unique_id ?? document?.file_unique_id;
      if (!fileId || !uniqueId) return;

      const record: CachedFileRecord = {
        fileId,
        uniqueId,
        type: video ? 'video' : 'document',
        storedAt: Date.now(),
      };
      if (providerName) {
        record.provider = providerName;
      }
      if (typeof durationSeconds === 'number') {
        record.durationSeconds = durationSeconds;
      }
      const resolvedSize =
        typeof sizeBytes === 'number' ? sizeBytes : video?.file_size ?? document?.file_size;
      if (typeof resolvedSize === 'number') {
        record.sizeBytes = resolvedSize;
      }
      await setCachedFile(normalizedUrl, record);
    };

    const processingMessage = await ctx.reply('⏳ Download started... This may take a few minutes.');

    // Use cached version if available and auto-publish not requested
    const publishStateBefore = ctx.state as { publishToArena?: boolean | undefined };
    const shouldAutoPublish = Boolean(publishStateBefore?.publishToArena);

    if (cachedRecord && !shouldAutoPublish) {
      try {
        const cacheStart = Date.now();
        const sentMessage = cachedRecord.type === 'video'
          ? await ctx.replyWithVideo(cachedRecord.fileId, {
              supports_streaming: true,
              reply_parameters: {
                message_id: processingMessage.message_id,
              },
            })
          : await ctx.replyWithDocument(cachedRecord.fileId, {
              reply_parameters: {
                message_id: processingMessage.message_id,
              },
            });

        const document = 'document' in sentMessage ? sentMessage.document : undefined;
        const video = 'video' in sentMessage ? sentMessage.video : undefined;
        logger.info('Video sent from cache', {
          userId,
          url,
          provider: providerName,
          fileId: video?.file_id ?? document?.file_id,
          cachedType: cachedRecord.type,
          durationMs: Date.now() - cacheStart,
        });

        trackUserEvent('download.succeeded', userId, {
          provider: providerName,
          durationSeconds: cachedRecord.durationSeconds,
          sizeBytes: cachedRecord.sizeBytes,
          cached: true,
          uploadType: cachedRecord.type,
        });

        if (publishStateBefore && publishStateBefore.publishToArena !== undefined) {
          publishStateBefore.publishToArena = undefined;
        }

        await persistCache(sentMessage as Message.DocumentMessage | Message.VideoMessage, cachedRecord.durationSeconds, cachedRecord.sizeBytes);

        const cachedFileId = video?.file_id ?? document?.file_id;
        const cachedUniqueId = video?.file_unique_id ?? document?.file_unique_id;
        if (isArenaPublishingEnabled() && userId && cachedFileId && cachedUniqueId) {
          const token = registerPublishCandidate({
            ownerId: userId,
            fileId: cachedFileId,
            fileName: document?.file_name ?? `video_${cachedUniqueId}.mp4`,
            originalUrl: url,
          });

          await ctx.reply(
            'Хочешь поделиться роликом в Reels Arena?',
            Markup.inlineKeyboard([[Markup.button.callback('📣 Опубликовать в канал', `publish:${token}`)]])
          );
          trackUserEvent('download.publish_prompt', userId, {
            provider: providerName,
            cached: true,
          });
        }

        return;
      } catch (cachedError) {
        logger.warn(
          {
            cachedError,
            url,
            userId,
            fileId: cachedRecord.fileId,
          },
          'Failed to send cached file, falling back to fresh download'
        );
        await deleteCachedFile(normalizedUrl);
      }
    }

    // Create session directory
    const sessionDir = await makeSessionDir();

    try {
      // Download video
      const provider = getProvider(providerName);
      const result = await provider.download(url, sessionDir);

      // Check file size
      await ensureBelowLimit(result.filePath);

      const publishState = ctx.state as { publishToArena?: boolean | undefined };
      const shouldAutoPublishDownload = Boolean(publishState?.publishToArena);
      if (publishState && publishState.publishToArena !== undefined) {
        publishState.publishToArena = undefined;
      }

      const fileName = path.basename(result.filePath);

      if (shouldAutoPublishDownload) {
        if (!isArenaPublishingEnabled()) {
          trackUserEvent('download.auto_publish', userId, {
            provider: providerName,
            success: false,
            reason: 'disabled',
          });
          await ctx.reply('⚙️ Публикация в канал временно недоступна. Попробуйте позже.');
        } else {
          const published = await publishFileDirectlyToArena({
            filePath: result.filePath,
            fileName,
            originalUrl: url,
            telegram: ctx.telegram,
          });
          trackUserEvent('download.auto_publish', userId, {
            provider: providerName,
            success: published,
          });
          if (published) {
            await ctx.reply(`📣 Видео опубликовано в ${getArenaDisplayName()}!`);
          } else {
            await ctx.reply('⚠️ Не удалось опубликовать видео в канал. Попробуйте позже.');
          }
        }
        return;
      }

      // Send file to user
      const uploadResult = await sendFileWithFallback(ctx, {
        filePath: result.filePath,
        fileName,
        replyToMessageId: processingMessage.message_id,
      });
      const sentMessage = uploadResult.message;

      logger.info('Video sent successfully', {
        userId,
        url,
        filePath: result.filePath,
        videoInfo: result.videoInfo,
        uploadType: uploadResult.type,
      });

      trackUserEvent('download.succeeded', userId, {
        provider: providerName,
        durationSeconds: result.videoInfo?.duration,
        sizeBytes: result.videoInfo?.size,
        cached: false,
        uploadType: uploadResult.type,
      });

      if (isArenaPublishingEnabled() && userId) {
        const document = 'document' in sentMessage ? sentMessage.document : undefined;
        const video = 'video' in sentMessage ? sentMessage.video : undefined;
        const fileId = video?.file_id ?? document?.file_id;
        if (fileId) {
          await persistCache(sentMessage as Message.DocumentMessage | Message.VideoMessage, result.videoInfo?.duration, result.videoInfo?.size ?? video?.file_size ?? document?.file_size);

          const token = registerPublishCandidate({
            ownerId: userId,
            fileId,
            fileName,
            fileType: uploadResult.type,
            originalUrl: url,
          });

          await ctx.reply(
            'Хочешь поделиться роликом в Reels Arena?',
            Markup.inlineKeyboard([[Markup.button.callback('📣 Опубликовать в канал', `publish:${token}`)]])
          );
          trackUserEvent('download.publish_prompt', userId, {
            provider: providerName,
            uploadType: uploadResult.type,
          });
        } else {
          logger.warn(
            { userId, url },
            'Unable to register publish candidate because document file_id is missing'
          );
        }
      } else {
        await persistCache(sentMessage as Message.DocumentMessage | Message.VideoMessage, result.videoInfo?.duration, result.videoInfo?.size);
      }

    } finally {
      // Clean up session directory
      await safeRemove(sessionDir);
    }

  } catch (error) {
    logger.error('Download failed', { 
      error, 
      userId, 
      username, 
      url 
    });
    trackUserEvent('download.failed', userId, {
      provider: providerName || 'unknown',
      error: error instanceof AppError ? error.code : error instanceof Error ? error.message : String(error),
    });

    let errorMessage: string;
    if (error instanceof AppError) {
      errorMessage = toUserMessage(error);
    } else {
      errorMessage = '❌ Download failed: Unknown error';
    }

    await ctx.reply(errorMessage);
  } finally {
    // Release rate limit slot
    release();
  }
}
