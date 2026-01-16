import { Context } from 'telegraf';
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
// Arena publishing functionality is temporarily disabled
// import { isArenaPublishingEnabled } from '../publish';
import {
  deleteCachedFile,
  getCachedFile,
  normalizeCacheUrl,
  setCachedFile,
  type CachedFileRecord,
} from '../../core/fileCache';
import { generateVideoThumbnail } from '../../core/media';
import { createReadStream } from 'fs';
import type { VideoInfo } from '../../providers/types';

const VIDEO_MIME_TYPES = new Map<string, string>([
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  ['.mkv', 'video/x-matroska'],
  ['.avi', 'video/x-msvideo'],
]);

function getMimeType(filePath: string): string | undefined {
  const ext = path.extname(filePath || '').toLowerCase();
  return VIDEO_MIME_TYPES.get(ext);
}

function isVideoFile(filePath: string): boolean {
  return Boolean(getMimeType(filePath));
}

function buildInputFile(filePath: string, fileName: string): any {
  const mimeType = getMimeType(filePath);
  const source = createReadStream(filePath);
  return mimeType
    ? { source, filename: fileName, contentType: mimeType }
    : { source, filename: fileName };
}

async function maybeCreateThumbnail(filePath: string): Promise<string | undefined> {
  if (!isVideoFile(filePath)) return undefined;
  const thumbnailPath = `${filePath}.thumb.jpg`;
  try {
    await generateVideoThumbnail(filePath, thumbnailPath);
    return thumbnailPath;
  } catch (error) {
    logger.warn({ error, filePath }, 'Failed to generate thumbnail for Telegram upload');
    await safeRemove(thumbnailPath);
    return undefined;
  }
}

type TelegramUploadType = 'document' | 'video';

interface UploadOptions {
  chatId: number;
  filePath: string;
  fileName: string;
  replyToMessageId?: number;
  type: TelegramUploadType;
  thumbnailPath?: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
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
  const { chatId, filePath, fileName, replyToMessageId, type, thumbnailPath, width, height, durationSeconds } = options;
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
    const replyParameters =
      typeof replyToMessageId === 'number'
        ? {
            reply_parameters: {
              message_id: replyToMessageId,
            },
          }
        : {};

    const inputFile = buildInputFile(filePath, fileName);

