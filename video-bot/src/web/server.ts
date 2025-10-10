import express from 'express';
import { createHash } from 'crypto';
import cron from 'node-cron';
import { detectProvider, getProvider } from '../providers';
import { ensureTempDir, makeSessionDir, safeRemove } from '../core/fs';
import { logger } from '../core/logger';
import { AppError, toUserMessage } from '../core/errors';
import { ensureBelowLimit } from '../core/size';
import { run } from '../core/exec';
import { withCache } from '../core/cache';
import * as path from 'path';
import * as fs from 'fs-extra';
import { createReadStream } from 'fs';
import { config } from '../core/config';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

const PORT = Number(process.env['PORT'] || 3000);
const PUBLIC_URL = config.PUBLIC_URL || process.env['PUBLIC_URL'] || '';

app.use('/tmp', express.static('/tmp', { maxAge: 0 }));

if (PUBLIC_URL) {
  logger.info(`✅ Static /tmp is publicly available at ${PUBLIC_URL}/tmp`);
} else {
  logger.warn('PUBLIC_URL is not set. Inline video URLs will not be accessible.');
}

// simple in-memory per-IP concurrency guard
const activeByIp = new Map<string, number>();
const MAX_PER_IP = 2;

type JobStatus = 'pending' | 'ready' | 'error';
type Job = {
  id: string;
  url: string;
  status: JobStatus;
  filePath?: string;
  fileName?: string;
  error?: string;
  sessionDir?: string;
  activeStreams?: number;
  cleanupTimer?: NodeJS.Timeout | null;
};

const jobs = new Map<string, Job>();

function newId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function startJob(url: string): Promise<Job> {
  const id = newId();
  const job: Job = { id, url, status: 'pending', activeStreams: 0, cleanupTimer: null };
  jobs.set(id, job);

  (async () => {
    try {
      const providerName = detectProvider(url);
      if (!providerName) throw new Error('Unsupported provider');
      await ensureTempDir();
      const sessionDir = await makeSessionDir();
      job.sessionDir = sessionDir;
      const provider = getProvider(providerName);
      const result = await provider.download(url, sessionDir);
      await ensureBelowLimit(result.filePath);
      job.filePath = result.filePath;
      job.fileName = path.basename(result.filePath);
      job.status = 'ready';
    } catch (error: any) {
      logger.warn('Job failed', {
        url,
        error: error?.message || String(error),
        code: error?.code,
        details: error?.details ? 'has_details' : 'none',
      });
      job.error = error?.message || 'Failed';
      if (error && error.code) (job as any).errorCode = error.code;
      try {
        const stderr = error?.details?.stderr || error?.stderr;
        if (stderr && typeof stderr === 'string') {
          job.error += ' — ' + String(stderr).slice(0, 300);
        }
      } catch {}
      job.status = 'error';
    }
  })().catch((error) => {
    logger.error('Unexpected job error', { error });
    job.error = error?.message || 'Unexpected error';
    job.status = 'error';
  });

  return job;
}

function cancelCleanup(job: Job) {
  if (job.cleanupTimer) {
    clearTimeout(job.cleanupTimer);
    job.cleanupTimer = null;
  }
}

async function finalizeCleanup(job: Job) {
  try {
    await safeRemove(job.sessionDir || '');
  } catch {}
  jobs.delete(job.id);
}

function scheduleCleanup(job: Job, delayMs = 120000) {
  if ((job.activeStreams || 0) > 0) return;
  cancelCleanup(job);
  job.cleanupTimer = setTimeout(() => {
    void finalizeCleanup(job);
  }, delayMs);
}

cron.schedule('*/15 * * * *', async () => {
  try {
    const files = await fs.readdir('/tmp');
    const now = Date.now();
    await Promise.all(
      files.map(async (file) => {
        const fullPath = path.join('/tmp', file);
        try {
          const stat = await fs.stat(fullPath);
          if (now - stat.mtimeMs > 60 * 60 * 1000) {
            await fs.remove(fullPath);
          }
        } catch (error) {
          logger.warn({ file: fullPath, error }, 'Failed to process tmp file for cleanup');
        }
      })
    );
  } catch (error) {
    logger.warn({ error }, 'Failed to scan tmp directory for cleanup');
  }
});

