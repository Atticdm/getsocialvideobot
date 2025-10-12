import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import cron from 'node-cron';
import fs from 'fs-extra';
import path from 'path';
import process from 'process';

const app = express();
const PORT = process.env.PORT || 8080;
const TMP_DIR = process.env.TMP_DIR || '/tmp';

app.use(cors());
app.use(morgan('combined'));

const staticMiddleware = express.static(TMP_DIR, {
  fallthrough: true,
  setHeaders: (res, filePath) => {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.mp4') {
      res.setHeader('Content-Type', 'video/mp4');
    }
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-store');
  }
});

app.use('/tmp', (req, res, next) => {
  if (req.method === 'GET') {
    return staticMiddleware(req, res, next);
  }
  return res.status(405).end();
});

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', tmpDir: TMP_DIR });
});

cron.schedule('*/15 * * * *', async () => {
  try {
    const files = await fs.readdir(TMP_DIR);
    const now = Date.now();
    await Promise.all(
      files.map(async (file) => {
        const fullPath = path.join(TMP_DIR, file);
        try {
          const stat = await fs.stat(fullPath);
          if (now - stat.mtimeMs > 60 * 60 * 1000) {
            await fs.remove(fullPath);
          }
        } catch (error) {
          console.error('Cleanup error', { file: fullPath, error });
        }
      })
    );
  } catch (error) {
    console.error('Failed to scan tmp dir', error);
  }
});

app.listen(PORT, () => {
  console.log(`Temp server listening on port ${PORT}, serving ${TMP_DIR}`);
});
