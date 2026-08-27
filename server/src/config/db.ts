import mongoose from "mongoose";

const URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/kpi_storytelling";

export async function connectDB(): Promise<typeof mongoose> {
  mongoose.set("strictQuery", true);
  await mongoose.connect(URI);
  console.log(`[db] connected: ${URI}`);
  return mongoose;
}

export async function disconnectDB(): Promise<void> {
  await mongoose.disconnect();
}
