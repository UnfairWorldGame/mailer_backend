import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { Transform } from 'stream';
import { fileURLToPath } from 'url';
import yauzl from 'yauzl';
import { certConfig } from '../config/certConfig.js';
import { hasPdfMagicBytes } from '../utils/fileSignature.js';

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

// True if an entry name is a real, safe PDF file entry (not a dir, macOS junk,
// hidden file, or path-traversal attempt).
function isValidPdfEntry(entryName) {
  if (/\/$/.test(entryName)) return false;                 // directory
  const base = entryName.split('/').pop();
  if (!base || base.startsWith('.') || base.startsWith('__MACOSX')) return false;
  if (entryName.includes('__MACOSX/')) return false;
  if (path.isAbsolute(entryName) || entryName.split('/').includes('..')) return false;
  return /\.pdf$/i.test(base);
}

// Stream-extract every valid PDF from a ZIP into destDir. Enforces entry-count,
// per-file, and total-size limits (zip-bomb protection) and validates the PDF
// magic bytes. Returns { files, stats } where files = [{stored_name, original_name, size}].
export function extractPdfsFromZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) {
        return reject(new Error('The ZIP file is invalid or corrupted and could not be opened.'));
      }

      const files = [];
      const stats = { total_entries: 0, extracted: 0, skipped_non_pdf: 0, rejected: 0 };
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

        if (!isValidPdfEntry(entry.fileName)) {
          stats.skipped_non_pdf += 1;
          return zip.readEntry();
        }

        if (files.length >= certConfig.maxPdfCount) {
          return fail(`ZIP contains more than the allowed ${certConfig.maxPdfCount.toLocaleString()} certificates.`);
        }

        const uncompressed = entry.uncompressedSize || 0;
        if (uncompressed > certConfig.maxPdfBytes) {
          stats.rejected += 1;
          return zip.readEntry();
        }
        if (totalBytes + uncompressed > certConfig.maxTotalExtractedBytes) {
          return fail('The certificates exceed the maximum total size allowed. Split the ZIP into smaller batches.');
        }

        zip.openReadStream(entry, async (streamErr, readStream) => {
          if (streamErr || !readStream) {
            stats.rejected += 1;
            return zip.readEntry();
          }

          const originalName = path.basename(entry.fileName);
          const storedName = `${crypto.randomBytes(10).toString('hex')}.pdf`;
          const outPath = path.join(destDir, storedName);

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

            if (!(await hasPdfMagicBytes(outPath))) {
              await fsp.unlink(outPath).catch(() => {});
              stats.rejected += 1;
              return zip.readEntry();
            }

            totalBytes += written;
            files.push({ stored_name: storedName, original_name: originalName, size: written });
            stats.extracted += 1;
            zip.readEntry();
          } catch {
            await fsp.unlink(outPath).catch(() => {});
            stats.rejected += 1;
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
