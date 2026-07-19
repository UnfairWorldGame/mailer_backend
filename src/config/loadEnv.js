import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

/**
 * Loads .env, and must be the FIRST import of the entry point.
 *
 * ES module imports are hoisted: every `import` in a file is resolved and its
 * module body evaluated before any statement in the importing file runs. So
 * calling dotenv.config() in index.js's body — even on line 1 — happened *after*
 * the entire dependency graph had already been evaluated, and any module reading
 * process.env at module level (billingConfig, sendConfig, certConfig) saw an
 * empty environment and silently fell back to its defaults.
 *
 * That went unnoticed because the values in .env matched those defaults. It
 * surfaced when BILLING_CONTACT was added with no default and came back null
 * despite CONTACT_INBOX_EMAIL being set.
 *
 * Importing this module first works because ESM evaluates dependencies in
 * import order, so this body runs before the imports that follow it.
 */
const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.env');
dotenv.config({ path: envPath });

export const ENV_PATH = envPath;
