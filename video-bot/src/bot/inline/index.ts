import type { Telegraf, Context } from 'telegraf';
import type { InlineQueryResultArticle, Update } from 'telegraf/typings/core/types/typegram';
import { detectProvider, getProvider } from '../../providers';
import { logger } from '../../core/logger';
import { makeSessionDir, safeRemove } from '../../core/fs';
import { ensureBelowLimit } from '../../core/size';

const INLINE_ID_PREFIX = 'download:';

function encodePayload(payload: { url: string }): string {
  return INLINE_ID_PREFIX + Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64');
}

function decodePayload(id: string): { url: string } | null {
  if (!id.startsWith(INLINE_ID_PREFIX)) return null;
  try {
    const raw = Buffer.from(id.slice(INLINE_ID_PREFIX.length), 'base64').toString('utf-8');
    const parsed = JSON.parse(raw);
    if (typeof parsed?.url === 'string') return { url: parsed.url };
  } catch (error) {
    logger.warn({ id, error }, 'Failed to decode inline payload');
  }
  return null;
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
              message_text: '⏳ Обрабатываю ссылку, подождите...',
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

    await ctx.telegram.editMessageMedia(
      undefined as any,
      undefined as any,
      inlineMessageId,
      {
        type: 'video',
        media: { source: download.filePath },
        caption: download.videoInfo?.title || 'Видео',
      }
    );

    logger.info({ url, providerName, userId: from.id }, 'Inline download finished');
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
