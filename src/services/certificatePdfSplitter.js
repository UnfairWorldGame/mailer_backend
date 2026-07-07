import fsp from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { PDFDocument } from 'pdf-lib';
// pdfjs-dist v6+'s "legacy" build requires browser globals (DOMMatrix, etc.)
// that don't exist in plain Node. v4.x's legacy build works headlessly for
// text extraction — keep this pinned to the 4.x line (see backend package.json).
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { certConfig } from '../config/certConfig.js';

function friendlyLoadError(err) {
  const msg = String(err?.message || err || '');
  if (/encrypt/i.test(msg) || err?.name === 'EncryptedPDFError') {
    return new Error('The PDF is password-protected. Remove the password and upload it again.');
  }
  return new Error('Could not read the PDF. Make sure it is a valid, uncorrupted PDF file.');
}

// Split a multi-page PDF (e.g. a Canva export with one certificate per page)
// into individual single-page PDFs, and extract each page's text so the
// caller can match pages to recipients by the printed name. Mirrors
// extractPdfsFromZip's return shape ({ files, stats }) plus a pageTexts map,
// so downstream persistence/send code needs no branching on upload source.
export async function splitCertificatePdf(pdfPath, destDir) {
  const { size } = await fsp.stat(pdfPath);
  if (size > certConfig.maxSinglePdfBytes) {
    throw new Error(
      `PDF is too large (max ${Math.round(certConfig.maxSinglePdfBytes / (1024 * 1024))}MB for a single multi-page PDF). ` +
      'Split it into smaller batches or upload a ZIP of individual PDFs instead.'
    );
  }

  const bytes = await fsp.readFile(pdfPath);

  let srcDoc;
  // pdf-lib's .load() can succeed "permissively" on non-PDF garbage that merely
  // starts with a %PDF header, then throw later from getPageCount()/copyPages()
  // when it tries to walk a page tree that was never actually parsed — so the
  // page-count check has to be inside the same catch, not just .load() itself.
  let pageCount;
  try {
    srcDoc = await PDFDocument.load(bytes, { ignoreEncryption: false });
    pageCount = srcDoc.getPageCount();
  } catch (err) {
    throw friendlyLoadError(err);
  }

  if (pageCount === 0) {
    throw new Error('The PDF has no pages.');
  }
  if (pageCount > certConfig.maxPdfCount) {
    throw new Error(`PDF has more than the allowed ${certConfig.maxPdfCount.toLocaleString()} pages.`);
  }

  // Extract per-page text via pdfjs-dist (read-only; pdf-lib has no text API).
  // Pass a fresh copy — the two libraries parsing the same buffer concurrently
  // is untested territory, and copies are cheap at these size caps.
  const pdfjsDoc = await pdfjsLib.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
  }).promise;

  const files = [];
  const pageTexts = {};
  const stats = { total_pages: pageCount, extracted: 0, rejected: 0 };
  let totalBytes = 0;

  try {
    for (let i = 0; i < pageCount; i++) {
      const pageNumber = i + 1;

      // Text for name matching.
      try {
        const page = await pdfjsDoc.getPage(pageNumber);
        const content = await page.getTextContent();
        pageTexts[pageNumber] = content.items.map((it) => it.str).join(' ');
      } catch {
        pageTexts[pageNumber] = '';
      }

      // Single-page PDF for sending as an attachment. A single malformed page
      // (rare, but real-world PDFs vary) shouldn't fail the whole job — skip
      // and report it instead, same as an oversized page below.
      let outBytes;
      try {
        const outDoc = await PDFDocument.create();
        const [copied] = await outDoc.copyPages(srcDoc, [i]);
        outDoc.addPage(copied);
        outBytes = await outDoc.save();
      } catch {
        stats.rejected += 1;
        continue;
      }

      if (outBytes.length > certConfig.maxPdfBytes) {
        stats.rejected += 1;
        continue;
      }
      if (totalBytes + outBytes.length > certConfig.maxTotalExtractedBytes) {
        throw new Error('The split certificates exceed the maximum total size allowed. Upload a smaller PDF.');
      }

      const storedName = `${crypto.randomBytes(10).toString('hex')}.pdf`;
      await fsp.writeFile(path.join(destDir, storedName), outBytes);

      totalBytes += outBytes.length;
      files.push({
        stored_name: storedName,
        original_name: `Page ${pageNumber}.pdf`,
        size: outBytes.length,
        page_number: pageNumber,
      });
      stats.extracted += 1;
    }
  } finally {
    await pdfjsDoc.destroy().catch(() => {});
  }

  return { files, pageTexts, stats };
}
