import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { generateEmail, rewriteEmail } from '../services/geminiService.js';

import { requireAuth } from '../middleware/auth.js';
import { requirePaidFeatures } from '../middleware/requirePaidFeatures.js';

const router = Router();

const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.AI_RATE_LIMIT_MAX || '30', 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'AI request limit reached. Please try again later.' },
});

router.use(aiLimiter);
router.use(requireAuth);
router.use(requirePaidFeatures);

router.post('/generate-email', async (req, res, next) => {
  try {
    const {
      prompt,
      tone,
      campaignName,
      includeSubject,
      includeButtons,
      includeLinks,
      buttonUrl,
      buttonLabel,
    } = req.body;

    const result = await generateEmail({
      prompt,
      tone,
      campaignName,
      includeSubject: includeSubject !== false,
      includeButtons: Boolean(includeButtons),
      includeLinks: Boolean(includeLinks),
      buttonUrl,
      buttonLabel,
    });

    res.json(result);
  } catch (err) {
    if (err.message?.includes('GEMINI_API_KEY')) {
      return res.status(503).json({ error: err.message });
    }
    if (err.message?.includes('quota') || err.message?.includes('free tier') || err.message?.includes('rate-limit')) {
      return res.status(429).json({ error: err.message });
    }
    if (err.message?.includes('required') || err.message?.includes('invalid')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

router.post('/rewrite-email', async (req, res, next) => {
  try {
    const { subject, body, instruction, preset, includeButtons, includeLinks } = req.body;

    const result = await rewriteEmail({
      subject,
      body,
      instruction,
      preset,
      includeButtons: Boolean(includeButtons),
      includeLinks: Boolean(includeLinks),
    });

    res.json(result);
  } catch (err) {
    if (err.message?.includes('GEMINI_API_KEY')) {
      return res.status(503).json({ error: err.message });
    }
    if (err.message?.includes('quota') || err.message?.includes('free tier') || err.message?.includes('rate-limit')) {
      return res.status(429).json({ error: err.message });
    }
    if (err.message?.includes('required') || err.message?.includes('invalid')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

export default router;
