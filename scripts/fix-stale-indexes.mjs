/**
 * Drops unique indexes left behind by an older schema.
 *
 * `gmailaccounts` and `contacts` each carry a global `{email: 1}` unique index
 * that no longer exists in the models — both now declare `{user_id, email}`
 * unique, i.e. uniqueness *per user*. Mongoose creates missing indexes but never
 * removes ones it no longer declares, so these survived the schema change and
 * silently enforced platform-wide uniqueness:
 *
 *   - gmailaccounts: only ONE account on the whole platform could use a given
 *     Gmail address. A second user adding it got "This email is already
 *     registered" — the reported bug.
 *   - contacts: only ONE user could ever hold a given contact address. Everyone
 *     else's import of that address failed or was skipped.
 *
 * `users.email_1` is deliberately left alone — account emails ARE globally
 * unique and that index is correct.
 *
 * Usage:  node scripts/fix-stale-indexes.mjs [--apply]
 */
import 'dotenv/config';
import mongoose from 'mongoose';

const apply = process.argv.includes('--apply');

// collection -> index name that should no longer exist, and the index that
// replaced it (verified present before dropping, so we never leave a
// collection with no uniqueness constraint at all).
const STALE = [
  { collection: 'gmailaccounts', drop: 'email_1', requires: 'user_id_1_email_1' },
  { collection: 'contacts', drop: 'email_1', requires: 'user_id_1_email_1' },
];

await mongoose.connect(process.env.MONGODB_URI);
const db = mongoose.connection.db;

let dropped = 0;
let skipped = 0;

for (const { collection, drop, requires } of STALE) {
  let indexes;
  try {
    indexes = await db.collection(collection).indexes();
  } catch {
    console.log(`${collection}: collection does not exist — skipping`);
    continue;
  }

  const stale = indexes.find((i) => i.name === drop);
  const replacement = indexes.find((i) => i.name === requires);

  if (!stale) {
    console.log(`${collection}: "${drop}" already gone — nothing to do`);
    skipped++;
    continue;
  }

  if (!replacement) {
    // Refuse rather than leave the collection unconstrained. Booting the app
    // once creates the compound index, then re-run this.
    console.log(
      `${collection}: SKIPPED — replacement index "${requires}" is missing. ` +
      'Start the server once so Mongoose creates it, then re-run.'
    );
    skipped++;
    continue;
  }

  console.log(
    `${collection}: dropping stale unique index "${drop}" ${JSON.stringify(stale.key)} ` +
    `(replaced by "${requires}")`
  );

  if (apply) {
    await db.collection(collection).dropIndex(drop);
    dropped++;
  }
}

if (!apply) {
  console.log('\n[dry run] no indexes dropped. Re-run with --apply to make the change.');
} else {
  console.log(`\nDropped ${dropped} stale index(es), skipped ${skipped}.`);
}

await mongoose.disconnect();
