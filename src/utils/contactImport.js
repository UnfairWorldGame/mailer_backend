import mongoose from 'mongoose';
import Contact from '../models/Contact.js';
import { ownerFilter } from './userScope.js';

export async function getContactMeta(userId) {
  const filter = ownerFilter(userId);
  const count = await Contact.countDocuments(filter);
  const namedCount = await Contact.countDocuments({ ...filter, name: { $exists: true, $ne: '' } });
  return { count, has_names: namedCount > 0 };
}

export async function upsertContacts(contacts, userId) {
  let inserted = 0;
  let updated = 0;

  for (const c of contacts) {
    const email = String(c.email || '').trim().toLowerCase();
    if (!email) continue;

    const existing = await Contact.findOne(ownerFilter(userId, { email }));
    if (existing) {
      if (c.name) existing.name = c.name;
      await existing.save();
      updated++;
    } else {
      await Contact.create({ user_id: userId, name: c.name || '', email });
      inserted++;
    }
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
