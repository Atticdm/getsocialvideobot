import Fastify from 'fastify';
import { detectProvider, getProvider } from '../providers';
import { ensureTempDir, makeSessionDir, safeRemove } from '../core/fs';
import { ensureBelowLimit } from '../core/size';
import { logger } from '../core/logger';
import { AppError, toUserMessage } from '../core/errors';
import * as path from 'path';
import * as fs from 'fs-extra';

const fastify = Fastify({ logger: false });
const PORT = Number(process.env['PORT'] || 3000);

// simple in-memory per-IP concurrency guard
const activeByIp = new Map<string, number>();
const MAX_PER_IP = 2;

fastify.get('/', async (_req, reply) => {
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
      p{margin:4px 0 16px 0;color:#aab}
      form{display:flex;gap:8px}
      input[type=url]{flex:1;padding:12px;border-radius:8px;border:1px solid #303654;background:#0f1221;color:#e6e8f0}
      button{padding:12px 16px;border-radius:8px;border:0;background:#4c6fff;color:#fff;font-weight:600;cursor:pointer}
      small{color:#99a}
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Video Downloader</h1>
      <p>Paste a public video URL (Facebook / Instagram / LinkedIn).</p>
      <form action="/download" method="get">
        <input type="url" name="url" placeholder="https://..." required />
        <button type="submit">Download</button>
      </form>
      <p><small>Files are processed temporarily and deleted after download.</small></p>
    </div>
  </body>
  </html>`;
  reply.type('text/html').send(html);
});

fastify.get('/download', async (req, reply) => {
  const url = (req.query as any)?.url as string | undefined;
  const ip = (req.ip || 'unknown');
  if (!url) {
    reply.code(400).send({ error: 'Missing url' });
    return;
  }

  const providerName = detectProvider(url);
  if (!providerName) {
    reply.code(400).send({ error: 'Unsupported provider' });
    return;
  }

  const count = activeByIp.get(ip) || 0;
  if (count >= MAX_PER_IP) {
    reply.code(429).send({ error: 'Too many concurrent downloads from this IP' });
    return;
  }
  activeByIp.set(ip, count + 1);

  await ensureTempDir();
  const sessionDir = await makeSessionDir();
  try {
    const provider = getProvider(providerName);
    const result = await provider.download(url, sessionDir);
    await ensureBelowLimit(result.filePath);
    const fileName = path.basename(result.filePath);

    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', `attachment; filename="${fileName}"`);
    const stream = fs.createReadStream(result.filePath);
    // Ensure cleanup after stream ends
    stream.on('close', async () => {
      await safeRemove(sessionDir);
    });
    return reply.send(stream);
  } catch (err) {
    await safeRemove(sessionDir);
    if (err instanceof AppError) {
      const msg = toUserMessage(err);
      logger.warn('Web download failed (app error)', { code: err.code, details: err.details });
      reply.code(400).send({ error: msg, code: err.code });
      return;
    }
    logger.error('Web download failed (unexpected)', { error: err });
    reply.code(500).send({ error: 'Internal server error' });
  } finally {
    activeByIp.set(ip, Math.max(0, (activeByIp.get(ip) || 1) - 1));
  }
});

export async function start() {
  await fastify.listen({ port: PORT, host: '0.0.0.0' });
  logger.info('Web server started', { port: PORT });
}

// Start if executed directly
if (require.main === module) {
  start().catch((e) => {
    logger.error('Failed to start web server', { error: e });
    process.exit(1);
  });
}
