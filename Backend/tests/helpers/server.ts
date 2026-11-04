import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApplication, type Application, type ApplicationOptions } from '../../src/composition.js';
import {
  attachSocketAuth,
  createSocketServer,
  toBroadcaster,
  type TypedServer,
} from '../../src/sockets/index.js';
import { authed, createOrg, createUser, testConfig, type TestUser } from './app.js';

export interface RunningServer {
  application: Application;
  io: TypedServer;
  port: number;
  url: string;
  config: ReturnType<typeof testConfig>;
  /** A supervisor of a national organization (may operate the platform). */
  user: TestUser;
  /** supertest against the live URL, signed in as `user`. */
  api: () => ReturnType<typeof authed>;
  close(): Promise<void>;
}

/** The real thing, as index.ts builds it: HTTP server + Socket.io + the application, listening on a free port. */
export async function startServer(
  env: Record<string, string> = {},
  options: ApplicationOptions = {},
): Promise<RunningServer> {
  const config = testConfig(env);
  // Same order as index.ts: the app is the listener before Socket.io attaches (see the comment there).
  let handler: http.RequestListener = (_req, res) => {
    res.statusCode = 503;
    res.end();
  };
  const server = http.createServer((req, res) => handler(req, res));
  const io = createSocketServer(server, config);
  const application = await buildApplication(config, toBroadcaster(io), {
    sweepIntervalMs: 3_600_000,
    ...options,
  });
  handler = application.app;
  attachSocketAuth(io, application.socketAuth);
  await application.start();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const org = await createOrg({ name: 'NCDC', type: 'national' });
  const user = await createUser(org, 'supervisor');
  const url = `http://127.0.0.1:${port}`;
  return {
    user,
    api: () => authed(url, user),
    application,
    io,
    port,
    url: `http://127.0.0.1:${port}`,
    config,
    close: async () => {
      await application.stop();
      await io.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
