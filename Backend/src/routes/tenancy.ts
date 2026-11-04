import type { RequestHandler } from 'express';
import { Router } from 'express';
import { authController, type AuthControllerDeps } from '../controllers/auth.js';
import {
  organizationsController,
  usersController,
  type TenancyControllerDeps,
} from '../controllers/tenancy.js';
import { requirePermission } from '../auth/middleware.js';

export interface AuthRouteDeps extends AuthControllerDeps {
  /** Verifies the session cookie / bearer token. */
  authenticate: RequestHandler;
  /** Throttles the unauthenticated endpoints that take secrets (passwords, link tokens). */
  authLimiter: RequestHandler;
}

/** Mounted at /api/auth. Sign-in and the one-time link endpoints are public; the rest need a session. */
export function authRouter(d: AuthRouteDeps): Router {
  const r = Router();
  const c = authController(d);

  r.post('/login', d.authLimiter, c.login);
  r.post('/refresh', d.authLimiter, c.refresh);
  r.post('/logout', c.logout);
  r.get('/me', d.authenticate, c.me);
  r.post('/change-password', d.authenticate, d.authLimiter, c.changePassword);

  r.get('/claim/:token', d.authLimiter, c.claimInfo);
  r.post('/claim/:token', d.authLimiter, c.claim);
  r.get('/invite/:token', d.authLimiter, c.inviteInfo);
  r.post('/invite/:token', d.authLimiter, c.acceptInvite);
  return r;
}

export interface TenancyRouteDeps extends TenancyControllerDeps {
  authenticate: RequestHandler;
}

/** Mounted at /api. Everything here needs a session and a specific permission. */
export function tenancyRouter(d: TenancyRouteDeps): Router {
  const r = Router();
  const orgs = organizationsController(d);
  const users = usersController(d);
  const platformAdmin = [d.authenticate, requirePermission('orgs:manage')];
  const orgAdmin = [d.authenticate, requirePermission('org:settings')];
  const userAdmin = [d.authenticate, requirePermission('users:manage')];

  // organizations: the platform operator manages tenants...
  r.get('/organizations', ...platformAdmin, orgs.list);
  r.post('/organizations', ...platformAdmin, orgs.create);
  r.get('/organizations/overview', ...platformAdmin, orgs.overview);
  // ...and an org admin manages their own (declared before /:id so "me" is not read as an id)
  r.get('/organizations/me', ...orgAdmin, orgs.mine);
  r.patch('/organizations/me/settings', ...orgAdmin, orgs.updateMySettings);
  r.get('/organizations/:id', ...platformAdmin, orgs.get);
  r.post('/organizations/:id/claim-link', ...platformAdmin, orgs.regenerateClaimLink);
  r.patch('/organizations/:id/status', ...platformAdmin, orgs.setStatus);
  r.patch('/organizations/:id/settings', ...platformAdmin, orgs.updateSettings);

  // staff of the caller's own organization
  r.get('/users', ...userAdmin, users.list);
  r.patch('/users/:id', ...userAdmin, users.update);
  r.get('/users-invites', ...userAdmin, users.listInvites);
  r.post('/users-invites', ...userAdmin, users.invite);
  r.delete('/users-invites/:id', ...userAdmin, users.revokeInvite);
  return r;
}