app.get('/', async (req, res) => {
  const initUrl = req.query?.['url'] as string | undefined;
  const html = `<!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Video Downloader</title>
    <style>
      body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Helvetica,Arial,sans-serif;margin:0;padding:2rem;background:#0f1221;color:#e6e8f0}
      .card{max-width:720px;margin:0 auto;background:#171a2f;border-radius:12px;padding:24px;box-shadow:0 10px 30px rgba(0,0,0,.35)}
      h1{margin:0 0 12px 0;font-size:22px}
      p{margin:4px 0 12px 0;color:#aab}
      form{display:flex;gap:8px}
      input[type=url]{flex:1;padding:12px;border-radius:8px;border:1px solid #303654;background:#0f1221;color:#e6e8f0}
      button{padding:12px 16px;border-radius:8px;border:0;background:#4c6fff;color:#fff;font-weight:600;cursor:pointer}
      small{color:#99a}
      #status{margin-top:12px;color:#aab}
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Video Downloader</h1>
      <p>Paste a public video URL (Facebook / Instagram / LinkedIn / YouTube / TikTok / Sora).</p>
      <form id="frm" onsubmit="event.preventDefault(); start(document.getElementById('url').value);">
        <input id="url" type="url" name="url" placeholder="https://..." required />
        <button type="submit">Download</button>
      </form>
      <p id="status"></p>
      <p><small>Files are processed temporarily and deleted after download.</small></p>
    </div>
    <iframe id="dl" style="display:none"></iframe>
    <script>
      const initUrl = ${JSON.stringify(initUrl || '')};
      const statusEl = document.getElementById('status');

      async function start(url){
        if(!url){ statusEl.textContent = 'Enter URL'; return; }
        statusEl.textContent = 'Preparing download… This may take a minute.';
        window.location.href = '/download_video?url=' + encodeURIComponent(url);
      }

      if(initUrl){
        document.getElementById('url').value = initUrl;
        start(initUrl);
      }
    </script>
  </body>
  </html>`;
  res.set('Cache-Control', 'no-store');
  return res.type('text/html').send(html);
});

app.get('/download_video', async (req, res) => {
  const url = req.query?.['url'] as string | undefined;
  logger.info('DEBUG: download_video called', { url, query: req.query });
  if (!url) return res.status(400).json({ error: 'Missing url' });

  await ensureTempDir();
  const sessionDir = await makeSessionDir();
  let filePath: string | undefined;
  try {
    const providerName = detectProvider(url);
    logger.info('DEBUG: provider detected', { providerName, url });
    if (!providerName) return res.status(400).json({ error: 'Unsupported provider' });
    const provider = getProvider(providerName);
    logger.info('DEBUG: starting download', { providerName, sessionDir });
    const result = await provider.download(url, sessionDir);
    logger.info('DEBUG: download completed', { filePath: result.filePath, videoInfo: result.videoInfo });
    filePath = result.filePath;
    await ensureBelowLimit(filePath);

    const fileName = path.basename(filePath);
    const ext = path.extname(fileName).toLowerCase();
    const mime =
      ext === '.mp4'
        ? 'video/mp4'
        : ext === '.webm'
        ? 'video/webm'
        : ext === '.mkv'
        ? 'video/x-matroska'
        : 'application/octet-stream';
    const st = await fs.stat(filePath);

    res.set({
      'X-Accel-Buffering': 'no',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Type': mime,
      'Content-Length': String(st.size),
      'Content-Disposition': `attachment; filename="${fileName}"`,
    });

    const stream = createReadStream(filePath);
    stream.pipe(res);
    stream.on('error', (err) => {
      logger.error('Stream error', { url, message: err.message });
      res.destroy(err);
    });
    res.on('close', () => {
      stream.destroy();
    });
    await new Promise<void>((resolve) => {
      res.on('finish', resolve);
      res.on('close', resolve);
    });

    if (sessionDir) await safeRemove(sessionDir).catch(() => undefined);
    return;
  } catch (error: any) {
    logger.error('download_video failed', { url, message: error?.message, code: error?.code, details: error?.details });
    if (error instanceof AppError) return res.status(400).json({ error: toUserMessage(error) });
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    if (sessionDir && !filePath) await safeRemove(sessionDir).catch(() => undefined);
  }
});

