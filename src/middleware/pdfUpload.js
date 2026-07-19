import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const attachmentDir = path.join(__dirname, '../../attachments');

if (!fs.existsSync(attachmentDir)) {
  fs.mkdirSync(attachmentDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, attachmentDir),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname).toLowerCase()}`);
  },
});

const fileFilter = (_req, file, cb) => {
  if (file.mimetype === 'application/pdf' || path.extname(file.originalname).toLowerCase() === '.pdf') {
    cb(null, true);
  } else {
    cb(new Error('Only PDF files are allowed'));
  }
};

export const pdfUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 25 * 1024 * 1024 },
});

// Attachments used to be stored as absolute paths, so a campaign whose files
// were uploaded on one host (e.g. /opt/render/project/src/attachments/x.pdf)
// fails with ENOENT everywhere else — on Windows it even resolves to
// C:\opt\render\... New rows store the bare filename; this resolves both.
export function resolveAttachmentPath(storedPath) {
  if (!storedPath) return null;
  const filename = String(storedPath).split(/[\\/]/).pop();
  const local = path.join(attachmentDir, filename);
  if (fs.existsSync(local)) return local;
  // Fall back to the literal stored value so legacy absolute paths still work
  // when the process really is running on the host that wrote them.
  return fs.existsSync(storedPath) ? storedPath : local;
}

export { attachmentDir };
