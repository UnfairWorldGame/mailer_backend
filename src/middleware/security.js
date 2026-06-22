import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const isDev = process.env.NODE_ENV !== 'production';

export function applySecurity(app) {
  app.use(helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }));

  const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX || '2000', 10),
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => isDev,
    message: { error: 'Too many requests. Please try again later.' },
  });

  app.use('/api/', limiter);

  const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: parseInt(process.env.UPLOAD_RATE_LIMIT_MAX || '30', 10),
    skip: () => isDev,
    message: { error: 'Upload limit exceeded. Try again later.' },
  });

  app.use('/api/uploads/', uploadLimiter);
}
