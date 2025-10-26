import { Context } from 'telegraf';
import { run } from '../../core/exec';
import { getFreeDiskSpace } from '../../core/fs';
import { logger } from '../../core/logger';
import { config } from '../../core/config';
import { trackUserEvent } from '../../core/analytics';

export async function statusCommand(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id;
    const username = ctx.from?.username;
    
    logger.info('Status command received', { userId, username });
    trackUserEvent('command.status', userId, { username });
    
    const version = process.env['npm_package_version'] || '1.0.0';
    const uptime = formatUptime(process.uptime());
    
    // Check yt-dlp
    let ytdlpStatus = '❌ Not found';
    try {
      const ytdlpResult = await run('yt-dlp', ['--version'], { timeout: 10000 });
      if (ytdlpResult.code === 0) {
        ytdlpStatus = `✅ ${ytdlpResult.stdout.trim()}`;
      }
    } catch (error) {
      logger.warn('yt-dlp check failed', { error });
    }
    
    // Check ffmpeg
    let ffmpegStatus = '❌ Not found';
    try {
      const ffmpegResult = await run('ffmpeg', ['-version'], { timeout: 10000 });
      if (ffmpegResult.code === 0) {
        const versionLine = ffmpegResult.stdout.split('\n')[0];
        ffmpegStatus = `✅ ${versionLine?.split(' ')[2] || 'Available'}`;
      }
    } catch (error) {
      logger.warn('ffmpeg check failed', { error });
    }
    
    // Get disk space
    const freeSpace = await getFreeDiskSpace();
    const freeSpaceMB = Math.round(freeSpace / (1024 * 1024));
    const diskSpace = `${freeSpaceMB} MB`;
    
    const terminatorRu = config.ELEVENLABS_TERMINATOR_VOICE_RU ? '✅' : '⚠️';
    const terminatorEn = config.ELEVENLABS_TERMINATOR_VOICE_EN ? '✅' : '⚠️';
    
    const message = `🔧 **Bot Status**

**Version:** ${version}
**yt-dlp:** ${ytdlpStatus}
**ffmpeg:** ${ffmpegStatus}
**Free disk space:** ${diskSpace}
**Uptime:** ${uptime}
**Terminator (RU voice):** ${terminatorRu}
**Terminator (EN voice):** ${terminatorEn}`;
    
    await ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('Error in status command', { error, userId: ctx.from?.id });
    trackUserEvent('command.status.error', ctx.from?.id, {
      error: error instanceof Error ? error.message : String(error),
    });
    await ctx.reply('Sorry, something went wrong while checking status.');
  }
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  
  if (days > 0) {
    return `${days}d ${hours}h ${minutes}m`;
  } else if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else {
    return `${minutes}m`;
  }
}
