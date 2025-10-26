import { Context, Markup } from 'telegraf';
import { detectProvider, getProvider } from '../../providers';
import { rateLimiter } from '../../core/rateLimit';
import { makeSessionDir, safeRemove } from '../../core/fs';
import { ensureBelowLimit } from '../../core/size';
import { toUserMessage, AppError } from '../../core/errors';
import { logger } from '../../core/logger';
import * as path from 'path';
import {
  getArenaDisplayName,
  isArenaPublishingEnabled,
  publishFileDirectlyToArena,
  registerPublishCandidate,
} from '../publish';

export async function downloadCommand(ctx: Context): Promise<void> {
  const userId = ctx.from?.id;
  const username = ctx.from?.username;
  
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
    const providerName = detectProvider(url);
    if (!providerName) {
      await ctx.reply('❌ Unsupported video provider. Supported platforms: Facebook, Instagram, LinkedIn, YouTube, TikTok, Sora.');
      return;
    }

    // Send initial message
    const processingMessage = await ctx.reply('⏳ Download started... This may take a few minutes.');

    // Create session directory
    const sessionDir = await makeSessionDir();

    try {
      // Download video
      const provider = getProvider(providerName);
      const result = await provider.download(url, sessionDir);

      // Check file size
      await ensureBelowLimit(result.filePath);

      const publishState = ctx.state as { publishToArena?: boolean | undefined };
      const shouldAutoPublish = Boolean(publishState?.publishToArena);
      if (publishState && publishState.publishToArena !== undefined) {
        publishState.publishToArena = undefined;
      }

      const fileName = path.basename(result.filePath);

      if (shouldAutoPublish) {
        if (!isArenaPublishingEnabled()) {
          await ctx.reply('⚙️ Публикация в канал временно недоступна. Попробуйте позже.');
        } else {
          const published = await publishFileDirectlyToArena({
            filePath: result.filePath,
            fileName,
            originalUrl: url,
            telegram: ctx.telegram,
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
      const sentMessage = await ctx.replyWithDocument(
        { source: result.filePath, filename: fileName },
        {
          reply_parameters: {
            message_id: processingMessage.message_id,
          },
        }
      );

      logger.info('Video sent successfully', {
        userId,
        url,
        filePath: result.filePath,
        videoInfo: result.videoInfo,
      });

      if (isArenaPublishingEnabled() && userId) {
        const document = 'document' in sentMessage ? sentMessage.document : undefined;
        const fileId = document?.file_id;
        if (fileId) {
          const token = registerPublishCandidate({
            ownerId: userId,
            fileId,
            fileName,
            originalUrl: url,
          });

          await ctx.reply(
            'Хочешь поделиться роликом в Reels Arena?',
            Markup.inlineKeyboard([[Markup.button.callback('📣 Опубликовать в канал', `publish:${token}`)]])
          );
        } else {
          logger.warn(
            { userId, url },
            'Unable to register publish candidate because document file_id is missing'
          );
        }
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
