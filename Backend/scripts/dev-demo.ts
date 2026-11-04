/**
 * A throwaway demo of the whole backend for trying the Frontend without Atlas: an in-memory MongoDB, the mock model
 * and the synthetic post feed, plus two demo accounts. Nothing is saved when it stops, and it never touches your
 * real database (it ignores MONGODB_URI).
 *
 *   pnpm dev:demo
 *
 * Then run the Frontend (`pnpm dev` in Frontend/) and sign in with the printed credentials.
 */
import http from 'node:http';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { buildApplication } from '../src/composition.js';
import { loadConfig } from '../src/config.js';
import { OrganizationModel } from '../src/models/Organization.js';
import { UserModel } from '../src/models/User.js';
import { attachSocketAuth, createSocketServer, toBroadcaster } from '../src/sockets/index.js';
import { hashPassword } from '../src/utils/password.js';

const PASSWORD = 'demo-password-123';

async function main() {
  const mongod = await MongoMemoryServer.create();
  const config = loadConfig({
    NODE_ENV: 'development',
    PORT: process.env.PORT ?? '4000',
    FRONTEND_URL: process.env.FRONTEND_URL ?? 'http://localhost:5173',
    MONGODB_URI: mongod.getUri(),
    MONGODB_DB: 'ebolawatch_demo',
    INGEST_API_KEY: 'demo-ingest-key-0123456789',
    AUTHOR_HASH_SECRET: 'demo-hash-secret-0123456789',
    JWT_SECRET: 'demo-jwt-secret-0123456789-0123456789-abcdef',
    MODEL_MODE: 'mock',
    MODEL_CONTRACT: 'multilabel-v1',
    INGESTION_MODE: 'mock',
    // optional AI features, taken from the environment / .env (the key is never printed)
    GENERATOR_MODE: process.env.GENERATOR_MODE,
    CLUSTER_REFINER: process.env.CLUSTER_REFINER,
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GROQ_MODEL: process.env.GROQ_MODEL,
  });
  await mongoose.connect(config.MONGODB_URI, { dbName: config.MONGODB_DB });

  const hash = await hashPassword(PASSWORD);
  const ncdc = await OrganizationModel.create({
    name: 'NCDC',
    slug: 'ncdc',
    type: 'national',
    region: 'Abuja',
    scopeStates: [],
    status: 'active',
    settings: {},
    adminClaimed: true,
  });
  const lagos = await OrganizationModel.create({
    name: 'Lagos State Epidemiology',
    slug: 'lagos',
    type: 'state',
    scopeStates: ['Lagos'],
    status: 'active',
    settings: {},
    adminClaimed: true,
  });
  const accounts = [
    { email: 'admin@ncdc.demo', name: 'Amina Bello', role: 'org_admin', org: ncdc._id },
    { email: 'supervisor@ncdc.demo', name: 'Chidi Okafor', role: 'supervisor', org: ncdc._id },
    { email: 'analyst@ncdc.demo', name: 'Tunde Adeyemi', role: 'analyst', org: ncdc._id },
    { email: 'admin@lagos.demo', name: 'Folake Ajayi', role: 'org_admin', org: lagos._id },
    { email: 'operator@ebolawatch.demo', name: 'Platform Operator', role: 'super_admin', org: null },
  ];
  for (const a of accounts) {
    await UserModel.create({
      email: a.email,
      name: a.name,
      passwordHash: hash,
      role: a.role,
      organizationId: a.org,
      isActive: true,
    });
  }

  let handler: http.RequestListener = (_req, res) => {
    res.statusCode = 503;
    res.end();
  };
  const server = http.createServer((req, res) => handler(req, res));
  const io = createSocketServer(server, config);
  const application = await buildApplication(config, toBroadcaster(io));
  handler = application.app;
  attachSocketAuth(io, application.socketAuth);
  await application.start();
  server.listen(config.PORT, () => {
    console.log(
      `\nDemo backend on http://localhost:${config.PORT} (in-memory database, mock model, synthetic feed)\n`,
    );
    console.log(`Sign in with any of these (password: ${PASSWORD}):`);
    for (const a of accounts) console.log(`  ${a.role.padEnd(12)} ${a.email}`);
  });

  const stop = async () => {
    await application.stop();
    void io.close();
    server.close();
    await mongoose.disconnect();
    await mongod.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
