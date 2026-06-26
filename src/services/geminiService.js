import { GoogleGenerativeAI } from '@google/generative-ai';

const DEFAULT_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-1.5-flash',
];

function getModelList() {
  const primary = process.env.GEMINI_MODEL?.trim();
  const fallbacks = process.env.GEMINI_MODEL_FALLBACKS
    ?.split(',')
    .map((m) => m.trim())
    .filter(Boolean);

  if (primary && fallbacks?.length) {
    return [...new Set([primary, ...fallbacks])];
  }
  if (primary) {
    return [...new Set([primary, ...DEFAULT_MODELS.filter((m) => m !== primary)])];
  }
  return DEFAULT_MODELS;
}

function getClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey?.trim()) {
    throw new Error('GEMINI_API_KEY is not configured on the server');
  }
  return new GoogleGenerativeAI(apiKey.trim());
}

function isQuotaError(err) {
  const msg = String(err?.message || err || '');
  return (
    msg.includes('429') ||
    msg.includes('Too Many Requests') ||
    msg.includes('quota') ||
    msg.includes('Quota exceeded') ||
    msg.includes('RESOURCE_EXHAUSTED')
  );
}

function isModelUnavailable(err) {
  const msg = String(err?.message || err || '');
  return (
    msg.includes('404') ||
    msg.includes('not found') ||
    msg.includes('is not supported') ||
    msg.includes('shut down') ||
    msg.includes('deprecated')
  );
}

function formatGeminiError(err, triedModels) {
  const msg = String(err?.message || err || '');

  if (isQuotaError(err)) {
    if (msg.includes('limit: 0')) {
      return new Error(
        `The model "${triedModels[0]}" is no longer available on the free tier. ` +
        'Set GEMINI_MODEL=gemini-2.5-flash in backend/.env and restart the server.'
      );
    }
    return new Error(
      'Gemini API quota exceeded. Wait a minute and try again, or check usage at https://ai.dev/rate-limit'
    );
  }

  if (isModelUnavailable(err)) {
    return new Error(
      `Model unavailable. Tried: ${triedModels.join(', ')}. ` +
      'Update GEMINI_MODEL in backend/.env to gemini-2.5-flash'
    );
  }

  return err;
}

async function generateContentWithFallback(prompt) {
  const genAI = getClient();
  const models = getModelList();
  const errors = [];

  for (const modelName of models) {
    try {
      const model = genAI.getGenerativeModel({ model: modelName });
      const result = await model.generateContent(prompt);
      return result.response.text();
    } catch (err) {
      errors.push({ model: modelName, err });
      const retryable = isQuotaError(err) || isModelUnavailable(err);
      if (!retryable) throw formatGeminiError(err, models);
      console.warn(`[Gemini] ${modelName} failed: ${err.message?.slice(0, 120)}`);
    }
  }

  const lastErr = errors[errors.length - 1]?.err;
  throw formatGeminiError(lastErr, models);
}

const EMAIL_RULES = `You write HTML email content for bulk email campaigns.
Rules:
- Return ONLY valid JSON, no markdown fences or extra text
- body must be an HTML fragment (no <html>, <head>, or <body> tags)
- Use inline CSS styles for email client compatibility
- Always greet with {{name}} placeholder (e.g. "Hello {{name}},")
- You may use {{email}} placeholder where appropriate
- Keep paragraphs in <p> tags
- Use professional, clear language`;

function buildButtonStyle() {
  return 'background-color:#1a73e8;color:#ffffff;padding:12px 28px;text-decoration:none;border-radius:6px;display:inline-block;font-weight:600;font-size:14px;';
}

function buildOptionsPrompt({ includeButtons, includeLinks, buttonUrl, buttonLabel }) {
  const parts = [];
  if (includeLinks) {
    parts.push('- Include at least one styled hyperlink using <a href="URL">text</a> with color:#1a73e8');
  }
  if (includeButtons) {
    const url = buttonUrl || 'https://example.com';
    const label = buttonLabel || 'Learn More';
    parts.push(
      `- Include a prominent CTA button centered in a <p style="text-align:center;margin:24px 0;"> wrapper`,
      `- Button format: <a href="${url}" style="${buildButtonStyle()}">${label}</a>`,
      `- Use the provided button URL and label if given, otherwise invent appropriate ones`
    );
  }
  return parts.length ? `\nHTML options:\n${parts.join('\n')}` : '';
}

function parseJsonResponse(text) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('AI returned invalid response format');
  }
}

export async function generateEmail({
  prompt,
  tone = 'professional',
  campaignName,
  includeSubject = true,
  includeButtons = false,
  includeLinks = false,
  buttonUrl,
  buttonLabel,
}) {
  if (!prompt?.trim()) {
    throw new Error('A description of the email is required');
  }

  const optionsPrompt = buildOptionsPrompt({ includeButtons, includeLinks, buttonUrl, buttonLabel });

  const userPrompt = `${EMAIL_RULES}
Tone: ${tone}
${campaignName ? `Campaign: ${campaignName}` : ''}
${optionsPrompt}

Write an email based on this description:
"${prompt.trim()}"

Return JSON with keys: ${includeSubject ? '"subject" (string), ' : ''}"body" (HTML string)`;

  const text = await generateContentWithFallback(userPrompt);
  const parsed = parseJsonResponse(text);

  if (!parsed.body?.trim()) {
    throw new Error('AI did not generate email body');
  }

  return {
    subject: includeSubject ? (parsed.subject?.trim() || '') : undefined,
    body: parsed.body.trim(),
  };
}

const REWRITE_PRESETS = {
  shorter: 'Make the email more concise while keeping the key message',
  longer: 'Expand the email with more detail and context',
  formal: 'Rewrite in a more formal, professional tone',
  friendly: 'Rewrite in a warmer, friendlier tone',
  urgent: 'Add urgency and a stronger call to action',
  grammar: 'Fix grammar, spelling, and improve clarity',
};

export async function rewriteEmail({
  subject,
  body,
  instruction,
  preset,
  includeButtons = false,
  includeLinks = false,
}) {
  if (!body?.trim()) {
    throw new Error('Email body is required to rewrite');
  }

  const rewriteInstruction = preset
    ? REWRITE_PRESETS[preset] || preset
    : instruction?.trim();

  if (!rewriteInstruction) {
    throw new Error('A rewrite instruction is required');
  }

  const optionsPrompt = buildOptionsPrompt({ includeButtons, includeLinks });

  const userPrompt = `${EMAIL_RULES}
Rewrite instruction: ${rewriteInstruction}
${optionsPrompt}

Current subject: ${subject || '(none)'}
Current body HTML:
${body}

Keep {{name}} and {{email}} placeholders intact.
Return JSON with keys: "subject" (string), "body" (HTML string)`;

  const text = await generateContentWithFallback(userPrompt);
  const parsed = parseJsonResponse(text);

  if (!parsed.body?.trim()) {
    throw new Error('AI did not return rewritten body');
  }

  return {
    subject: parsed.subject?.trim() || subject || '',
    body: parsed.body.trim(),
  };
}

export { REWRITE_PRESETS };
