import { Router } from 'express';
import mongoose from 'mongoose';
import GmailAccount from '../models/GmailAccount.js';
import { toApiDoc, toApiDocs } from '../utils/apiTransform.js';

const router = Router();

function publicAccount(doc) {
  const api = toApiDoc(doc);
  delete api.app_password;
  return api;
}

router.get('/', async (_req, res, next) => {
  try {
    const accounts = await GmailAccount.find().sort({ created_at: -1 });
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
    const account = await GmailAccount.findById(req.params.id);
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

    const account = await GmailAccount.create({
      label: label.trim(),
      email: email.trim().toLowerCase(),
      app_password: app_password.trim(),
      daily_send_limit: daily_send_limit || null,
    });

    res.status(201).json(publicAccount(account));
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'This email is already registered' });
    }
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const account = await GmailAccount.findById(req.params.id);
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
      return res.status(409).json({ error: 'This email is already registered' });
    }
    next(err);
  }
});

router.delete('/:id', async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ error: 'Account not found' });
    }
    const result = await GmailAccount.findByIdAndDelete(req.params.id);
    if (!result) return res.status(404).json({ error: 'Account not found' });
    res.json({ message: 'Account deleted' });
  } catch (err) {
    next(err);
  }
});

export default router;
