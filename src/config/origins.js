export function normalizeOrigin(url) {
  if (!url) return null;
  return url.replace(/\/+$/, '');
}

/** Comma-separated FRONTEND_URL values, with www / non-www pairs for each. */
export function getAllowedOrigins() {
  const fromEnv = (process.env.FRONTEND_URL || '')
    .split(',')
    .map((value) => normalizeOrigin(value.trim()))
    .filter(Boolean);

  const expanded = new Set(fromEnv);

  for (const origin of fromEnv) {
    try {
      const url = new URL(origin);
      const host = url.hostname;
      const port = url.port ? `:${url.port}` : '';
      if (host.startsWith('www.')) {
        expanded.add(normalizeOrigin(`${url.protocol}//${host.slice(4)}${port}`));
      } else {
        expanded.add(normalizeOrigin(`${url.protocol}//www.${host}${port}`));
      }
    } catch {
      // ignore invalid URLs
    }
  }

  if (process.env.NODE_ENV !== 'production') {
    expanded.add('http://localhost:5173');
    expanded.add('http://localhost:4173');
  }

  return [...expanded];
}

export function getPrimaryFrontendUrl() {
  const first = (process.env.FRONTEND_URL || 'http://localhost:5173')
    .split(',')[0]
    .trim()
    .replace(/\/+$/, '');
  return first || 'http://localhost:5173';
}
