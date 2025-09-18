import Fastify from 'fastify';
import { detectProvider, getProvider } from '../providers';
import { ensureTempDir, makeSessionDir, safeRemove } from '../core/fs';
import { logger } from '../core/logger';
// NOTE: AppError types are used in provider layer; web job converts to plain message
import * as path from 'path';
import * as fs from 'fs-extra';
import { createReadStream } from 'fs';

const fastify = Fastify({ logger: false });
const PORT = Number(process.env['PORT'] || 3000);

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
};
const jobs = new Map<string, Job>();

function newId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function startJob(url: string): Promise<Job> {
  const id = newId();
  const job: Job = { id, url, status: 'pending' };
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
      // optional: size check happens in provider pipeline; for web we just stream
      job.filePath = result.filePath;
      job.fileName = path.basename(result.filePath);
      job.status = 'ready';
    } catch (e: any) {
      logger.warn('Job failed', { url, error: e?.message || String(e) });
      job.error = e?.message || 'Failed';
      job.status = 'error';
    }
  })().catch((e) => {
    logger.error('Unexpected job error', { error: e });
    job.error = e?.message || 'Unexpected error';
    job.status = 'error';
  });

  return job;
}

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
      <p>Paste a public video URL (Facebook / Instagram / LinkedIn / YouTube).</p>
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

// Kick off job, return progress page that polls /status and redirects to /file/:id when ready
fastify.get('/download', async (req, reply) => {
  const url = (req.query as any)?.url as string | undefined;
  const ip = (req.ip || 'unknown');
  if (!url) {
    reply.code(400).send({ error: 'Missing url' });
    return;
  }
  const count = activeByIp.get(ip) || 0;
  if (count >= MAX_PER_IP) return reply.code(429).send({ error: 'Too many concurrent downloads from this IP' });
  activeByIp.set(ip, count + 1);

  const job = await startJob(url);
  activeByIp.set(ip, Math.max(0, (activeByIp.get(ip) || 1) - 1));

  const html = `<!doctype html>
  <html><head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>Preparing download…</title>
  <style>body{font-family:system-ui,sans-serif;background:#0f1221;color:#e6e8f0;padding:2rem} .box{max-width:720px;margin:0 auto;background:#171a2f;border-radius:12px;padding:24px}</style>
  <script>
  const id = ${JSON.stringify(job.id)};
  async function poll(){
    try{
      const r = await fetch('/status?id='+id,{cache:'no-store'});
      const j = await r.json();
      if(j.status==='ready'){ window.location = '/file/'+id; return; }
      if(j.status==='error'){ document.getElementById('msg').textContent = 'Error: '+(j.error||'failed'); return; }
    }catch(e){ /* ignore */ }
    setTimeout(poll, 1500);
  }
  window.onload = poll;
  </script></head>
  <body><div class="box">
  <h1>Preparing your file…</h1>
  <p id="msg">This may take a minute. The download will start automatically.</p>
  </div></body></html>`;
  reply.type('text/html').send(html);
});

// Job status
fastify.get('/status', async (req, reply) => {
  const id = (req.query as any)?.id as string;
  const job = id && jobs.get(id);
  if (!job) return reply.code(404).send({ error: 'Not found' });
  reply.send({ status: job.status, error: job.error || undefined });
});

// File streaming endpoint (forced download)
fastify.get('/file/:id', async (req, reply) => {
  const id = (req.params as any)?.id as string;
  const job = id && jobs.get(id);
  if (!job) return reply.code(404).send({ error: 'Not found' });
  if (job.status !== 'ready' || !job.filePath || !job.fileName) return reply.code(409).send({ error: 'Not ready' });
  try {
    const filePath = job.filePath;
    const fileName = job.fileName;
    const st = await fs.stat(filePath);
    const total = st.size;
    reply.header('X-Accel-Buffering', 'no');
    reply.header('Accept-Ranges', 'bytes');
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.raw.setTimeout(10 * 60 * 1000);

    const range = (req.headers as any)['range'] as string | undefined;
    const mime = 'application/octet-stream';
    const cleanup = async () => {
      try { await safeRemove(job.sessionDir || ''); } catch {}
      jobs.delete(id);
    };
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
        const chunk = end - start + 1;
        reply.code(206);
        reply.header('Content-Range', `bytes ${start}-${end}/${total}`);
        reply.header('Content-Length', String(chunk));
        reply.header('Content-Type', mime);
        reply.header('Content-Disposition', `attachment; filename="${fileName}"`);
        const stream = createReadStream(filePath, { start, end });
        stream.on('error', async (e) => { logger.error('file range stream error', { error: e }); try { stream.destroy(); } catch {}; await cleanup(); });
        reply.raw.on('close', cleanup);
        return reply.send(stream);
      }
    }
    reply.header('Content-Length', String(total));
    reply.header('Content-Type', mime);
    reply.header('Content-Disposition', `attachment; filename="${fileName}"`);
    const stream = createReadStream(filePath);
    stream.on('error', async (e) => { logger.error('file stream error', { error: e }); try { stream.destroy(); } catch {}; await cleanup(); });
    reply.raw.on('close', cleanup);
    return reply.send(stream);
  } catch (e) {
    logger.error('file route failed', { error: e });
    return reply.code(500).send({ error: 'stream failed' });
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
