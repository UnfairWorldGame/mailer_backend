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
  // Never leak internal error details (stack-adjacent messages, DB/SMTP errors)
  // to clients for unexpected 5xx failures — regardless of NODE_ENV. Details are
  // already logged above. Only intentional 4xx errors carry a client-safe message.
  const message = status >= 500 ? 'Internal server error' : err.message || 'Request failed';

  res.status(status).json({ error: message });
}
