/**
 * One-time migration: encrypt Gmail App Passwords that are still stored in
 * plaintext.
 *
 * Safe to run repeatedly — rows already carrying the `enc:v1:` prefix are
 * skipped, and each row is verified by decrypting it back before the next one
 * is touched.
 *
 * Usage:
 *   CREDENTIAL_ENCRYPTION_KEY=<64 hex chars> node scripts/encrypt-credentials.mjs
 *   ... --dry-run    report what would change, write nothing
 */
import './load-env.mjs';
import mongoose from 'mongoose';
import { connectDB } from '../src/db/connect.js';
import GmailAccount from '../src/models/GmailAccount.js';
import {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  isCredentialEncryptionConfigured,
} from '../src/utils/credentialCrypto.js';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  if (!isCredentialEncryptionConfigured()) {
    console.error(
      'CREDENTIAL_ENCRYPTION_KEY is not set. Generate one with:\n' +
      '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n' +
      'then set it in the environment and re-run. Store it somewhere you can recover it:\n' +
      'without this key the stored App Passwords cannot be decrypted.'
    );
    process.exit(1);
  }

  await connectDB();

  // Bypass the schema getter/setter — this needs the raw stored values.
  const raw = mongoose.connection.collection('gmailaccounts');
  const docs = await raw.find({}, { projection: { app_password: 1, email: 1 } }).toArray();

  let encrypted = 0;
  let alreadyDone = 0;
  let empty = 0;

  for (const doc of docs) {
    const current = doc.app_password;
    if (!current) { empty++; continue; }
    if (isEncrypted(current)) { alreadyDone++; continue; }

    const ciphertext = encryptSecret(current);

    // Verify before persisting: a round-trip failure here means the key or the
    // algorithm is wrong, and writing anyway would destroy the credential.
    if (decryptSecret(ciphertext) !== current) {
      throw new Error(`Round-trip verification failed for ${doc.email} — nothing was written.`);
    }

    if (!dryRun) {
      await raw.updateOne({ _id: doc._id }, { $set: { app_password: ciphertext } });
    }
    encrypted++;
  }

  console.log(
    `${dryRun ? '[dry run] ' : ''}${encrypted} encrypted, ${alreadyDone} already encrypted, ` +
    `${empty} empty, ${docs.length} total`
  );

  await mongoose.connection.close();
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exitCode = 1;
});
