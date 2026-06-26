import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env');
dotenv.config({ path: envPath });

import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { connectDB } from './db/connect.js';
import { resumeInterruptedCampaigns } from './services/sendEngine.js';
import { applySecurity } from './middleware/security.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import accountsRouter from './routes/accounts.js';
import uploadsRouter from './routes/uploads.js';
import campaignsRouter from './routes/campaigns.js';
import analyticsRouter from './routes/analytics.js';
import aiRouter from './routes/ai.js';
import authRouter from './routes/auth.js';
import adminRouter from './routes/admin.js';
import inquiriesRouter from './routes/inquiries.js';
import billingRouter from './routes/billing.js';

const app = express();
const PORT = process.env.PORT || 3001;

function normalizeOrigin(url) {
  if (!url) return null;
  return url.replace(/\/+$/, '');
}

const allowedOrigins = [
  normalizeOrigin(process.env.FRONTEND_URL),
  'http://localhost:5173',
  'http://localhost:4173',
].filter(Boolean);

app.set('trust proxy', 1);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(normalizeOrigin(origin)) || process.env.NODE_ENV !== 'production') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
}));

applySecurity(app);

app.use(express.json({ limit: '2mb' }));

app.get('/api/health', async (_req, res) => {
  const dbState = mongoose.connection.readyState;
  const dbStatus = dbState === 1 ? 'connected' : dbState === 2 ? 'connecting' : 'disconnected';
  res.status(dbState === 1 ? 200 : 503).json({
    status: dbState === 1 ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    database: dbStatus,
    version: process.env.npm_package_version || '2.0.0',
  });
});

app.use('/api/auth', authRouter);
app.use('/api/inquiries', inquiriesRouter);
app.use('/api/billing', billingRouter);
app.use('/api/admin', adminRouter);
app.use('/api/accounts', accountsRouter);
app.use('/api/uploads', uploadsRouter);
app.use('/api/campaigns', campaignsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/ai', aiRouter);

app.use(notFoundHandler);
app.use(errorHandler);

async function start() {
  await connectDB();

  mongoose.connection.on('reconnected', () => {
    console.log('MongoDB reconnected — checking for interrupted campaigns');
    resumeInterruptedCampaigns().catch(console.error);
  });

  await resumeInterruptedCampaigns();

  const server = app.listen(PORT, () => {
    console.log(`MAILIQ API running on http://localhost:${PORT}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Stop the other process or change PORT in .env`);
    } else {
      console.error('Server error:', err);
    }
    process.exit(1);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
