import fsp from 'fs/promises';

// Client-supplied mimetype/extension are trivially spoofable — verify the
// actual file signature before trusting an upload is really a PDF.
export async function hasPdfMagicBytes(filePath) {
  let fh;
  try {
    fh = await fsp.open(filePath, 'r');
    const buf = Buffer.alloc(5);
    const { bytesRead } = await fh.read(buf, 0, 5, 0);
    return bytesRead >= 4 && buf.toString('latin1', 0, 4) === '%PDF';
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
