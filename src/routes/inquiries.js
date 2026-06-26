import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.js';
import {
  sendOfficeInquiry,
  sendCreditPurchaseRequestConfirmationEmail,
  sendCreditPurchaseTeamNotification,
} from '../services/officeEmailService.js';
import {
  createCreditPurchaseRequest,
  getCreditRequestStatus,
} from '../services/creditPurchaseService.js';

const router = Router();

const inquiryLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.INQUIRY_RATE_LIMIT_MAX || '10', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Please try again later.' },
});

const buyCreditsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.BUY_CREDITS_RATE_LIMIT_MAX || '2', 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.email?.toLowerCase() || req.ip,
  message: { error: 'Too many credit requests. Please try again later.' },
});

function trim(value) {
  return String(value || '').trim();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isValidPhone(phone) {
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 15;
}

router.post('/contact', inquiryLimiter, async (req, res, next) => {
  try {
    const name = trim(req.body?.name);
    const email = trim(req.body?.email).toLowerCase();
    const message = trim(req.body?.message);

    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Name, email, and message are required' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address' });
    }
    if (message.length < 10) {
      return res.status(400).json({ error: 'Message must be at least 10 characters' });
    }

    const subject = `MAILIQ contact from ${name}`;
    const result = await sendOfficeInquiry({
      subject,
      replyTo: email,
      textLines: [
        'New contact form submission',
        '',
        `Name: ${name}`,
        `Email: ${email}`,
        '',
        'Message:',
        message,
      ],
      htmlSections: [
        { label: 'Name', value: name },
        { label: 'Email', value: email },
        { label: 'Message', value: message },
      ],
    });

    if (!result.sent && !result.devLog) {
      return res.status(503).json({ error: result.error || 'Could not send your message. Please email us directly.' });
    }

    res.json({ message: 'Your message has been sent. We will get back to you soon.' });
  } catch (err) {
    next(err);
  }
});

router.get('/buy-credits/status', requireAuth, async (req, res, next) => {
  try {
    const status = await getCreditRequestStatus(req.user.email);
    res.json(status);
  } catch (err) {
    next(err);
  }
});

router.post('/buy-credits', requireAuth, buyCreditsLimiter, async (req, res, next) => {
  try {
    const name = trim(req.user.name);
    const email = trim(req.user.email).toLowerCase();
    const phone = trim(req.body?.phone);
    const packLabel = trim(req.body?.packLabel);
    const price = trim(req.body?.price);
    const mails = trim(req.body?.mails);

    if (!name || !email || !phone || !packLabel) {
      return res.status(400).json({ error: 'Phone number and credit pack are required' });
    }
    if (!isValidPhone(phone)) {
      return res.status(400).json({ error: 'Please enter a valid phone number' });
    }

    await createCreditPurchaseRequest({
      name,
      email,
      phone,
      packLabel,
      price,
      mails,
    });

    const result = await sendCreditPurchaseTeamNotification({
      name,
      email,
      phone,
      packLabel,
      price,
      mails,
    });

    if (!result.sent && !result.devLog) {
      return res.status(503).json({ error: result.error || 'Could not send your request. Please email us directly.' });
    }

    await sendCreditPurchaseRequestConfirmationEmail({
      name,
      email,
      phone,
      packLabel,
      price,
      mails,
    });

    res.json({
      message: 'Your request has been sent. Our team will contact you shortly with payment details.',
      pending: true,
    });
  } catch (err) {
    if (err.code === 'CREDIT_REQUEST_PENDING') {
      return res.status(409).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

export default router;
