import http from 'node:http';
import mongoose from 'mongoose';
import { waitForModelHealth } from './classifier/waitForModel.js';
import { buildApplication } from './composition.js';
import { loadConfig } from './config.js';
import { attachSocketAuth, createSocketServer, toBroadcaster } from './sockets/index.js';
import { logger } from './utils/logger.js';

async function main() {
  const config = loadConfig();

  if (config.MODEL_MODE === 'live') {
    // Starting the model and the backend together must not race: wait for the model to answer.
    const modelHost = new URL(config.MODEL_BASE_URL).hostname;
    if (!config.MODEL_API_KEY && modelHost !== 'localhost' && modelHost !== '127.0.0.1') {
      logger.warn('MODEL_API_KEY is not set but the model service is remote: it will probably answer 401');
    }
    logger.info({ baseUrl: config.MODEL_BASE_URL }, 'waiting for the model service');
    const model = await waitForModelHealth({
      baseUrl: config.MODEL_BASE_URL,
      timeoutMs: config.MODEL_WARMUP_MAX_WAIT_MS,
      apiKey: config.MODEL_API_KEY ?? null,
      onWait: ({ attempt, waitedMs, error }) => {
        if (attempt === 1 || attempt % 5 === 0)
          logger.info({ attempt, waitedMs, error }, 'model service not reachable yet');
      },
    });
    // A cold or absent model is not fatal: classification waits (items stay pending) and the UI shows its status.
    if (model.reachable)
      logger.info({ status: model.status, waitedMs: model.waitedMs }, 'model service is up');
    else logger.warn({ waitedMs: model.waitedMs }, 'model service did not answer in time; starting anyway');
  }

  await mongoose.connect(config.MONGODB_URI, { dbName: config.MONGODB_DB });
  logger.info({ db: config.MONGODB_DB }, 'mongo connected');

  // Socket.io takes over the server's request listeners when it is attached, and answers /socket.io/ itself
  // (including the HTTP long-polling fallback every client starts with). The app must therefore be the listener
  // BEFORE Socket.io attaches, or both would answer the same request. The app needs the broadcaster, which needs
  // Socket.io, so the listener delegates to a handler that is filled in once the app is built.
  let handler: http.RequestListener = (_req, res) => {
    res.statusCode = 503;
    res.end();
  };
  const server = http.createServer((req, res) => handler(req, res));
  const io = createSocketServer(server, config);
  const application = await buildApplication(config, toBroadcaster(io));
  handler = application.app;
  // connections must carry a valid session, exactly like the REST API
  attachSocketAuth(io, application.socketAuth);

  await application.start();
  server.listen(config.PORT, () =>
    logger.info(
      { port: config.PORT, modelMode: config.MODEL_MODE, ingestion: config.INGESTION_MODE },
      'EbolaWatch backend listening',
    ),
  );

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    void application.stop();
    void io.close();
    server.close(() => void mongoose.disconnect().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.fatal({ err }, 'startup failed');
  process.exit(1);
});
