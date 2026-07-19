import mongoose from 'mongoose';

const creditPurchaseRequestSchema = new mongoose.Schema(
  {
    // Indexes are declared explicitly below; `index: true` here as well produced
    // a duplicate-index warning at boot.
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    pack_label: { type: String, required: true, trim: true },
    price: { type: String, default: null, trim: true },
    mails: { type: String, default: null, trim: true },
    status: {
      type: String,
      enum: ['pending', 'fulfilled', 'cancelled'],
      default: 'pending',
      index: true,
    },
    fulfilled_at: { type: Date, default: null },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

creditPurchaseRequestSchema.index({ email: 1, status: 1 });

// "One pending request per email" was enforced only by a read-then-create in
// creditPurchaseService, which two concurrent submissions both pass. Let the
// database be the authority; the service now handles the duplicate-key error.
creditPurchaseRequestSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { status: 'pending' } }
);

export default mongoose.model('CreditPurchaseRequest', creditPurchaseRequestSchema);
