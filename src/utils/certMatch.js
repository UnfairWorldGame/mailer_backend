import XLSX from 'xlsx';
import { isValidEmail, normalizeEmail, findColumn } from './contactParser.js';
import { certConfig } from '../config/certConfig.js';

const EMAIL_HEADER_CANDIDATES = ['email', 'e-mail', 'email address', 'mail', 'gmail'];
const NAME_HEADER_CANDIDATES = ['name', 'full name', 'fullname', 'contact name', 'recipient', 'recipient name'];

// Normalize a name or filename for case/space/punctuation-insensitive matching:
// lowercase, strip accents, keep only [a-z0-9]. "John O'Brien-Smith .pdf" -> "johnobriensmith".
const COMBINING_MARKS = /[̀-ͯ]/g;

// NFKD decomposes most accented Latin letters into base + combining mark, but a
// handful of characters have no decomposition (the diacritic is part of the
// glyph). Without this map they are stripped entirely by the [^a-z0-9] filter,
// so "Michał Nowak" would collapse to "michanowak" — colliding with a genuinely
// different person named "Micha Nowak" and handing one of them the other's
// certificate. Map them to their conventional base letters first.
const NON_DECOMPOSING_LATIN = /[łøđæœßðþıħŧŋ]/g;
const LATIN_BASE = {
  'ł': 'l', 'ø': 'o', 'đ': 'd', 'æ': 'ae', 'œ': 'oe',
  'ß': 'ss', 'ð': 'd', 'þ': 'th', 'ı': 'i', 'ħ': 'h', 'ŧ': 't', 'ŋ': 'n',
};

function foldLatin(lowercased) {
  return lowercased.replace(NON_DECOMPOSING_LATIN, (ch) => LATIN_BASE[ch] || ch);
}

export function normalizeKey(value) {
  return foldLatin(String(value ?? '').toLowerCase())
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^a-z0-9]/g, '');
}

