import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { roPool } from './db/pool.js';
import { chatRouter } from './routes/chat.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const app = express();

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Health check: the database is what answers questions
app.get('/health', async (_req, res) => {
  try {
    await roPool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'down' });
  }
});

app.use('/api/chat', chatRouter);

// Serve static web UI
// src/app.ts in dev (tsx), dist/src/app.js when compiled
const publicDir = [path.resolve(__dirname, '../public'), path.resolve(__dirname, '../../public')]
  .find(dir => fs.existsSync(dir)) ?? path.resolve(process.cwd(), 'public');
app.use(express.static(publicDir));

// Fallback route for SPA
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path === '/health') {
    return next();
  }
  res.sendFile(path.join(publicDir, 'index.html'), err => {
    if (err) next();
  });
});
