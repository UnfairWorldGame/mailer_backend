import mongoose from 'mongoose';

export async function connectDB(uriOverride) {
  const uri = (uriOverride || process.env.MONGODB_URI || '').trim();
  if (!uri) {
    throw new Error(
      'MONGODB_URI environment variable is required. Set it in backend/.env (see .env.example).'
    );
  }

  mongoose.set('strictQuery', true);
  await mongoose.connect(uri);
  console.log('Connected to MongoDB');
}

export async function disconnectDB() {
  await mongoose.disconnect();
}
