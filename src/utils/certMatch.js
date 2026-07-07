import XLSX from 'xlsx';
import { isValidEmail, normalizeEmail, findColumn } from './contactParser.js';
import { certConfig } from '../config/certConfig.js';

const EMAIL_HEADER_CANDIDATES = ['email', 'e-mail', 'email address', 'mail', 'gmail'];
const NAME_HEADER_CANDIDATES = ['name', 'full name', 'fullname', 'contact name', 'recipient', 'recipient name'];

// Normalize a name or filename for case/space/punctuation-insensitive matching:
// lowercase, strip accents, keep only [a-z0-9]. "John O'Brien-Smith .pdf" -> "johnobriensmith".
const COMBINING_MARKS = /[̀-ͯ]/g;

export function normalizeKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^a-z0-9]/g, '');
}

function stripPdfExtension(filename) {
  return String(filename ?? '').replace(/\.pdf$/i, '');
}

function emailLocalPart(email) {
  const at = String(email || '').indexOf('@');
  return at > 0 ? email.slice(0, at) : '';
}

// Word-preserving normalization for searching a name INSIDE running text (as
// opposed to normalizeKey, which strips spaces entirely for exact filename-key
// matching). Keeps word boundaries so "Jon" doesn't accidentally match inside
// "Jonathan" when we later build a \b-bounded regex from the result.
function normalizeForTextSearch(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// A \b-bounded, whitespace-tolerant regex for finding `normalizedName` as a
// whole phrase inside normalized page text. Safe to build from
// normalizeForTextSearch output — it only ever contains [a-z0-9 ].
function buildNamePhraseRegex(normalizedName) {
  if (!normalizedName) return null;
  const pattern = normalizedName.split(' ').filter(Boolean).join('\\s+');
  return new RegExp(`\\b${pattern}\\b`, 'i');
}

// Shared invalid-email / duplicate-email classification used by both the
// filename-based and PDF-page-text-based matchers, so both upload modes
// behave identically for these two cases.
function classifyEmailRow(row, seenEmails) {
  const email = normalizeEmail(row.email);
  const name = String(row.name || '').trim();

  if (!isValidEmail(email)) {
    return {
      skip: true,
      recipient: {
        name, email: row.email || '', normalized_name: normalizeKey(name),
        match_status: 'invalid_email', match_note: 'Email address is missing or invalid.',
        send_status: 'skipped', matched_file: null, original_pdf_name: null, file_size: 0,
      },
    };
  }

  if (seenEmails.has(email)) {
    return {
      skip: true,
      recipient: {
        name, email, normalized_name: normalizeKey(name),
        match_status: 'duplicate', match_note: 'Duplicate email — already listed above.',
        send_status: 'skipped', matched_file: null, original_pdf_name: null, file_size: 0,
      },
    };
  }
  seenEmails.add(email);

  return { skip: false, name, email };
}

// Read a CSV/XLSX sheet into raw {name, email} rows. Unlike the contact importer,
// this keeps EVERY data row (including invalid/blank) so the review screen can
// report exactly what happened to each one. Bounded by certConfig.maxRows.
export function readSheetRows(filePath) {
  let workbook;
  try {
    workbook = XLSX.readFile(filePath, { sheetRows: certConfig.maxRows + 1 });
  } catch {
    throw new Error('Could not read the recipient sheet. Upload a valid .csv, .xlsx, or .xls file.');
  }

  const sheetName = workbook.SheetNames?.[0];
  if (!sheetName) throw new Error('The recipient sheet is empty.');

  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' });
  if (!rows.length) throw new Error('The recipient sheet has no rows.');
  if (rows.length > certConfig.maxRows + 1) {
    throw new Error(`Too many rows. Limit is ${certConfig.maxRows.toLocaleString()} recipients per job.`);
  }

  const headers = rows[0].map((c) => String(c ?? '').trim());
  const emailIdx = findColumn(headers, EMAIL_HEADER_CANDIDATES);
  const nameIdx = findColumn(headers, NAME_HEADER_CANDIDATES);

  if (emailIdx === -1) {
    throw new Error('The sheet must have an "Email" column (a "Name" column is recommended for matching).');
  }

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((c) => !String(c ?? '').trim())) continue;
    const name = nameIdx !== -1 ? String(row[nameIdx] ?? '').trim() : '';
    const email = String(row[emailIdx] ?? '').trim();
    if (!name && !email) continue;
    out.push({ name, email });
  }

  return out;
}