// Certificate extraction now matches PDFs by content, not filename/extension
// (see certificateFiles.js), so a real certificate can arrive with a missing,
// wrong, or unusual extension (e.g. no extension, ".docx", ".PDF"). Matching
// must be equally extension-agnostic — strip whatever trailing extension is
// present (if any), not just ".pdf", so "John Doe.docx" still matches "John Doe".
function stripFileExtension(filename) {
  return String(filename ?? '').replace(/\.[^.\s]+$/, '');
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
  return foldLatin(String(value ?? '').toLowerCase())
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// A \b-bounded, whitespace-tolerant regex for finding `normalizedName` as a
// whole phrase inside normalized page text. Safe to build from
// normalizeForTextSearch output — it only ever contains [a-z0-9 ].
function buildNamePhraseRegex(normalizedName, flags = 'i') {
  if (!normalizedName) return null;
  const pattern = normalizedName.split(' ').filter(Boolean).join('\\s+');
  return new RegExp(`\\b${pattern}\\b`, flags);
}

// Words that legitimately sit next to a printed name on a certificate. A word
// adjacent to a name match that is NOT one of these is most likely another part
// of the holder's actual name — see hasStandaloneOccurrence.
const NAME_BOUNDARY_WORDS = new Set([
  // connectives / articles / verbs
  'a', 'an', 'the', 'to', 'of', 'for', 'in', 'on', 'at', 'by', 'is', 'was', 'has',
  'have', 'been', 'and', 'with', 'from', 'this', 'that', 'as', 'it', 'we', 'our',
  'their', 'his', 'her', 'they', 'hereby', 'duly', 'successfully',
  // titles / honorifics
  'mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'shri', 'smt', 'sri', 'sh', 'er', 'ca',
  // certificate vocabulary
  'certificate', 'certificates', 'certification', 'certified', 'certify', 'certifies',
  'award', 'awards', 'awarded', 'present', 'presents', 'presented', 'issued', 'issue',
  'completion', 'complete', 'completed', 'completing', 'participation', 'participant',
  'participated', 'achievement', 'achieved', 'attendance', 'attended', 'appreciation',
  'excellence', 'merit', 'honor', 'honour', 'recognition', 'recognising', 'recognizing',
  'course', 'courses', 'program', 'programme', 'workshop', 'training', 'internship',
  'event', 'seminar', 'webinar', 'conference', 'bootcamp', 'hackathon', 'competition',
  'contest', 'quiz', 'session', 'sessions', 'module', 'level', 'grade', 'score',
  'marks', 'rank', 'position', 'first', 'second', 'third', 'winner', 'runner',
  'date', 'dated', 'day', 'month', 'year', 'signature', 'signed', 'director',
  'principal', 'head', 'organizer', 'organiser', 'coordinator', 'president',
  'secretary', 'founder', 'ceo', 'cto', 'manager', 'instructor', 'mentor', 'faculty',
  'department', 'college', 'university', 'institute', 'school', 'academy', 'company',
  'roll', 'no', 'id', 'number', 'batch', 'class', 'section', 'reg', 'registration',
  // months
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

// A word adjacent to a name match reads as "more of the same name" when it is
// alphabetic, at least two letters (single letters are middle initials, which
// are fine), and not ordinary certificate/English vocabulary.
function isNameContinuation(word) {
  if (!word || !/^[a-z]{2,}$/.test(word)) return false;
  return !NAME_BOUNDARY_WORDS.has(word);
}

// Words that mark the name beside them as the person who SIGNED the
// certificate, not the person it was awarded to.
//
// These all live in NAME_BOUNDARY_WORDS (so they correctly stop a name from
// looking like it continues), and that had an unintended consequence: an
// occurrence like "Ravi Menon, Coordinator" counted as a clean standalone
// match. If that coordinator is also an attendee in the sheet, and no other
// sheet-listed name is extractable from the page, the page matched him
// exclusively and he was mailed a stranger's certificate — labelled `exact`,
// so it never even reached the needs-review gate. Sending one person another
// person's certificate is unrecoverable, so an occurrence that is
// signatory-shaped no longer counts as evidence of holding.
const SIGNATORY_WORDS = new Set([
  'signature', 'signed', 'director', 'principal', 'head', 'organizer', 'organiser',
  'coordinator', 'president', 'secretary', 'founder', 'ceo', 'cto', 'manager',
  'instructor', 'mentor', 'faculty', 'convenor', 'convener', 'dean', 'hod',
]);

function isSignatoryMarker(word) {
  return Boolean(word) && SIGNATORY_WORDS.has(word);
}

// True when `normalizedName` appears on the page at least once WITHOUT an extra
// name word butted up against either side.
//
// A bare \b-bounded regex is not enough on its own: searching "ram kumar"
// against a page that reads "awarded to Ram Kumar Yadav" matches, because the
// boundary after "kumar" is satisfied by the following space. That silently
// hands Ram Kumar a certificate belonging to Ram Kumar Yadav whenever the
// longer name is absent from the sheet (so the cross-candidate pruning in
// matchCertificatesFromPdfPages has nothing to prune against).
//
// Requiring only ONE clean occurrence — rather than all of them — keeps the
// common layout working, where the holder's name is printed once as a heading
// and may also appear inside a longer sentence elsewhere on the page.
function hasStandaloneOccurrence(normText, normalizedName) {
  const re = buildNamePhraseRegex(normalizedName, 'gi');
  if (!re || !normText) return false;

  let match;
  while ((match = re.exec(normText)) !== null) {
    const before = normText.slice(0, match.index).trimEnd().split(' ').pop() || '';
    const afterText = normText.slice(match.index + match[0].length).trimStart();
    const after = afterText ? afterText.split(' ')[0] : '';
    if (isNameContinuation(before) || isNameContinuation(after)) continue;
    // Adjacent to a signatory marker — this is who signed the certificate, not
    // who earned it. Keep looking for an occurrence that reads like a holder.
    if (isSignatoryMarker(before) || isSignatoryMarker(after)) continue;
    return true;
  }
  return false;
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
        match_confidence: 'exact',
        send_status: 'skipped', matched_file: null, original_pdf_name: null, file_size: 0, mime_type: null,
      },
    };
  }

  if (seenEmails.has(email)) {
    return {
      skip: true,
      recipient: {
        name, email, normalized_name: normalizeKey(name),
        match_status: 'duplicate', match_note: 'Duplicate email — already listed above.',
        match_confidence: 'exact',
        send_status: 'skipped', matched_file: null, original_pdf_name: null, file_size: 0, mime_type: null,
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
    const key = normalizeKey(stripFileExtension(f.original_name));
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
    matched: 0, missing_certificate: 0, invalid_email: 0, duplicate: 0, ambiguous_name: 0, needs_review: 0,
  };

  // Resolve a certificate for one of `keys`, in priority order.
  //
  // Returns { file, via } on a clean hit, { ambiguous: true, count } when two or
  // more DIFFERENT files normalize to the same key, and null when nothing
  // matched. The ambiguity check matters: "JOHN SMITH.pdf" and "John_Smith.pdf"
  // are two distinct people's certificates that collapse to one key, and simply
  // shift()-ing the first hands out whichever the ZIP happened to list first —
  // a coin flip between two real recipients. Row-side duplicate names are
  // already guarded by rowNameCounts; this is the file-side mirror of that.
  const takeFile = (lookups) => {
    for (const { key, via } of lookups) {
      if (!key) continue;
      const bucket = fileBuckets.get(key);
      if (!bucket || !bucket.length) continue;
      if (bucket.length > 1) return { ambiguous: true, count: bucket.length };
      return { file: bucket.shift(), via };
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
    const emailKey = normalizeKey(emailLocalPart(email));
    const nameIsAmbiguous = nameKey && (rowNameCounts.get(nameKey) || 0) > 1;
    const lookups = nameIsAmbiguous
      ? [{ key: emailKey, via: 'email' }]
      : [{ key: nameKey, via: 'name' }, { key: emailKey, via: 'email' }];
    const hit = takeFile(lookups);

    if (hit?.ambiguous) {
      stats.ambiguous_name++;
      recipients.push({
        name, email, normalized_name: nameKey,
        match_status: 'ambiguous_name',
        match_note: `${hit.count} certificate files have names that match "${name}" equally well — sending one of them would be a guess. Give the files distinct names (or name them after each person's email address) and re-upload.`,
        match_confidence: 'exact',
        send_status: 'skipped', matched_file: null, original_pdf_name: null, file_size: 0, mime_type: null,
      });
      continue;
    }

    if (!hit) {
      if (nameIsAmbiguous) {
        stats.ambiguous_name++;
        recipients.push({
          name, email, normalized_name: nameKey,
          match_status: 'ambiguous_name',
          match_note: `${rowNameCounts.get(nameKey)} recipients share the name "${name}" — couldn't safely tell them apart by name alone. Rename certificate files to match each person's email, or send manually.`,
          match_confidence: 'exact',
          send_status: 'skipped', matched_file: null, original_pdf_name: null, file_size: 0, mime_type: null,
        });
      } else {
        stats.missing_certificate++;
        recipients.push({
          name, email, normalized_name: nameKey,
          match_status: 'missing_certificate',
          match_note: 'No certificate PDF matched this name.',
          match_confidence: 'exact',
          send_status: 'skipped', matched_file: null, original_pdf_name: null, file_size: 0, mime_type: null,
        });
      }
      continue;
    }

    const { file, via } = hit;
    // An email-local-part hit is a fallback, not an identification. Local parts
    // are routinely bare first names, nicknames, or shared team addresses, so
    // "Priya Sharma <priya@…>" happily claims "Priya.pdf" even when that file
    // belongs to Priya Verma. Still sendable, but flagged so a human confirms
    // it on the review screen rather than it going out silently.
    const matchedByEmail = via === 'email';
    if (matchedByEmail) stats.needs_review++;

    consumed.add(file.stored_name);
    stats.matched++;
    recipients.push({
      name, email, normalized_name: nameKey,
      match_status: 'matched',
      match_note: matchedByEmail
        ? `Matched on the email address "${emailLocalPart(email)}" rather than the name "${name}" — confirm this is the right certificate before sending.`
        : '',
      match_confidence: matchedByEmail ? 'email_fallback' : 'exact',
      send_status: 'pending',
      matched_file: file.stored_name,
      original_pdf_name: file.original_name,
      file_size: file.size,
      mime_type: file.mime_type || 'application/pdf',
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
    matched: 0, missing_certificate: 0, invalid_email: 0, duplicate: 0, ambiguous_name: 0, needs_review: 0,
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
        match_confidence: 'exact',
        send_status: 'skipped', matched_file: null, original_pdf_name: null, file_size: 0, mime_type: null,
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

  // A page only counts as matching a candidate when the name appears there
  // standalone — not swallowed inside a longer printed name. See
  // hasStandaloneOccurrence for why a bare \b-bounded test is unsafe here.
  const rawPageMatches = normalizedPages.map((page) =>
    candidates.filter((c) => hasStandaloneOccurrence(page.normText, c.nameKey)).map((c) => c.rowIndex)
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
      // A group of one is a genuine unique match. A group of two or more shares
      // a name, so the pairing rests entirely on the assumption that the export
      // tool emitted pages in sheet order — right most of the time, and wrong in
      // exactly the way that swaps two same-named people's certificates if the
      // sheet was re-sorted after export. Sendable, but flagged for confirmation.
      const orderPaired = rowIndexesInGroup.length > 1;
      sortedRows.forEach((rowIndex, i) => {
        const pageIdx = sortedPages[i];
        const page = normalizedPages[pageIdx];
        const c = byRowIndex.get(rowIndex);
        consumedPages.add(pageIdx);
        stats.matched++;
        if (orderPaired) stats.needs_review++;
        pendingRecipients[rowIndex] = {
          name: c.name, email: c.email, normalized_name: normalizeKey(c.name),
          match_status: 'matched',
          match_note: orderPaired
            ? `${rowIndexesInGroup.length} recipients share this name — paired to page ${page.page_number} by document order (sheet row order ↔ PDF page order), not by anything printed on the page. Open the preview and confirm it is the right person before sending.`
            : '',
          match_confidence: orderPaired ? 'name_order' : 'exact',
          send_status: 'pending',
          matched_file: page.stored_name,
          original_pdf_name: `${c.name} (Page ${page.page_number}).pdf`,
          file_size: page.size,
          mime_type: 'application/pdf',
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
          match_confidence: 'exact',
          send_status: 'skipped', matched_file: null, original_pdf_name: null, file_size: 0, mime_type: null,
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
        match_confidence: 'exact',
        send_status: 'skipped', matched_file: null, original_pdf_name: null, file_size: 0, mime_type: null,
      };
    }
  }

  rows.forEach((_row, rowIndex) => recipients.push(pendingRecipients[rowIndex]));

  const unmatchedPdfs = normalizedPages
    .filter((_p, idx) => !consumedPages.has(idx))
    .map((p) => `Page ${p.page_number}.pdf`);

  return { recipients, unmatchedPdfs, stats };
}
