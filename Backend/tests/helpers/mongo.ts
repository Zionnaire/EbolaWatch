import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll } from 'vitest';

/** Starts an in-memory MongoDB for the current test file and connects Mongoose to it. */
export function useMongo() {
  let server: MongoMemoryServer | null = null;

  beforeAll(async () => {
    server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri(), { dbName: 'ebolawatch_test' });
    // make sure unique indexes exist before any test relies on them
    await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  }, 600_000);

  afterAll(async () => {
    await mongoose.disconnect();
    await server?.stop();
  }, 60_000);
}

/** Empties collections with the native driver (bypasses the append-only hooks on AnalystReview). */
export async function clearCollections(names: string[]): Promise<void> {
  const db = mongoose.connection.db;
  if (!db) throw new Error('not connected');
  for (const name of names) await db.collection(name).deleteMany({});
}

export const DATA_COLLECTIONS = [
  'posts',
  'classifications',
  'decisions',
  'analystreviews',
  'counternarratives',
  'narrativereviews',
  'dispatches',
];