// Match parsed rows against extracted PDF files by normalized name (falling back
// to the email local-part). Classifies every row and surfaces leftover PDFs.
//
// files: [{ stored_name, original_name, size }]
// rows:  [{ name, email }]
// returns { recipients, unmatchedPdfs, stats }
export function matchCertificates(rows, files) {
  // Build a lookup of normalized-key -> queue of files. Duplicate filenames that
  // normalize to the same key are kept in order; each is consumed at most once.
  const fileBuckets = new Map();
  for (const f of files) {
    const key = normalizeKey(stripPdfExtension(f.original_name));
    if (!key) continue;
    if (!fileBuckets.has(key)) fileBuckets.set(key, []);
    fileBuckets.get(key).push(f);
  }

  // Count how many recipient rows share each normalized name. When two+ real
  // people share a name, matching by name alone can't tell them apart — handing
  // out same-named files in sheet-row order risks giving one person someone
  // else's certificate. For those rows, only an exact email-local-part match is
  // trusted; a bare name match is treated as ambiguous instead of auto-assigned.
  const rowNameCounts = new Map();
  for (const row of rows) {
    const key = normalizeKey(String(row.name || '').trim());
    if (!key) continue;
    rowNameCounts.set(key, (rowNameCounts.get(key) || 0) + 1);
  }

  const consumed = new Set(); // stored_name values already assigned
  const seenEmails = new Set();
  const recipients = [];
  const stats = {
    matched: 0, missing_certificate: 0, invalid_email: 0, duplicate: 0, ambiguous_name: 0,
  };

  const takeFile = (keys) => {
    for (const key of keys) {
      if (!key) continue;
      const bucket = fileBuckets.get(key);
      if (bucket && bucket.length) {
        return bucket.shift();
      }
    }
    return null;
  };

  for (const row of rows) {
    const classified = classifyEmailRow(row, seenEmails);
    if (classified.skip) {
      stats[classified.recipient.match_status]++;
      recipients.push(classified.recipient);
      continue;
    }
    const { name, email } = classified;

    // Find a certificate by name, then by email local-part — unless this name
    // is shared by more than one row, in which case only the email-local-part
    // match is trusted (see rowNameCounts comment above).
    const nameKey = normalizeKey(name);
    const nameIsAmbiguous = nameKey && (rowNameCounts.get(nameKey) || 0) > 1;
    const lookupKeys = nameIsAmbiguous
      ? [normalizeKey(emailLocalPart(email))]
      : [nameKey, normalizeKey(emailLocalPart(email))];
    const file = takeFile(lookupKeys);
    if (!file) {
      if (nameIsAmbiguous) {
        stats.ambiguous_name++;
        recipients.push({
          name, email, normalized_name: nameKey,
          match_status: 'ambiguous_name',
          match_note: `${rowNameCounts.get(nameKey)} recipients share the name "${name}" — couldn't safely tell them apart by name alone. Rename certificate files to match each person's email, or send manually.`,
          send_status: 'skipped', matched_file: null, original_pdf_name: null, file_size: 0,
        });
      } else {
        stats.missing_certificate++;
        recipients.push({
          name, email, normalized_name: nameKey,
          match_status: 'missing_certificate',
          match_note: 'No certificate PDF matched this name.',
          send_status: 'skipped', matched_file: null, original_pdf_name: null, file_size: 0,
        });
      }
      continue;
    }

    consumed.add(file.stored_name);
    stats.matched++;
    recipients.push({
      name, email, normalized_name: normalizeKey(name),
      match_status: 'matched', match_note: '',
      send_status: 'pending',
      matched_file: file.stored_name,
      original_pdf_name: file.original_name,
      file_size: file.size,
    });
  }

  // Any file never consumed had no matching row.
  const unmatchedPdfs = files
    .filter((f) => !consumed.has(f.stored_name))
    .map((f) => f.original_name);

  return { recipients, unmatchedPdfs, stats };
}

