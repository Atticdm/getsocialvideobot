import Fastify from 'fastify';
import { detectProvider, getProvider } from '../providers';
import { ensureTempDir, makeSessionDir, safeRemove } from '../core/fs';
import { logger } from '../core/logger';
// import { AppError } from '../core/errors';
import { ensureBelowLimit } from '../core/size';
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
  // streaming control
  activeStreams?: number;
  cleanupTimer?: any;
};
const jobs = new Map<string, Job>();

function newId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

async function startJob(url: string): Promise<Job> {
  const id = newId();
  const job: Job = { id, url, status: 'pending', activeStreams: 0 };
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
    } catch (e: any) {
      logger.warn('Job failed', { url, error: e?.message || String(e), code: e?.code, details: e?.details ? 'has_details' : 'none' });
      job.error = e?.message || 'Failed';
      if (e && e.code) (job as any).errorCode = e.code;
      // Try propagate stderr preview to UI for faster diagnostics
      try {
        const stderr = e?.details?.stderr || e?.stderr;
        if (stderr && typeof stderr === 'string') {
          job.error += ' — ' + String(stderr).slice(0, 300);
        }
      } catch {}
      job.status = 'error';
    }
  })().catch((e) => {
    logger.error('Unexpected job error', { error: e });
    job.error = e?.message || 'Unexpected error';
    job.status = 'error';
  });

  return job;
}

function cancelCleanup(job: Job) {
  if (job.cleanupTimer) { clearTimeout(job.cleanupTimer); job.cleanupTimer = undefined; }
}

async function finalizeCleanup(job: Job) {
  try { await safeRemove(job.sessionDir || ''); } catch {}
  jobs.delete(job.id);
}

function scheduleCleanup(job: Job, delayMs = 120000) {
  if ((job.activeStreams || 0) > 0) return;
  cancelCleanup(job);
  job.cleanupTimer = setTimeout(() => { void finalizeCleanup(job); }, delayMs);
}

fastify.get('/', async (req, reply) => {
  const initUrl = (req.query as any)?.url as string | undefined;
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
      <p>Paste a public video URL (Facebook / Instagram / LinkedIn / YouTube).</p>
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
        statusEl.textContent = 'Starting…';
        try{
          const r = await fetch('/api/start', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url }) });
          const j = await r.json();
          if(!j.id){ statusEl.textContent = j.error || 'Failed to start'; return; }
          poll(j.id);
        }catch(e){ statusEl.textContent = 'Failed to start'; }
      }

      async function poll(id){
        try{
          const r = await fetch('/status?id='+encodeURIComponent(id), { cache:'no-store' });
          const j = await r.json();
          if(j.status==='ready'){
            statusEl.textContent = 'Ready. Downloading…';
            // prefer anchor with download attribute to avoid iframe cancellations
            const a = document.createElement('a');
            a.href = '/file/'+id; a.download = '';
            a.style.display='none'; document.body.appendChild(a); a.click();
            // keep polling a couple more times to ensure no error state flips
            return;
          }
          if(j.status==='error'){
            statusEl.textContent = 'Error'+(j.errorCode ? ' ('+j.errorCode+')' : '')+': '+(j.error || 'failed');
            return;
          }
        }catch(e){ /* network glitch; retry */ }
        setTimeout(()=>poll(id), 1200);
      }

      if(initUrl){
        document.getElementById('url').value = initUrl;
        start(initUrl);
      }
    </script>
  </body>
  </html>`;
  reply.type('text/html').send(html);
});

// Kick off job, return progress page that polls /status and redirects to /file/:id when ready
fastify.get('/download', async (req, reply) => {
  const url = (req.query as any)?.url as string | undefined;
  const q = url ? ('?url=' + encodeURIComponent(url)) : '';
  reply.header('Content-Type','text/html').send(`<!doctype html><meta http-equiv="refresh" content="0; url=/${q}">`);
});

// Start job via AJAX from the main page
fastify.post('/api/start', async (req, reply) => {
  try {
    const body = (req.body as any) || {};
    const url = (body.url || '').toString();
    if (!url) return reply.code(400).send({ error: 'Missing url' });
    const count = activeByIp.get(req.ip) || 0;
    if (count >= MAX_PER_IP) return reply.code(429).send({ error: 'Too many concurrent downloads from this IP' });
    activeByIp.set(req.ip, count + 1);
    const job = await startJob(url);
    activeByIp.set(req.ip, Math.max(0, (activeByIp.get(req.ip) || 1) - 1));
    reply.send({ id: job.id });
  } catch (e) {
    logger.error('api/start failed', { error: e });
    reply.code(500).send({ error: 'Failed to start' });
  }
});

// Job status
fastify.get('/status', async (req, reply) => {
  const id = (req.query as any)?.id as string;
  const job = id && jobs.get(id);
  if (!job) return reply.code(404).send({ error: 'Not found' });
  reply.send({ status: job.status, error: job.error || undefined, errorCode: (job as any).errorCode || undefined });
});

// File streaming endpoint (forced download)
fastify.get('/file/:id', async (req, reply) => {
  const id = (req.params as any)?.id as string;
  const job = id && jobs.get(id);
  if (!job) return reply.code(404).send({ error: 'Not found' });
  if (job.status !== 'ready' || !job.filePath || !job.fileName) return reply.code(409).send({ error: 'Not ready' });
  try {
    logger.debug('file route start', { id, filePath: job.filePath, fileName: job.fileName });
    const filePath = job.filePath;
    const fileName = job.fileName;
    const exists = await fs.pathExists(filePath);
    if (!exists) {
      logger.error('file route: file not found on disk', { id, filePath });
      return reply.code(410).send({ error: 'gone' });
    }
    const st = await fs.stat(filePath);
    const total = st.size;
    logger.debug('file route stat', { id, total });
    const range = (req.headers as any)['range'] as string | undefined;
    const mime = 'application/octet-stream';
    cancelCleanup(job);
    job.activeStreams = (job.activeStreams || 0) + 1;
    logger.debug('file stream opened', { id, active: job.activeStreams });
    const onClose = () => {
      job.activeStreams = (job.activeStreams || 1) - 1;
      logger.debug('file stream closed', { id, active: job.activeStreams });
      scheduleCleanup(job);
    };

    // Standard Fastify streaming (no hijack)
    reply.raw.setTimeout(10 * 60 * 1000);
    let stream: any;
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/);
      if (m) {
        const start = m[1] ? parseInt(m[1], 10) : 0;
        const end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
        const chunk = end - start + 1;
        logger.debug('file route range', { id, start, end, chunk });
        reply.code(206);
        reply.header('Content-Range', `bytes ${start}-${end}/${total}`);
        reply.header('Content-Length', String(chunk));
        reply.header('Content-Type', mime);
        reply.header('Content-Disposition', `attachment; filename="${fileName}"`);
        stream = createReadStream(filePath, { start, end });
      }
    }
    if (!stream) {
      reply.code(200);
      reply.header('Content-Length', String(total));
      reply.header('Content-Type', mime);
      reply.header('Content-Disposition', `attachment; filename="${fileName}"`);
      stream = createReadStream(filePath);
    }

    stream.on('error', (e: any) => { logger.warn('stream error (client likely aborted)', { id, message: e?.message, code: e?.code }); try { stream.destroy(); } catch {}; onClose(); });
    stream.on('close', onClose);
    return reply.send(stream);
  } catch (e) {
    const err: any = e;
    logger.error('file route failed', { id, message: err?.message, code: err?.code, stack: err?.stack });
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
