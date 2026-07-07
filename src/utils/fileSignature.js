import fsp from 'fs/promises';

// The PDF spec (ISO 32000-1 §7.5.2) explicitly permits the file to begin with
// a small amount of leading garbage (comments, a byte-order-mark, etc.) before
// the "%PDF-" header — real PDF readers scan for it rather than requiring it
// at byte 0. Some PDF generators/repackagers (and cloud-sync/export tools)
// take advantage of this, so requiring the marker at offset 0 rejects
// perfectly valid PDFs. Scan a generous leading window instead.
const PDF_HEADER_SCAN_BYTES = 1024;

// Client-supplied mimetype/extension are trivially spoofable — verify the
// actual file signature before trusting an upload is really a PDF.
export async function hasPdfMagicBytes(filePath) {
  let fh;
  try {
    fh = await fsp.open(filePath, 'r');
    const buf = Buffer.alloc(PDF_HEADER_SCAN_BYTES);
    const { bytesRead } = await fh.read(buf, 0, PDF_HEADER_SCAN_BYTES, 0);
    if (bytesRead < 4) return false;
    return buf.subarray(0, bytesRead).includes('%PDF-');
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
}

// True if the file starts with a ZIP local-file-header signature (PK\x03\x04)
// or the empty-archive end-of-central-directory signature (PK\x05\x06).
export async function hasZipMagicBytes(filePath) {
  let fh;
  try {
    fh = await fsp.open(filePath, 'r');
    const buf = Buffer.alloc(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    if (bytesRead < 4) return false;
    const sig = buf.readUInt32LE(0);
    return sig === 0x04034b50 || sig === 0x06054b50;
  } catch {
    return false;
  } finally {
    await fh?.close().catch(() => {});
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Certificates inside a ZIP can be PDF, PNG, or JPEG — detected purely by
// content (never by filename/extension, which is both spoofable and
// unreliable — see certificateFiles.js). Returns null if the file matches
// none of the supported certificate formats.
export async function detectCertificateFileType(filePath) {
  let fh;
  try {
    fh = await fsp.open(filePath, 'r');
    const buf = Buffer.alloc(PDF_HEADER_SCAN_BYTES);
    const { bytesRead } = await fh.read(buf, 0, PDF_HEADER_SCAN_BYTES, 0);
    if (bytesRead < 3) return null;

    if (bytesRead >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
      return { type: 'png', mimeType: 'image/png', extension: '.png' };
    }
    // JPEG/JFIF/EXIF variants all start with the FF D8 FF marker.
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
      return { type: 'jpeg', mimeType: 'image/jpeg', extension: '.jpg' };
    }
    if (buf.subarray(0, bytesRead).includes('%PDF-')) {
      return { type: 'pdf', mimeType: 'application/pdf', extension: '.pdf' };
    }
    return null;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}
