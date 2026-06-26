import CreditPurchaseRequest from '../models/CreditPurchaseRequest.js';

export async function findPendingCreditRequest(email) {
  return CreditPurchaseRequest.findOne({
    email: email.toLowerCase().trim(),
    status: 'pending',
  }).sort({ created_at: -1 });
}

export async function getCreditRequestStatus(email) {
  const pending = await findPendingCreditRequest(email);
  if (pending) {
    return {
      pending: true,
      submitted_at: pending.created_at,
      pack_label: pending.pack_label,
    };
  }
  return { pending: false };
}

export async function createCreditPurchaseRequest(data) {
  const email = data.email.toLowerCase().trim();
  const existing = await findPendingCreditRequest(email);
  if (existing) {
    const err = new Error('You already have a pending credit request. Our team will contact you soon.');
    err.code = 'CREDIT_REQUEST_PENDING';
    err.status = 409;
    throw err;
  }

  return CreditPurchaseRequest.create({
    email,
    name: data.name.trim(),
    phone: data.phone.trim(),
    pack_label: data.packLabel.trim(),
    price: data.price?.trim() || null,
    mails: data.mails?.trim() || null,
    status: 'pending',
  });
}

export async function fulfillCreditPurchaseRequests(email) {
  await CreditPurchaseRequest.updateMany(
    { email: email.toLowerCase().trim(), status: 'pending' },
    { $set: { status: 'fulfilled', fulfilled_at: new Date() } },
  );
}