// Match parsed rows against pages of a single multi-page PDF by searching each
// page's extracted text for the recipient's printed name. Unlike filename
// matching (an exact key lookup), free-text search can produce ambiguous
// results in both directions, so this uses a stricter, safety-first algorithm:
//
//   1. A page matches a candidate if the candidate's name appears in the
//      page's text as a whole \b-bounded phrase.
//   2. If a shorter matched name is a bounded substring of another matched
//      name on the SAME page (e.g. "Jon Lee" inside "Jon Lee Park"), the
//      shorter one is dropped for that page — the more specific name wins.
//   3. After that pruning, a (page, candidate) pair is only assigned when it's
//      a MUTUAL unique match: that page matches exactly that one candidate,
//      AND that candidate matches exactly that one page. Anything else
//      (no match, or a genuine one-to-many/many-to-many collision) is left
//      unmatched/ambiguous rather than guessed — wrong certificates are worse
//      than a skipped one.
//
// pages: [{ stored_name, size, page_number, text }]
// rows:  [{ name, email }]
// returns { recipients, unmatchedPdfs, stats }
export function matchCertificatesFromPdfPages(rows, pages) {
  const seenEmails = new Set();
  const recipients = [];
  const stats = {
    matched: 0, missing_certificate: 0, invalid_email: 0, duplicate: 0, ambiguous_name: 0,
  };

  // 1) Classify invalid/duplicate rows up front (identical to the ZIP path);
  // everything else becomes a name-search candidate.
  const candidates = []; // { rowIndex, name, email, nameKey, regex }
  const pendingRecipients = new Array(rows.length).fill(null);

  rows.forEach((row, rowIndex) => {
    const classified = classifyEmailRow(row, seenEmails);
    if (classified.skip) {
      stats[classified.recipient.match_status]++;
      pendingRecipients[rowIndex] = classified.recipient;
      return;
    }
    const { name, email } = classified;
    const nameKey = normalizeForTextSearch(name);
    const regex = buildNamePhraseRegex(nameKey);
    if (!regex) {
      // No name to search for at all — can't be matched from page text alone.
      stats.missing_certificate++;
      pendingRecipients[rowIndex] = {
        name, email, normalized_name: normalizeKey(name),
        match_status: 'missing_certificate',
        match_note: 'No name was provided, so no certificate page could be matched.',
        send_status: 'skipped', matched_file: null, original_pdf_name: null, file_size: 0,
      };
      return;
    }
    candidates.push({ rowIndex, name, email, nameKey, regex });
  });

  // 2) Normalize page text once, then find every candidate whose name-phrase
  // appears on each page.
  const normalizedPages = pages.map((p) => ({
    ...p,
    normText: normalizeForTextSearch(p.text || ''),
  }));

  const rawPageMatches = normalizedPages.map((page) =>
    candidates.filter((c) => c.regex.test(page.normText)).map((c) => c.rowIndex)
  );

  // 3) Per page, drop any matched name that is itself a bounded substring of
  // another matched name on that same page (step 2 in the doc comment above).
  const byRowIndex = new Map(candidates.map((c) => [c.rowIndex, c]));
  const prunedPageMatches = rawPageMatches.map((rowIndexes) => {
    if (rowIndexes.length < 2) return rowIndexes;
    return rowIndexes.filter((idx) => {
      const candidate = byRowIndex.get(idx);
      // Dropped if some OTHER matched candidate has a strictly longer name
      // that this candidate's own name-phrase is found inside of — e.g.
      // "Jon Lee" (idx) is nested inside "Jon Lee Park" (other) — the
      // longer, more specific name wins this page.
      const nestedInAnother = rowIndexes.some((otherIdx) => {
        if (otherIdx === idx) return false;
        const other = byRowIndex.get(otherIdx);
        return other.nameKey.length > candidate.nameKey.length && candidate.regex.test(other.nameKey);
      });
      return !nestedInAnother;
    });
  });

  // 4) Build the inverse map (candidate -> pages it matches, post-pruning).
  const candidateMatches = new Map(candidates.map((c) => [c.rowIndex, []]));
  prunedPageMatches.forEach((rowIndexes, pageIdx) => {
    rowIndexes.forEach((rowIndex) => candidateMatches.get(rowIndex).push(pageIdx));
  });

  // 5) Names are NEVER assumed unique — email is the only unique identifier,
  // so recipients are resolved in groups by normalized name, not one at a time.
  // A group of K same-named recipients is safely resolved when exactly K pages
  // match ONLY candidates from that group (no cross-name collision): pair
  // sheet order with PDF page order, since bulk/mail-merge export tools
  // overwhelmingly emit certificates in the same order as the source sheet.
  // Anything that doesn't line up 1:1 falls back to the previous per-candidate
  // missing/ambiguous classification — never guessed, always reported.
  const groupsByName = new Map(); // nameKey -> [rowIndex, ...]
  for (const c of candidates) {
    if (!groupsByName.has(c.nameKey)) groupsByName.set(c.nameKey, []);
    groupsByName.get(c.nameKey).push(c.rowIndex);
  }

  const consumedPages = new Set();

  for (const rowIndexesInGroup of groupsByName.values()) {
    const groupSet = new Set(rowIndexesInGroup);

    // Pages that match ONLY candidates from this exact name group. A page
    // that also matches a differently-named candidate is a genuine cross-name
    // collision and is never claimed here (falls through to the per-candidate
    // "page mentions another recipient" ambiguity below).
    const exclusivePages = [];
    prunedPageMatches.forEach((matchedRowIndexes, pageIdx) => {
      if (matchedRowIndexes.length === 0) return;
      if (matchedRowIndexes.every((idx) => groupSet.has(idx))) exclusivePages.push(pageIdx);
    });

    if (exclusivePages.length > 0 && exclusivePages.length === rowIndexesInGroup.length) {
      const sortedRows = [...rowIndexesInGroup].sort((a, b) => a - b);
      const sortedPages = [...exclusivePages].sort(
        (a, b) => normalizedPages[a].page_number - normalizedPages[b].page_number
      );
      sortedRows.forEach((rowIndex, i) => {
        const pageIdx = sortedPages[i];
        const page = normalizedPages[pageIdx];
        const c = byRowIndex.get(rowIndex);
        consumedPages.add(pageIdx);
        stats.matched++;
        pendingRecipients[rowIndex] = {
          name: c.name, email: c.email, normalized_name: normalizeKey(c.name),
          match_status: 'matched',
          match_note: rowIndexesInGroup.length > 1
            ? `${rowIndexesInGroup.length} recipients share this name — matched to certificate pages in document order (sheet row order ↔ PDF page order).`
            : '',
          send_status: 'pending',
          matched_file: page.stored_name,
          original_pdf_name: `${c.name} (Page ${page.page_number}).pdf`,
          file_size: page.size,
        };
      });
      continue;
    }

    // Couldn't safely pair the whole group 1:1 — classify each member on its
    // own using every page it matches (not just the name-exclusive ones), so
    // a genuine cross-name collision is still reported as such.
    for (const rowIndex of rowIndexesInGroup) {
      const c = byRowIndex.get(rowIndex);
      const matchedPages = candidateMatches.get(rowIndex);

      if (matchedPages.length === 0) {
        stats.missing_certificate++;
        pendingRecipients[rowIndex] = {
          name: c.name, email: c.email, normalized_name: normalizeKey(c.name),
          match_status: 'missing_certificate',
          match_note: 'No page in the uploaded PDF matched this name.',
          send_status: 'skipped', matched_file: null, original_pdf_name: null, file_size: 0,
        };
        continue;
      }

      const crossNameCollision = matchedPages.some((pageIdx) => prunedPageMatches[pageIdx].length > 1
        && !prunedPageMatches[pageIdx].every((idx) => groupSet.has(idx)));

      stats.ambiguous_name++;
      pendingRecipients[rowIndex] = {
        name: c.name, email: c.email, normalized_name: normalizeKey(c.name),
        match_status: 'ambiguous_name',
        match_note: crossNameCollision
          ? 'The matching page also mentions another recipient\'s name — couldn\'t safely tell them apart.'
          : `${rowIndexesInGroup.length} recipients share this name but ${exclusivePages.length} certificate page(s) matched it — the counts don't line up, so they couldn't be safely paired. Check for a missing or extra certificate page.`,
        send_status: 'skipped', matched_file: null, original_pdf_name: null, file_size: 0,
      };
    }
  }

  rows.forEach((_row, rowIndex) => recipients.push(pendingRecipients[rowIndex]));

  const unmatchedPdfs = normalizedPages
    .filter((_p, idx) => !consumedPages.has(idx))
    .map((p) => `Page ${p.page_number}.pdf`);

  return { recipients, unmatchedPdfs, stats };
}
