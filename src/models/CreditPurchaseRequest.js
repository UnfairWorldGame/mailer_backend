import mongoose from 'mongoose';

const creditPurchaseRequestSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
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

export default mongoose.model('CreditPurchaseRequest', creditPurchaseRequestSchema);
