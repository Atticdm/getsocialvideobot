import type { Telegraf, Context } from 'telegraf';
import type { InlineQueryResultArticle, Update } from 'telegraf/typings/core/types/typegram';
import { detectProvider, getProvider } from '../../providers';
import { logger } from '../../core/logger';
import { makeSessionDir, safeRemove } from '../../core/fs';
import { ensureBelowLimit } from '../../core/size';
import { config } from '../../core/config';
import * as path from 'path';

const INLINE_ID_PREFIX = 'dl_';
const inlinePayloads = new Map<string, { url: string }>();

function encodePayload(payload: { url: string }): string {
  const raw = Buffer.from(JSON.stringify(payload), 'utf-8')
    .toString('base64')
    .replace(/[^a-zA-Z0-9]/g, '');
  const id = INLINE_ID_PREFIX + raw.slice(0, 48);
  inlinePayloads.set(id, payload);
  return id;
}

function decodePayload(id: string): { url: string } | null {
  if (!id.startsWith(INLINE_ID_PREFIX)) return null;
  return inlinePayloads.get(id) || null;
}

function extractUrl(text: string | undefined): string | null {
  if (!text) return null;
  const match = text.match(/https?:\/\/\S+/);
  return match ? match[0] : null;
}

type InlineCtx = Context<Update.InlineQueryUpdate>;
type ChosenCtx = Context<Update.ChosenInlineResultUpdate>;

async function handleInlineQuery(ctx: InlineCtx): Promise<void> {
  try {
    const query = ctx.inlineQuery.query?.trim() || '';
    const url = extractUrl(query);
    let results: InlineQueryResultArticle[];

    if (!url) {
      results = [
        {
          type: 'article',
          id: 'help',
          title: 'Введите ссылку на видео',
          description: 'Пример: https://www.instagram.com/reel/...',
          input_message_content: {
            message_text: '📎 Отправьте ссылку на поддерживаемое видео.',
          },
        },
      ];
    } else {
      const provider = detectProvider(url);
      if (!provider) {
        results = [
          {
            type: 'article',
            id: 'unsupported',
            title: 'Ссылка не поддерживается',
            description: 'Попробуйте Instagram, Facebook, TikTok и др.',
            input_message_content: {
              message_text: '❌ Эта ссылка не поддерживается ботом.',
            },
          },
        ];
      } else {
    results = [
      {
        type: 'article',
        id: encodePayload({ url }),
        title: 'Скачать видео',
        description: `Источник: ${provider}`,
        input_message_content: {
          message_text: `⏳ Обрабатываю ссылку…\n${url}`,
        },
      },
    ];
      }
    }

    await ctx.answerInlineQuery(results, {
      cache_time: 0,
      is_personal: true,
    });
  } catch (error) {
    logger.error({ error }, 'Inline query handling failed');
  }
}

async function handleChosenInlineResult(ctx: ChosenCtx): Promise<void> {
  const { result_id: resultId, inline_message_id: inlineMessageId, from } = ctx.chosenInlineResult;
  if (!inlineMessageId) return;

  const payload = decodePayload(resultId);
  if (!payload) {
    await ctx.telegram.editMessageText(undefined as any, undefined as any, inlineMessageId, '❌ Не удалось обработать ссылку.');
    return;
  }

  const { url } = payload;
  const providerName = detectProvider(url);
  if (!providerName) {
    await ctx.telegram.editMessageText(undefined as any, undefined as any, inlineMessageId, '❌ Ссылка не поддерживается.');
    return;
  }

  logger.info({ url, providerName, userId: from.id }, 'Inline download started');

  const sessionDir = await makeSessionDir();

  try {
    const provider = getProvider(providerName);
    const download = await provider.download(url, sessionDir);
    await ensureBelowLimit(download.filePath);

    let fileId: string | undefined;
    try {
      const sent = await ctx.telegram.sendVideo(from.id, { source: download.filePath }, { disable_notification: true });
      fileId = sent.video?.file_id;
    } catch (error) {
      logger.warn({ error, userId: from.id }, 'Failed to DM video to user');
    }

    if (fileId) {
      await ctx.telegram.editMessageMedia(
        undefined as any,
        undefined as any,
        inlineMessageId,
        {
          type: 'video',
          media: fileId,
          caption: download.videoInfo?.title || 'Видео',
        }
      );
      logger.info({ url, providerName, userId: from.id }, 'Inline download finished with cached video');
    } else {
      const httpUrl = config.PUBLIC_URL
        ? `${config.PUBLIC_URL}/tmp/${path.basename(download.filePath)}`
        : undefined;

      if (httpUrl) {
        await ctx.telegram.editMessageMedia(
          undefined as any,
          undefined as any,
          inlineMessageId,
          {
            type: 'video',
            media: httpUrl,
            caption: download.videoInfo?.title || 'Видео',
          }
        );
        logger.info({ url, providerName, userId: from.id }, 'Inline download finished via public URL');
      } else {
        await ctx.telegram.editMessageText(
          undefined as any,
          undefined as any,
          inlineMessageId,
          '📨 Видео не удалось отправить автоматически. Напишите боту в личку /start, чтобы получать файлы.'
        );
      }
    }
  } catch (error) {
    logger.error({ error, url, providerName }, 'Inline download failed');
    await ctx.telegram.editMessageText(
      undefined as any,
      undefined as any,
      inlineMessageId,
      '❌ Не удалось обработать видео. Попробуйте позже.'
    );
  } finally {
    await safeRemove(sessionDir);
  }
}

export function setupInlineHandlers(bot: Telegraf): void {
  bot.on('inline_query', handleInlineQuery);
  bot.on('chosen_inline_result', handleChosenInlineResult);
}
