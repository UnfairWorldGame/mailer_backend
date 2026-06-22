const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;const EMAIL_HEADER_CANDIDATES = ['email', 'e-mail', 'email address', 'mail', 'gmail'];

export function isValidEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > 254) return false;
  return EMAIL_REGEX.test(email);
}

export function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

export function normalizeHeader(header) {
  return String(header || '').trim().toLowerCase();
}

export function findColumn(headers, candidates) {
  for (const candidate of candidates) {
    const idx = headers.findIndex((h) => normalizeHeader(h) === candidate);
    if (idx !== -1) return idx;
  }
  return -1;
}

function isEmailHeader(cell) {
  return EMAIL_HEADER_CANDIDATES.includes(normalizeHeader(cell));
}

function extractEmailsFromToken(token) {
  const found = [];
  const text = String(token || '').trim();
  if (!text) return found;

  const regex = /<?([^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)>?/gi;
  for (const match of text.matchAll(regex)) {
    const email = normalizeEmail(match[1]);
    if (isValidEmail(email)) found.push(email);
  }

  if (found.length === 0 && isValidEmail(text)) {
    found.push(normalizeEmail(text));
  }

  return found;
}

function normalizePasteText(text) {
  return String(text || '')
    .replace(/\uFEFF/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n/g, '\n')
    .trim();
}

function tokenizePasteText(text) {
  const normalized = normalizePasteText(text);
  if (!normalized) return [];

  return normalized
    .split(/[\n,;\t]+/)
    .flatMap((part) => part.split(/\s+/))
    .map((t) => t.trim())
    .filter(Boolean);
}

function emptyParseStats() {
  return { duplicates: 0, invalid: 0, empty: 0, processed: 0 };
}

export function parseEmailsFromText(text) {
  return parseEmailsFromTextDetailed(text).contacts;
}

export function parseEmailsFromTextDetailed(text) {
  const contacts = [];
  const seen = new Set();
  const stats = emptyParseStats();

  const tokens = tokenizePasteText(text);
  if (tokens.length === 0) {
    return { contacts, stats };
  }

  for (const token of tokens) {
    stats.processed++;
    const emails = extractEmailsFromToken(token);
    if (emails.length === 0) {
      stats.invalid++;
      continue;
    }

    for (const email of emails) {
      if (seen.has(email)) {
        stats.duplicates++;
        continue;
      }
      seen.add(email);
      contacts.push({ name: '', email });
    }
  }

  return { contacts, stats };
}

export function parseContactsFromRows(rows) {
  return parseContactsFromRowsDetailed(rows).contacts;
}

export function parseContactsFromRowsDetailed(rows) {
  if (!Array.isArray(rows) || rows.length < 1) {
    throw new Error('File must contain at least one email address');
  }

  const headers = rows[0].map((cell) => String(cell ?? '').trim());
  const nameIdx = findColumn(headers, ['name', 'full name', 'fullname', 'contact name']);
  const emailIdx = findColumn(headers, EMAIL_HEADER_CANDIDATES);

  const contacts = [];
  const seen = new Set();
  const stats = emptyParseStats();

  const addContact = (name, email) => {
    const normalizedEmail = normalizeEmail(email);
    const normalizedName = String(name || '').trim();

    if (!normalizedEmail) {
      stats.empty++;
      return;
    }

    stats.processed++;
    if (!isValidEmail(normalizedEmail)) {
      stats.invalid++;
      return;
    }
    if (seen.has(normalizedEmail)) {
      stats.duplicates++;
      return;
    }

    seen.add(normalizedEmail);
    contacts.push({ name: normalizedName, email: normalizedEmail });
  };

  if (emailIdx !== -1) {
    if (rows.length < 2) {
      throw new Error('File must contain a header row and at least one data row');
    }
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.every((cell) => !String(cell ?? '').trim())) continue;
      addContact(nameIdx !== -1 ? row[nameIdx] : '', row[emailIdx]);
    }
    if (contacts.length === 0) {
      throw new Error(buildNoValidError(stats));
    }
    return { contacts, stats };
  }

  if (nameIdx !== -1) {
    throw new Error('File must contain an Email column');
  }

  let startRow = 0;
  const firstCell = String(rows[0][0] ?? '').trim();
  if (rows.length > 1 && isEmailHeader(firstCell)) {
    startRow = 1;
  }

  for (let i = startRow; i < rows.length; i++) {
    const row = rows[i];
    const cell = String(row?.[0] ?? '').trim();
    if (!cell) continue;
    if (i === startRow && isEmailHeader(cell)) continue;
    addContact('', cell);
  }

  if (contacts.length === 0) {
    throw new Error(buildNoValidError(stats));
  }

  return { contacts, stats };
}

function buildNoValidError(stats) {
  const parts = ['No valid email addresses found'];
  const removed = formatRemovedParts(stats);
  if (removed) parts.push(removed);
  return `${parts[0]}. ${removed || 'Use an Email column or one email per row.'}`;
}

export function formatRemovedParts(stats) {
  const bits = [];
  if (stats.duplicates > 0) {
    bits.push(`${stats.duplicates} duplicate${stats.duplicates === 1 ? '' : 's'}`);
  }
  if (stats.invalid > 0) {
    bits.push(`${stats.invalid} invalid email${stats.invalid === 1 ? '' : 's'}`);
  }
  if (stats.empty > 0) {
    bits.push(`${stats.empty} empty row${stats.empty === 1 ? '' : 's'}`);
  }
  if (!bits.length) return '';
  return `${bits.join(', ')} removed`;
}

export function buildImportSummary({ total, inserted, updated, duplicates_removed = 0, invalid_removed = 0, empty_removed = 0 }) {
  const parts = [`Imported ${total} contact${total === 1 ? '' : 's'} (${inserted} new, ${updated} updated)`];
  const removed = formatRemovedParts({
    duplicates: duplicates_removed,
    invalid: invalid_removed,
    empty: empty_removed,
  });
  if (removed) parts.push(removed);
  return parts.join('. ');
}
