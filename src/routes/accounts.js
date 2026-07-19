import { Router } from 'express';
import mongoose from 'mongoose';
import GmailAccount from '../models/GmailAccount.js';
import { requireAuth } from '../middleware/auth.js';
import { toApiDoc, toApiDocs } from '../utils/apiTransform.js';
import { ownerFilter } from '../utils/userScope.js';
import { verifyAccountConnection } from '../services/emailService.js';
import { describeSendError, isAuthError } from '../utils/errorClassifier.js';

const router = Router();
router.use(requireAuth);

function publicAccount(doc) {
  const api = toApiDoc(doc);
  delete api.app_password;
  return api;
}

router.get('/', async (req, res, next) => {
  try {
    const accounts = await GmailAccount.find(ownerFilter(req.user.id)).sort({ created_at: -1 });
    res.json(toApiDocs(accounts, () => ({})).map((a) => {
      delete a.app_password;
      return a;
    }));
  } catch (err) {
    next(err);
  }
});

router.get('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'Account not found' });
    }
    const account = await GmailAccount.findOne(ownerFilter(req.user.id, { _id: req.params.id }));
    if (!account) return res.status(404).json({ error: 'Account not found' });
    res.json(publicAccount(account));
  } catch (err) {
    next(err);
  }
});

router.post('/', async (req, res, next) => {
  try {
    const { label, email, app_password, daily_send_limit } = req.body;

    if (!label?.trim() || !email?.trim() || !app_password?.trim()) {
      return res.status(400).json({ error: 'Label, email, and app password are required' });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Uniqueness is per user, so a duplicate here always means *this* user
    // already has this address. Say that, and point at the deactivated case —
    // an inactive account is invisible in the default list, so "already
    // registered" looked like a phantom conflict.
    const existing = await GmailAccount.findOne(ownerFilter(req.user.id, { email: cleanEmail }));
    if (existing) {
      return res.status(409).json({
        error: existing.is_active
          ? 'You have already added this Gmail account.'
          : 'You already have this Gmail account, but it is deactivated. Reactivate it instead of adding it again.',
        code: existing.is_active ? 'ACCOUNT_EXISTS' : 'ACCOUNT_EXISTS_INACTIVE',
        account_id: existing._id.toString(),
      });
    }

    const account = await GmailAccount.create({
      user_id: req.user.id,
      label: label.trim(),
      email: cleanEmail,
      app_password: app_password.trim(),
      daily_send_limit: daily_send_limit || null,
    });

    res.status(201).json(publicAccount(account));
  } catch (err) {
    // Backstop for the race the check above cannot close.
    if (err.code === 11000) {
      return res.status(409).json({
        error: 'You have already added this Gmail account.',
        code: 'ACCOUNT_EXISTS',
      });
    }
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const account = await GmailAccount.findOne(ownerFilter(req.user.id, { _id: req.params.id }));
    if (!account) return res.status(404).json({ error: 'Account not found' });

    const { label, email, app_password, is_active, daily_send_limit } = req.body;

    if (label !== undefined) account.label = label.trim();
    if (email !== undefined) account.email = email.trim().toLowerCase();
    if (app_password !== undefined) account.app_password = app_password.trim();
    if (is_active !== undefined) account.is_active = Boolean(is_active);
    if (daily_send_limit !== undefined) account.daily_send_limit = daily_send_limit || null;

    await account.save();
    res.json(publicAccount(account));
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({
        error: 'You already have another Gmail account using that address.',
        code: 'ACCOUNT_EXISTS',
      });
    }
    next(err);
  }
});

// Lets a user confirm an App Password actually authenticates before committing a
// campaign to it — a rejected password otherwise only surfaces mid-send.
router.post('/:id/verify', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const account = await GmailAccount.findOne(ownerFilter(req.user.id, { _id: req.params.id }));
    if (!account) return res.status(404).json({ error: 'Account not found' });

    try {
      await verifyAccountConnection(account);
    } catch (err) {
      return res.status(400).json({
        ok: false,
        error: describeSendError(err, { accountEmail: account.email }),
        code: isAuthError(err) ? 'GMAIL_AUTH_FAILED' : 'GMAIL_CONNECTION_FAILED',
      });
    }

    res.json({ ok: true, message: `${account.email} authenticated successfully` });
  } catch (err) {
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'Account not found' });
    }
    const result = await GmailAccount.findOneAndDelete(ownerFilter(req.user.id, { _id: req.params.id }));
    if (!result) return res.status(404).json({ error: 'Account not found' });
    res.json({ message: 'Account deleted' });
  } catch (err) {
    next(err);
  }
});

export default router;
