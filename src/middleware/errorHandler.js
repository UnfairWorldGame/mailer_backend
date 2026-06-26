export function notFoundHandler(_req, res) {
  res.status(404).json({ error: 'Endpoint not found' });
}

export function errorHandler(err, _req, res, _next) {
  console.error('[API Error]', err);

  if (err.name === 'QuotaError') {
    return res.status(err.status || 402).json({ error: err.message, code: err.code });
  }

  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: err.message });
  }

  if (err.code === 11000) {
    return res.status(409).json({ error: 'Duplicate entry' });
  }

  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'Origin not allowed' });
  }

  const status = err.status || err.statusCode || 500;
  const message = status === 500 && process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message || 'Internal server error';

  res.status(status).json({ error: message });
}
