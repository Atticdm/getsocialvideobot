import { Context } from 'telegraf';
import { logger } from '../../core/logger';
import { trackUserEvent } from '../../core/analytics';

export async function helpCommand(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id;
    const username = ctx.from?.username;
    
    logger.info('Help command received', { userId, username });
    trackUserEvent('command.help', userId, { username });
    
    const message = `📖 Справка

Команды:
/start — приветствие и клавиатура
/help — эта подсказка
/status — служебная информация (версия, yt-dlp, ffmpeg, свободное место)
/download <url> — скачать оригинал (Facebook, Instagram, YouTube, TikTok, LinkedIn, Sora, ВКонтакте)
/dl <url> или /get <url> — короткие алиасы (удобно в группах)
/translate <url> [en-ru|ru-en|identity-ru|identity-en|auto] [elevenlabs|terminator-ru|terminator-en|zhirinovsky-ru|zhirinovsky-en] — перевод или переозвучка рилса (при ENABLE_REEL_TRANSLATION)
/credits — показать баланс кредитов
/buy — купить пакет кредитов для переводов и озвучки
/promo <код> — активировать промокод для получения бесплатных кредитов или безлимитного доступа
/terms — условия использования бота
/support — помощь и поддержка
// Arena publishing functionality is temporarily disabled
// /publish — включить режим «отправить ссылку и сразу опубликовать в канал»

Клавиатура:
⬇️ Скачать видео — получить подсказку и вернуться к обычному скачиванию
🌐 Перевести видео — выбрать направление и тип перевода (💎 ElevenLabs, 🎯 Голос Терминатора, 🎤 Голос Жириновского)
🎙 Переозвучить видео — выбрать язык оригинала и голос (Терминатор или Жириновский)
// Arena publishing functionality is temporarily disabled
// 📣 Опубликовать в канал — бот попросит ссылку и после скачивания выложит ролик в Reels Arena
⬅️ Назад — вернуться на предыдущий шаг
Отмена / /cancel — выйти из текущего режима

Просто отправьте ссылку без кнопок, чтобы получить оригинальное видео.

Использование в группах:
/download@getsocialvideobot <url>
или
/dl@getsocialvideobot <url>`;

    await ctx.reply(message);
  } catch (error) {
    logger.error('Error in help command', { error, userId: ctx.from?.id });
    trackUserEvent('command.help.error', ctx.from?.id, {
      error: error instanceof Error ? error.message : String(error),
    });
    await ctx.reply('Sorry, something went wrong. Please try again.');
  }
}
