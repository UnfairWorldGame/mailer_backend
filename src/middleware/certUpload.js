import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { certConfig } from '../config/certConfig.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Uploads land here first; the route extracts into a per-job folder and deletes
// these originals immediately after.
const incomingDir = path.join(__dirname, '../../uploads/jobs/_incoming');
if (!fs.existsSync(incomingDir)) fs.mkdirSync(incomingDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, incomingDir),
  filename: (_req, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname).toLowerCase()}`);
  },
});

// The 'zip' field (wire name kept for backward compatibility) now accepts
// either a ZIP of individually named PDFs OR a single multi-page PDF — the
// route detects which by the actual file signature, not just this extension
// check, since extensions are trivially spoofable.
const CERT_FILE_EXT = ['.zip', '.pdf'];
const SHEET_EXT = ['.csv', '.xlsx', '.xls'];

const fileFilter = (_req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (file.fieldname === 'zip' && CERT_FILE_EXT.includes(ext)) return cb(null, true);
  if (file.fieldname === 'sheet' && SHEET_EXT.includes(ext)) return cb(null, true);
  cb(new Error(
    file.fieldname === 'zip'
      ? 'The certificates file must be a .zip archive or a single multi-page .pdf.'
      : 'The recipient list must be a .csv, .xlsx, or .xls file.'
  ));
};

export const certUpload = multer({
  storage,
  fileFilter,
  limits: { fileSize: certConfig.maxZipBytes, files: 2 },
}).fields([
  { name: 'zip', maxCount: 1 },
  { name: 'sheet', maxCount: 1 },
]);