    const result =
      type === 'video'
        ? await ctx.replyWithVideo(inputFile, {
            supports_streaming: true,
            ...(typeof width === 'number' ? { width: Math.round(width) } : {}),
            ...(typeof height === 'number' ? { height: Math.round(height) } : {}),
            ...(typeof durationSeconds === 'number'
              ? { duration: Math.max(1, Math.round(durationSeconds)) }
              : {}),
            ...replyParameters,
          })
        : await ctx.replyWithDocument(
            inputFile,
            {
              ...(thumbnailPath ? { thumbnail: { source: createReadStream(thumbnailPath) } } : {}),
              ...replyParameters,
            } as any
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
  params: { filePath: string; fileName: string; replyToMessageId?: number; videoInfo?: VideoInfo }
): Promise<UploadResult> {
  const chatId = ctx.chat?.id;
  if (!chatId) {
    throw new AppError('ERR_TELEGRAM_UPLOAD', 'Unable to determine chat id for upload');
  }

  const baseOptions: Omit<UploadOptions, 'type' | 'thumbnailPath' | 'width' | 'height' | 'durationSeconds'> = {
    chatId,
    filePath: params.filePath,
    fileName: params.fileName,
  };
  if (typeof params.replyToMessageId === 'number') {
    baseOptions.replyToMessageId = params.replyToMessageId;
  }

  const videoOptions: UploadOptions = {
    ...baseOptions,
    type: 'video',
  };
  if (typeof params.videoInfo?.width === 'number') {
    videoOptions.width = params.videoInfo.width;
  }
  if (typeof params.videoInfo?.height === 'number') {
    videoOptions.height = params.videoInfo.height;
  }
  if (typeof params.videoInfo?.duration === 'number') {
    videoOptions.durationSeconds = params.videoInfo.duration;
  }

  let thumbnailPath: string | undefined;
  try {
    const message = await uploadToTelegram(ctx, {
      ...videoOptions,
    });
    return { message: message as Message.VideoMessage, type: 'video' };
  } catch (error) {
    logger.warn({ error }, 'Video upload failed, retrying as document');
    thumbnailPath = await maybeCreateThumbnail(baseOptions.filePath);
    const message = await uploadToTelegram(ctx, {
      ...baseOptions,
      type: 'document',
      ...(thumbnailPath ? { thumbnailPath } : {}),
    });
    return { message: message as Message.DocumentMessage, type: 'document' };
  } finally {
    if (thumbnailPath) {
      await safeRemove(thumbnailPath);
    }
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
    await ctx.reply('Please provide a video URL.\n\nUsage: /download <video_url>\n\nSupported platforms: Facebook, Instagram, LinkedIn, YouTube, TikTok, Sora, VK');
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
      await ctx.reply('❌ Unsupported video provider. Supported platforms: Facebook, Instagram, LinkedIn, YouTube, TikTok, Sora, VK.');
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

    // Arena publishing functionality is temporarily disabled
    // Use cached version if available and auto-publish not requested
    // const publishStateBefore = ctx.state as { publishToArena?: boolean | undefined };
    // if (publishStateBefore && publishStateBefore.publishToArena !== undefined) {
    //   publishStateBefore.publishToArena = undefined;
    // }

    if (cachedRecord) {
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

        // Arena publishing disabled
        // if (publishStateBefore && publishStateBefore.publishToArena !== undefined) {
        //   publishStateBefore.publishToArena = undefined;
        // }

        await persistCache(sentMessage as Message.DocumentMessage | Message.VideoMessage, cachedRecord.durationSeconds, cachedRecord.sizeBytes);

        // const cachedFileId = video?.file_id ?? document?.file_id;
        // const cachedUniqueId = video?.file_unique_id ?? document?.file_unique_id;
        // if (isArenaPublishingEnabled() && userId && cachedFileId && cachedUniqueId) {
        //   const token = registerPublishCandidate({
        //     ownerId: userId,
        //     fileId: cachedFileId,
        //     fileName: document?.file_name ?? `video_${cachedUniqueId}.mp4`,
        //     originalUrl: url,
        //   });

        //   await ctx.reply(
        //     'Хочешь поделиться роликом в Reels Arena?',
        //     Markup.inlineKeyboard([[Markup.button.callback('📣 Опубликовать в канал', `publish:${token}`)]])
        //   );
        //   trackUserEvent('download.publish_prompt', userId, {
        //     provider: providerName,
        //     cached: true,
        //   });
        // }

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

      // Arena publishing functionality is temporarily disabled
      // const publishState = ctx.state as { publishToArena?: boolean | undefined };
      // if (publishState && publishState.publishToArena !== undefined) {
      //   publishState.publishToArena = undefined;
      // }

      const fileName = path.basename(result.filePath);

      // if (shouldAutoPublishDownload) {
      //   if (!isArenaPublishingEnabled()) {
      //     trackUserEvent('download.auto_publish', userId, {
      //       provider: providerName,
      //       success: false,
      //       reason: 'disabled',
      //     });
      //     await ctx.reply('⚙️ Публикация в канал временно недоступна. Попробуйте позже.');
      //   } else {
      //     const published = await publishFileDirectlyToArena({
      //       filePath: result.filePath,
      //       fileName,
      //       originalUrl: url,
      //       telegram: ctx.telegram,
      //     });
      //     trackUserEvent('download.auto_publish', userId, {
      //       provider: providerName,
      //       success: published,
      //     });
      //     if (published) {
      //       await ctx.reply(`📣 Видео опубликовано в ${getArenaDisplayName()}!`);
      //     } else {
      //       await ctx.reply('⚠️ Не удалось опубликовать видео в канал. Попробуйте позже.');
      //     }
      //   }
      //   return;
      // }

      // Send file to user
      const uploadResult = await sendFileWithFallback(ctx, {
        filePath: result.filePath,
        fileName,
        replyToMessageId: processingMessage.message_id,
        videoInfo: result.videoInfo,
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

      // Arena publishing functionality is temporarily disabled
      // if (isArenaPublishingEnabled() && userId) {
      //   const document = 'document' in sentMessage ? sentMessage.document : undefined;
      //   const video = 'video' in sentMessage ? sentMessage.video : undefined;
      //   const fileId = video?.file_id ?? document?.file_id;
      //   if (fileId) {
      //     await persistCache(sentMessage as Message.DocumentMessage | Message.VideoMessage, result.videoInfo?.duration, result.videoInfo?.size ?? video?.file_size ?? document?.file_size);

      //     // const token = registerPublishCandidate({
      //     //   ownerId: userId,
      //     //   fileId,
      //     //   fileName,
      //     //   fileType: uploadResult.type,
      //     //   originalUrl: url,
      //     // });

      //     // await ctx.reply(
      //     //   'Хочешь поделиться роликом в Reels Arena?',
      //     //   Markup.inlineKeyboard([[Markup.button.callback('📣 Опубликовать в канал', `publish:${token}`)]])
      //     // );
      //     // trackUserEvent('download.publish_prompt', userId, {
      //     //   provider: providerName,
      //     //   uploadType: uploadResult.type,
      //     // });
      //   } else {
      //     logger.warn(
      //       { userId, url },
      //       'Unable to register publish candidate because document file_id is missing'
      //     );
      //   }
      // } else {
      //   await persistCache(sentMessage as Message.DocumentMessage | Message.VideoMessage, result.videoInfo?.duration, result.videoInfo?.size);
      // }
      
      // Сохранение в кеш - не критично, если файл уже отправлен
      try {
        await persistCache(sentMessage as Message.DocumentMessage | Message.VideoMessage, result.videoInfo?.duration, result.videoInfo?.size);
      } catch (cacheError) {
        logger.warn('Failed to persist cache after successful download', { 
          error: cacheError, 
          userId, 
          url,
          filePath: result.filePath 
        });
        // Не пробрасываем ошибку - файл уже успешно отправлен
      }

    } finally {
      // Clean up session directory - ошибки при очистке не критичны
      try {
        await safeRemove(sessionDir);
      } catch (cleanupError) {
        logger.warn('Failed to cleanup session directory', { 
          error: cleanupError, 
          userId, 
          url,
          sessionDir 
        });
        // Не пробрасываем ошибку - файл уже успешно отправлен
      }
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

    // Проверяем, является ли ошибка ошибкой 403 "bot was blocked by the user"
    const isBlockedError = error && typeof error === 'object' && 'response' in error && 
      typeof (error as any).response === 'object' &&
      (error as any).response?.error_code === 403 &&
      typeof (error as any).response?.description === 'string' &&
      (error as any).response.description.includes('bot was blocked by the user');

    if (!isBlockedError) {
      try {
        await ctx.reply(errorMessage);
      } catch (replyError) {
        logger.error({ error: replyError, originalError: error, userId }, 'Failed to send error message in download command');
      }
    } else {
      logger.warn({ userId }, 'User blocked the bot, skipping error message in download command');
    }
  } finally {
    // Release rate limit slot
    release();
  }
}
