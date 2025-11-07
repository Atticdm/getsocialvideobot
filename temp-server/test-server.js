import express from 'express';

const app = express();
const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Temp server is running',
    env: {
      PORT: process.env.PORT,
      UPLOAD_SECRET: process.env.UPLOAD_SECRET ? 'set' : 'not set',
      TMP_DIR: process.env.TMP_DIR || '/tmp'
    }
  });
});

app.get('/healthz', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Test server listening on port ${PORT}`);
});

