import mongoose from 'mongoose';
import Contact from '../models/Contact.js';
import { ownerFilter } from './userScope.js';

export async function getContactMeta(userId) {
  const filter = ownerFilter(userId);
  const count = await Contact.countDocuments(filter);
  const namedCount = await Contact.countDocuments({ ...filter, name: { $exists: true, $ne: '' } });
  return { count, has_names: namedCount > 0 };
}

const BULK_BATCH_SIZE = 1000;

export async function upsertContacts(contacts, userId) {
  // Deduplicate within the payload (last non-empty name wins) so the bulk upsert
  // never issues two conflicting ops for the same {user_id, email} in one batch.
  const byEmail = new Map();
  for (const c of contacts) {
    const email = String(c.email || '').trim().toLowerCase();
    if (!email) continue;
    const name = String(c.name || '').trim();
    const prev = byEmail.get(email);
    byEmail.set(email, { email, name: name || prev?.name || '' });
  }

  const unique = [...byEmail.values()];
  let inserted = 0;
  let updated = 0;

  // Single bulkWrite per chunk instead of two awaited round-trips per contact.
  for (let i = 0; i < unique.length; i += BULK_BATCH_SIZE) {
    const chunk = unique.slice(i, i + BULK_BATCH_SIZE);
    const ops = chunk.map(({ email, name }) => ({
      updateOne: {
        filter: ownerFilter(userId, { email }),
        // Only overwrite the stored name when the import actually provides one.
        update: name
          ? { $set: { name }, $setOnInsert: { user_id: userId, email } }
          : { $setOnInsert: { user_id: userId, email, name: '' } },
        upsert: true,
      },
    }));

    const result = await Contact.bulkWrite(ops, { ordered: false });
    inserted += result.upsertedCount || 0;
    updated += result.matchedCount || 0;
  }

  return { inserted, updated, total: contacts.length };
}

export async function deleteContactsByIds(ids = [], userId) {
  const validIds = ids.filter((id) => mongoose.isValidObjectId(id));
  if (!validIds.length) {
    return { deleted: 0, ...(await getContactMeta(userId)) };
  }

  const result = await Contact.deleteMany(ownerFilter(userId, { _id: { $in: validIds } }));
  return { deleted: result.deletedCount ?? 0, ...(await getContactMeta(userId)) };
}

export async function deleteAllContacts(userId) {
  const result = await Contact.deleteMany(ownerFilter(userId));
  return { deleted: result.deletedCount ?? 0, ...(await getContactMeta(userId)) };
}

export function buildContactSearchFilter(search, userId) {
  const term = String(search || '').trim();
  const base = ownerFilter(userId);

  if (!term) return base;

  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    ...base,
    $or: [
      { email: { $regex: escaped, $options: 'i' } },
      { name: { $regex: escaped, $options: 'i' } },
    ],
  };
}
