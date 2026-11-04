/** Validates .env and pings MongoDB (no reads or writes of data). Never prints secrets. */
import mongoose from 'mongoose';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const host = new URL(
  config.MONGODB_URI.replace('mongodb+srv://', 'https://').replace('mongodb://', 'http://'),
).host;
console.log(
  `config ok: NODE_ENV=${config.NODE_ENV} MODEL_MODE=${config.MODEL_MODE} INGESTION_MODE=${config.INGESTION_MODE}`,
);
console.log(`connecting to ${host} (db "${config.MONGODB_DB}")…`);

try {
  await mongoose.connect(config.MONGODB_URI, { dbName: config.MONGODB_DB, serverSelectionTimeoutMS: 15_000 });
  const ping = await mongoose.connection.db!.admin().ping();
  console.log(`mongo ping ok: ${JSON.stringify(ping)}`);
} catch (err) {
  console.error(`mongo connection FAILED: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await mongoose.disconnect();
}