app.post('/get-video-link', async (req, res) => {
  const rawUrl = (req.body?.url || '').toString().trim();
  if (!rawUrl) return res.status(400).json({ error: 'Missing url' });

  const providerName = detectProvider(rawUrl);
  if (!providerName) return res.status(400).json({ error: 'Unsupported provider' });

  const cacheKey = `metadata:${providerName}:${createHash('sha1').update(rawUrl).digest('hex')}`;

  try {
    const metadata = await withCache(cacheKey, async () => {
      const provider = getProvider(providerName);
      logger.info('Resolving metadata', { url: rawUrl, provider: providerName });
      return provider.metadata(rawUrl);
    });

    return res.json(metadata);
  } catch (error) {
    if (error instanceof AppError) {
      return res.status(400).json({ error: toUserMessage(error) });
    }
    logger.error('get-video-link failed', { url: rawUrl, error });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/download', async (req, res) => {
  const url = req.query?.['url'] as string | undefined;
  const q = url ? '?url=' + encodeURIComponent(url) : '';
  return res.type('text/html').send(`<!doctype html><meta http-equiv="refresh" content="0; url=/${q}">`);
});

app.post('/api/start', async (req, res) => {
  try {
    const url = (req.body?.url || '').toString();
    if (!url) return res.status(400).json({ error: 'Missing url' });
    const ip = (req.ip || req.socket.remoteAddress || 'unknown').toString();
    const count = activeByIp.get(ip) || 0;
    if (count >= MAX_PER_IP) return res.status(429).json({ error: 'Too many concurrent downloads from this IP' });
    activeByIp.set(ip, count + 1);
    const job = await startJob(url);
    activeByIp.set(ip, Math.max(0, (activeByIp.get(ip) || 1) - 1));
    return res.json({ id: job.id });
  } catch (error) {
    logger.error('api/start failed', { error });
    return res.status(500).json({ error: 'Failed to start' });
  }
});

app.get('/status', async (req, res) => {
  const id = (req.query?.['id'] as string | undefined) ?? '';
  const job = id ? jobs.get(id) : undefined;
  if (!job) return res.status(404).json({ error: 'Not found' });
  return res.json({ status: job.status, error: job.error || undefined, errorCode: (job as any).errorCode || undefined });
});

app.get('/file/:id', async (req, res) => {
  const id = req.params?.id ?? '';
  const job = id ? jobs.get(id) : undefined;
  if (!job) return res.status(404).json({ error: 'Not found' });
  if (job.status !== 'ready' || !job.filePath || !job.fileName) return res.status(409).json({ error: 'Not ready' });
  try {
    const filePath = job.filePath!;
    const fileName = job.fileName!;
    logger.debug('file route start', { id, filePath, fileName });
    const exists = await fs.pathExists(filePath);
    if (!exists) {
      logger.error('file route: file not found on disk', { id, filePath });
      return res.status(410).json({ error: 'gone' });
    }
    const st = await fs.stat(filePath);
    const total = st.size;
    logger.debug('file route stat', { id, total });
    const range = req.headers['range'] as string | undefined;
    const mime = 'application/octet-stream';
    cancelCleanup(job);
    job.activeStreams = (job.activeStreams || 0) + 1;
    logger.debug('file stream opened', { id, active: job.activeStreams });
    const onClose = () => {
      job.activeStreams = (job.activeStreams || 1) - 1;
      logger.debug('file stream closed', { id, active: job.activeStreams });
      scheduleCleanup(job);
    };

    res.setTimeout(10 * 60 * 1000);
    let stream: fs.ReadStream;
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
        const chunk = end - start + 1;
        logger.debug('file route range', { id, start, end, chunk });
        res.status(206);
        res.set({
          'Content-Range': `bytes ${start}-${end}/${total}`,
          'Content-Length': String(chunk),
          'Content-Type': mime,
          'Content-Disposition': `attachment; filename="${fileName}"`,
        });
        stream = createReadStream(filePath, { start, end });
      } else {
        res.status(416);
        return res.end();
      }
    } else {
      res.status(200);
      res.set({
        'Content-Length': String(total),
        'Content-Type': mime,
        'Content-Disposition': `attachment; filename="${fileName}"`,
      });
      stream = createReadStream(filePath);
    }

    stream.on('error', (e: any) => {
      logger.warn('stream error (client likely aborted)', { id, message: e?.message, code: e?.code });
      try {
        stream.destroy();
      } catch {}
      onClose();
    });
    res.on('close', onClose);
    res.on('finish', onClose);
    stream.pipe(res);
    return;
  } catch (error: any) {
    logger.error('file route failed', { id, message: error?.message, code: error?.code, stack: error?.stack });
    return res.status(500).json({ error: 'stream failed' });
  }
});

(async () => {
  try {
    const ytdlpVersion = await run('yt-dlp', ['--version']);
    const ffmpegVersion = await run('ffmpeg', ['-version']);
    logger.info(
      {
        'yt-dlp': ytdlpVersion.stdout.trim(),
        ffmpeg: ffmpegVersion.stdout.split('\n')[0],
      },
      'Tool versions'
    );
  } catch (error) {
    logger.error(error, 'Failed to check tool versions on startup');
  }
})();

app.listen(PORT, () => {
  logger.info('Web server started', { port: PORT });
});
