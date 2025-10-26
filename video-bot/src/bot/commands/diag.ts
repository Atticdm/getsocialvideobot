import { Context } from 'telegraf';
import { detectProvider } from '../../providers';
import { logger } from '../../core/logger';
import { run } from '../../core/exec';
import { config } from '../../core/config';
import { trackUserEvent } from '../../core/analytics';

function sanitize(text: string, max = 1500): string {
  return (text || '').replace(/[`]/g, '\u0060').slice(0, max);
}

export async function diagCommand(ctx: Context): Promise<void> {
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const parts = text.split(' ').slice(1);
  const url = parts[0];
  if (!url) {
    await ctx.reply('Usage: /diag <url>');
    return;
  }

  const provider = detectProvider(url) || 'unknown';
  await ctx.reply(`🔎 Diagnosing...\nProvider: ${provider}`);
  trackUserEvent('command.diag', ctx.from?.id, {
    provider,
    hasUrl: Boolean(url),
  });

  try {
    // Build base args for probing without download
    const base = ['-v', '--dump-json', '--simulate', '--no-playlist', '-4'];
    if (config.GEO_BYPASS_COUNTRY) base.push('--geo-bypass-country', config.GEO_BYPASS_COUNTRY);

    // First attempt: as-is
    const args1 = [...base, url];
    logger.debug('diag yt-dlp args #1', { args: args1 });
    const r1 = await run('yt-dlp', args1, { timeout: 20000 });

    if (r1.code === 0) {
      await ctx.reply(`✅ Extracted as-is\n\n${sanitize(r1.stdout, 1800)}`);
      return;
    }

    // Second attempt: try mobile referer and UA
    const args2 = ['-v', '--dump-json', '--simulate', '--no-playlist', '-4',
      '--add-header', 'Referer:https://m.facebook.com/',
      '--user-agent', 'Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
      url];
    if (config.GEO_BYPASS_COUNTRY) args2.splice(args2.length - 1, 0, '--geo-bypass-country', config.GEO_BYPASS_COUNTRY);
    logger.debug('diag yt-dlp args #2', { args: args2 });
    const r2 = await run('yt-dlp', args2, { timeout: 20000 });

    if (r2.code === 0) {
      await ctx.reply(`✅ Extracted with Android UA\n\n${sanitize(r2.stdout, 1800)}`);
      return;
    }

    await ctx.reply(`❌ Extraction failed\n\n#1 stderr:\n${sanitize(r1.stderr)}\n\n#2 stderr:\n${sanitize(r2.stderr)}`);
  } catch (e) {
    logger.error('diag failed', { error: e });
    trackUserEvent('command.diag.error', ctx.from?.id, {
      provider,
      error: e instanceof Error ? e.message : String(e),
    });
    await ctx.reply('❌ Diag failed');
  }
}
