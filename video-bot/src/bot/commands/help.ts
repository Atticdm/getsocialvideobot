import { Context } from 'telegraf';
import { logger } from '../../core/logger';

export async function helpCommand(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id;
    const username = ctx.from?.username;
    
    logger.info('Help command received', { userId, username });
    
    const message = `📖 Справка

Команды:
/start — приветствие и клавиатура
/help — эта подсказка
/status — служебная информация (версия, yt-dlp, ffmpeg, свободное место)
/download <url> — скачать оригинал (Facebook, Instagram, YouTube, TikTok, LinkedIn, Sora)
/dl <url> или /get <url> — короткие алиасы (удобно в группах)
/translate <url> [en-ru|ru-en|identity-ru|identity-en|auto] [hume|elevenlabs|terminator-ru|terminator-en] — перевод или переозвучка рилса (при ENABLE_REEL_TRANSLATION)

Клавиатура:
🌐 Перевести видео — выбрать направление и тип перевода (🚀 Hume, 💎 ElevenLabs, 🎯 Голос Терминатора)
🎙 Озвучить видео — выбрать язык оригинала и голос Терминатора
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
    await ctx.reply('Sorry, something went wrong. Please try again.');
  }
}
