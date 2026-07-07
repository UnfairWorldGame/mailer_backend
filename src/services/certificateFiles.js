import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import { fileURLToPath } from 'url';
import yauzl from 'yauzl';
import { certConfig } from '../config/certConfig.js';
import { detectCertificateFileType } from '../utils/fileSignature.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Per-job temp root. Cleaned per-job after completion; nothing here is durable.
export const JOBS_ROOT = path.join(__dirname, '../../uploads/jobs');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Create an isolated job folder and return { dirName, absPath, pdfDir }.
export function createJobDir() {
  ensureDir(JOBS_ROOT);
  const dirName = `job-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;
  const absPath = path.join(JOBS_ROOT, dirName);
  const pdfDir = path.join(absPath, 'pdfs');
  fs.mkdirSync(pdfDir, { recursive: true });
  return { dirName, absPath, pdfDir };
}

export function jobDirPath(dirName) {
  return path.join(JOBS_ROOT, dirName);
}

export function pdfPath(dirName, storedName) {
  // storedName is a server-generated basename; guard against traversal anyway.
  const safe = path.basename(storedName);
  return path.join(JOBS_ROOT, dirName, 'pdfs', safe);
}

// Some Windows zip tools write backslash path separators in entry names
// (non-standard, but real). path.basename() on a POSIX production server
// (Linux/Render) does NOT treat backslash as a separator, so an unnormalized
// name like "Certificates\John Doe.pdf" would survive as the "basename"
// verbatim — corrupting the name-matching step later. Normalize up front.
function normalizeEntryPath(entryName) {
  return String(entryName || '').replace(/\\/g, '/');
}

// True if an entry is definitely NOT real certificate content — a directory,
// macOS resource-fork junk, a hidden file, or a path-traversal attempt.
// Deliberately does NOT check the file extension: some export tools produce
// PDFs with no extension, an unexpected extension, or double extensions, and
// requiring ".pdf" in the name rejected genuinely valid certificates. The
// actual PDF-ness is decided later by the magic-byte check on real content —
// name-based filtering here would just be a second, redundant, and fragile
// gate. Expects an already-normalized (forward-slash) path.
function isJunkEntry(entryName) {
  if (/\/$/.test(entryName)) return true;                  // directory
  const base = entryName.split('/').pop();
  if (!base || base.startsWith('.') || base.startsWith('__MACOSX')) return true;
  if (entryName.includes('__MACOSX/')) return true;
  if (path.isAbsolute(entryName) || entryName.split('/').includes('..')) return true;
  return false;
}

// yauzl (and the ZIP format generally) only supports "stored" (0) and
// "deflated" (8) compression for streamed reads. Some tools (e.g. 7-Zip's
// advanced/"Ultra" ZIP settings) can produce entries using other methods
// (bzip2, LZMA, PPMd, AES-encrypted...) which fail to read entirely. Detecting
// this up front gives a much clearer error than a generic stream failure.
function hasSupportedCompression(entry) {
  return entry.compressionMethod === 0 || entry.compressionMethod === 8;
}

// Stream-extract every real certificate (PDF, PNG, or JPEG) from a ZIP into
// destDir — judged purely by content (magic bytes), not filename/extension,
// so certificates with an unusual, missing, or wrong extension still extract
// correctly. Enforces entry-count, per-file, and total-size limits (zip-bomb
// protection). Returns { files, stats } where
// files = [{stored_name, original_name, size, mime_type, file_type}] and
// stats breaks down exactly why anything was skipped/rejected (plus a sample
// of entry names actually seen), so the caller can surface an actionable
// error instead of a generic one.
export function extractPdfsFromZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) {
        return reject(new Error('The ZIP file is invalid or corrupted and could not be opened.'));
      }

      const files = [];
      const stats = {
        total_entries: 0,
        extracted: 0,
        skipped_junk: 0,
        rejected_oversized: 0,
        rejected_unsupported_type: 0,
        rejected_unsupported_compression: 0,
        rejected_stream_error: 0,
        // First few non-junk entry names seen, for diagnostics when nothing
        // extracts — lets the error message show the user exactly what was
        // in their ZIP instead of a dead-end message.
        sample_entry_names: [],
      };
      const MAX_SAMPLE_NAMES = 8;
      let totalBytes = 0;
      let settled = false;

      const fail = (message) => {
        if (settled) return;
        settled = true;
        zip.close();
        reject(new Error(message));
      };

      const done = () => {
        if (settled) return;
        settled = true;
        resolve({ files, stats });
      };

      zip.on('error', () => fail('The ZIP file is invalid or corrupted.'));
      zip.on('end', done);

      zip.readEntry();
      zip.on('entry', (entry) => {
        stats.total_entries += 1;
        const entryName = normalizeEntryPath(entry.fileName);

        if (isJunkEntry(entryName)) {
          stats.skipped_junk += 1;
          return zip.readEntry();
        }

        if (stats.sample_entry_names.length < MAX_SAMPLE_NAMES) {
          stats.sample_entry_names.push(path.basename(entryName));
        }

        if (files.length >= certConfig.maxPdfCount) {
          return fail(`ZIP contains more than the allowed ${certConfig.maxPdfCount.toLocaleString()} certificates.`);
        }

        if (!hasSupportedCompression(entry)) {
          stats.rejected_unsupported_compression += 1;
          return zip.readEntry();
        }

        const uncompressed = entry.uncompressedSize || 0;
        if (uncompressed > certConfig.maxPdfBytes) {
          stats.rejected_oversized += 1;
          return zip.readEntry();
        }
        if (totalBytes + uncompressed > certConfig.maxTotalExtractedBytes) {
          return fail('The certificates exceed the maximum total size allowed. Split the ZIP into smaller batches.');
        }

        zip.openReadStream(entry, async (streamErr, readStream) => {
          if (streamErr || !readStream) {
            stats.rejected_stream_error += 1;
            return zip.readEntry();
          }

          const originalName = path.basename(entryName);
          // Written to a neutral extensionless temp name first — the real
          // extension depends on the detected content type, decided below.
          const tempName = crypto.randomBytes(10).toString('hex');
          const outPath = path.join(destDir, tempName);

          try {
            // Hard cap the number of bytes we write, in case the declared
            // uncompressedSize lies (defense against crafted headers).
            let written = 0;
            const limiter = new Transform({
              transform(chunk, _enc, cb) {
                written += chunk.length;
                if (written > certConfig.maxPdfBytes) {
                  return cb(new Error('pdf too large'));
                }
                cb(null, chunk);
              },
            });
            await pipeline(readStream, limiter, fs.createWriteStream(outPath));

            const detected = await detectCertificateFileType(outPath);
            if (!detected) {
              await fsp.unlink(outPath).catch(() => {});
              stats.rejected_unsupported_type += 1;
              return zip.readEntry();
            }

            const storedName = `${tempName}${detected.extension}`;
            await fsp.rename(outPath, path.join(destDir, storedName));

            totalBytes += written;
            files.push({
              stored_name: storedName,
              original_name: originalName,
              size: written,
              mime_type: detected.mimeType,
              file_type: detected.type,
            });
            stats.extracted += 1;
            zip.readEntry();
          } catch (writeErr) {
            await fsp.unlink(outPath).catch(() => {});
            if (writeErr?.message === 'pdf too large') {
              stats.rejected_oversized += 1;
            } else {
              stats.rejected_stream_error += 1;
            }
            zip.readEntry();
          }
        });
      });
    });
  });
}

// Recursively delete a job's temp folder. Safe to call repeatedly.
export async function removeJobDir(dirName) {
  if (!dirName) return;
  const target = path.join(JOBS_ROOT, path.basename(dirName));
  await fsp.rm(target, { recursive: true, force: true }).catch(() => {});
}
