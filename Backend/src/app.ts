import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { originGuard } from './auth/middleware.js';
import type { Config } from './config.js';
import { errorHandler } from './middlewares/errorHandler.js';
import { notFound } from './middlewares/notFound.js';
import { apiRateLimiter } from './middlewares/rateLimiter.js';
import { apiRouter, type ApiRouteDeps } from './routes/api.js';
import { systemRouter, type SystemRouteDeps } from './routes/system.js';
import { authRouter, tenancyRouter, type AuthRouteDeps, type TenancyRouteDeps } from './routes/tenancy.js';

export interface AppDeps {
  /** Public: model/system status and the taxonomy (nothing tenant-specific). */
  system: SystemRouteDeps;
  /** Sign-in, sign-out and the one-time claim and invite links. */
  auth: AuthRouteDeps;
  /** Organizations and users. */
  tenancy: TenancyRouteDeps;
  /** Posts, review, narratives, dispatch, analytics, admin. */
  api: ApiRouteDeps;
}

export function createApp(config: Pick<Config, 'FRONTEND_URL'>, deps: AppDeps) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  // CORS is locked to the configured frontend origin, never `*`; credentials are needed for the session cookie.
  app.use(cors({ origin: config.FRONTEND_URL, credentials: true }));
  app.use(express.json({ limit: '2mb' }));

  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  app.use('/api', apiRateLimiter());
  // CSRF defence for cookie sessions: an unsafe request from a browser at another origin is refused.
  app.use('/api', originGuard(config.FRONTEND_URL));
  app.use('/api', systemRouter(deps.system));
  app.use('/api/auth', authRouter(deps.auth));
  app.use('/api', tenancyRouter(deps.tenancy));
  app.use('/api', apiRouter(deps.api));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
