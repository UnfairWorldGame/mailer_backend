import { Router } from 'express';
import fs from 'fs';
import XLSX from 'xlsx';
import mongoose from 'mongoose';
import Contact from '../models/Contact.js';
import { upload } from '../middleware/upload.js';
import UploadHistory from '../models/UploadHistory.js';
import { requireAuth } from '../middleware/auth.js';
import { toApiDocs } from '../utils/apiTransform.js';
import { ownerFilter } from '../utils/userScope.js';
import { parseContactsFromRowsDetailed, parseEmailsFromTextDetailed, buildImportSummary } from '../utils/contactParser.js';
import {
  getContactMeta,
  upsertContacts,
  deleteContactsByIds,
  deleteAllContacts,
  buildContactSearchFilter,
} from '../utils/contactImport.js';

const router = Router();
router.use(requireAuth);

function parseContactsFromFile(filePath) {
  let workbook;
  try {
    workbook = XLSX.readFile(filePath);
  } catch {
    throw new Error('Could not read file. Make sure it is a valid Excel or CSV file.');
  }

  if (!workbook.SheetNames?.length) {
    throw new Error('File does not contain any sheets');
  }

  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  return parseContactsFromRowsDetailed(rows);
}

async function importContacts(userId, contacts, sourceLabel, stats = {}) {
  const duplicates_removed = stats.duplicates ?? 0;
  const invalid_removed = stats.invalid ?? 0;
  const empty_removed = stats.empty ?? 0;

  if (contacts.length === 0) {
    const removed = [
      duplicates_removed ? `${duplicates_removed} duplicate(s)` : '',
      invalid_removed ? `${invalid_removed} invalid email(s)` : '',
      empty_removed ? `${empty_removed} empty row(s)` : '',
    ].filter(Boolean).join(', ');

    await UploadHistory.create({
      user_id: userId,
      filename: sourceLabel,
      total_rows: 0,
      status: 'failed',
      error_message: removed ? `No valid emails. ${removed} removed` : 'No valid email addresses found',
    });

    return {
      error: removed
        ? `No valid email addresses found. ${removed} removed.`
        : 'No valid email addresses found',
      status: 400,
    };
  }

  const { inserted, updated, total } = await upsertContacts(contacts, userId);

  await UploadHistory.create({
    user_id: userId,
    filename: sourceLabel,
    total_rows: total,
    inserted,
    updated,
    status: 'success',
  });

  const meta = await getContactMeta(userId);
  const summary = buildImportSummary({
    total,
    inserted,
    updated,
    duplicates_removed,
    invalid_removed,
    empty_removed,
  });

  return {
    status: 200,
    body: {
      message: 'Contacts imported successfully',
      summary,
      total,
      inserted,
      updated,
      duplicates_removed,
      invalid_removed,
      empty_removed,
      ...meta,
    },
  };
}

router.get('/history', async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 100);
    const history = await UploadHistory.find(ownerFilter(req.user.id))
      .sort({ created_at: -1 })
      .limit(limit);
    res.json(toApiDocs(history));
  } catch (err) {
    next(err);
  }
});

router.get('/contacts', async (req, res, next) => {
  try {
    const page = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10), 1), 500);
    const search = req.query.search || '';
    const filter = buildContactSearchFilter(search, req.user.id);
    const skip = (page - 1) * limit;

    const [contacts, total, meta] = await Promise.all([
      Contact.find(filter).sort({ created_at: -1 }).skip(skip).limit(limit),
      Contact.countDocuments(filter),
      getContactMeta(req.user.id),
    ]);

    res.json({
      data: toApiDocs(contacts),
      total,
      page,
      limit,
      has_names: meta.has_names,
      count: meta.count,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/contacts/count', async (req, res, next) => {
  try {
    res.json(await getContactMeta(req.user.id));
  } catch (err) {
    next(err);
  }
});

router.delete('/contacts/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    const result = await Contact.findOneAndDelete(ownerFilter(req.user.id, { _id: req.params.id }));
    if (!result) return res.status(404).json({ error: 'Contact not found' });
    res.json({ message: 'Contact deleted', ...(await getContactMeta(req.user.id)) });
  } catch (err) {
    next(err);
  }
});

router.post('/contacts/bulk-delete', async (req, res, next) => {
  try {
    const { ids, all } = req.body || {};

    if (all === true) {
      const result = await deleteAllContacts(req.user.id);
      return res.json({ message: `Deleted ${result.deleted} contact(s)`, ...result });
    }

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Provide contact ids or set all to true' });
    }

    const result = await deleteContactsByIds(ids, req.user.id);
    res.json({ message: `Deleted ${result.deleted} contact(s)`, ...result });
  } catch (err) {
    next(err);
  }
});

router.post('/emails', async (req, res, next) => {
  try {
    const text = req.body?.text ?? '';
    const parsed = Array.isArray(req.body?.emails)
      ? parseEmailsFromTextDetailed(req.body.emails.join('\n'))
      : parseEmailsFromTextDetailed(text);

    const result = await importContacts(req.user.id, parsed.contacts, 'pasted-emails.txt', parsed.stats);
    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }
    res.json(result.body);
  } catch (err) {
    next(err);
  }
});

router.post('/excel', upload.single('file'), async (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const { contacts, stats } = parseContactsFromFile(req.file.path);
    const result = await importContacts(req.user.id, contacts, req.file.originalname, stats);
    if (result.error) {
      return res.status(result.status).json({ error: result.error });
    }
    res.json(result.body);
  } catch (err) {
    await UploadHistory.create({
      user_id: req.user.id,
      filename: req.file.originalname,
      status: 'failed',
      error_message: err.message,
    }).catch(() => {});
    res.status(400).json({ error: err.message });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

export default router;
