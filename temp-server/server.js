import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import cron from 'node-cron';
import fs from 'fs-extra';
import path from 'path';
import process from 'process';
import multer from 'multer';

const app = express();
const PORT = process.env.PORT || 8080;
const TMP_DIR = process.env.TMP_DIR || '/tmp';
const UPLOAD_SECRET = process.env.UPLOAD_SECRET || 'change-this-secret';

app.use(cors());
app.use(morgan('combined'));

// Multer configuration for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, TMP_DIR);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + uniqueSuffix + ext);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2GB max
});

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

// Serve static files from /tmp directory
app.use('/tmp', staticMiddleware);

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', tmpDir: TMP_DIR });
});

// Upload endpoint for bot to upload files
app.post('/upload', upload.single('video'), (req, res) => {
  const authHeader = req.headers.authorization;
  const expectedAuth = `Bearer ${UPLOAD_SECRET}`;
  
  if (authHeader !== expectedAuth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }
  
  const fileName = path.basename(req.file.path);
  const fileUrl = `/tmp/${encodeURIComponent(fileName)}`;
  
  console.log(`File uploaded: ${fileName} (${req.file.size} bytes)`);
  
  res.json({
    success: true,
    fileName,
    fileUrl,
    size: req.file.size
  });
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
