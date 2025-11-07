import { Context } from 'telegraf';
import { run } from '../../core/exec';
import { getFreeDiskSpace } from '../../core/fs';
import { logger } from '../../core/logger';
import { config } from '../../core/config';
import { trackUserEvent } from '../../core/analytics';
import * as path from 'path';
import * as fs from 'fs-extra';

async function getGitCommit(): Promise<string> {
  try {
    // Try to find git directory - check common locations
    const possibleGitDirs = [
      path.join(__dirname, '../../../../.git'),
      path.join(__dirname, '../../../.git'),
      path.join(process.cwd(), '.git'),
      '/opt/getsocialvideobot/.git',
    ];

    let gitDir: string | null = null;
    for (const dir of possibleGitDirs) {
      try {
        if (await fs.pathExists(dir)) {
          gitDir = dir;
          break;
        }
      } catch {
        // Continue searching
      }
    }

    if (!gitDir) {
      return 'N/A (not a git repo)';
    }

    // Get current commit hash
    const commitResult = await run('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: path.dirname(gitDir),
      timeout: 5000,
    });

    if (commitResult.code !== 0) {
      return 'N/A (git error)';
    }

    const commitHash = commitResult.stdout.trim();

    // Try to get commit message (first line)
    const logResult = await run('git', ['log', '-1', '--pretty=format:%s'], {
      cwd: path.dirname(gitDir),
      timeout: 5000,
    });

    const commitMessage = logResult.code === 0 ? logResult.stdout.trim().slice(0, 50) : '';

    return commitMessage ? `${commitHash} (${commitMessage})` : commitHash;
  } catch (error) {
    logger.warn('Failed to get git commit info', { error });
    return 'N/A';
  }
}

export async function statusCommand(ctx: Context): Promise<void> {
  try {
    const userId = ctx.from?.id;
    const username = ctx.from?.username;
    
    logger.info('Status command received', { userId, username });
    trackUserEvent('command.status', userId, { username });
    
    const version = process.env['npm_package_version'] || '1.0.0';
    const uptime = formatUptime(process.uptime());
    const gitCommit = await getGitCommit();
    
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
**Git commit:** \`${gitCommit}\`
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
