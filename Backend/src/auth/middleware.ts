import type { Request, RequestHandler, Response } from 'express';
import { AppError } from '../utils/appError.js';
import { verifyToken } from '../utils/jwt.js';
import { ACCESS_COOKIE, parseCookies } from './cookies.js';
import { can, type Permission } from './permissions.js';
import type { PrincipalLoader } from './principalLoader.js';
import type { Principal } from './types.js';

/** The access token: `Authorization: Bearer` (non-browser clients) or the HttpOnly cookie (the web app). */
export function extractAccessToken(req: Pick<Request, 'header'>): string | null {
  const bearer = req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) return bearer;
  return parseCookies(req.header('cookie'))[ACCESS_COOKIE] ?? null;
}

export interface AuthenticateDeps {
  jwtSecret: string;
  loader: PrincipalLoader;
}

/** Verifies the token, then loads the CURRENT principal from the database (active user, active organization). */
export function authenticate(d: AuthenticateDeps): RequestHandler {
  return async (req, res, next) => {
    const token = extractAccessToken(req);
    if (!token) throw new AppError(401, 'Authentication is required', 'unauthenticated');
    const claims = verifyToken(token, d.jwtSecret, 'access');
    res.locals.principal = await d.loader.load(claims.sub, claims.tv);
    next();
  };
}

export function currentPrincipal(res: Pick<Response, 'locals'>): Principal {
  const principal = res.locals.principal as Principal | undefined;
  if (!principal) throw new AppError(401, 'Authentication is required', 'unauthenticated');
  return principal;
}

/** Routes ask for a permission (see permissions.ts), never for a role. */
export function requirePermission(permission: Permission): RequestHandler {
  return (_req, res, next) => {
    if (!can(currentPrincipal(res), permission)) {
      throw new AppError(403, 'You are not allowed to do this', 'forbidden');
    }
    next();
  };
}

/**
 * CSRF defence for cookie sessions: a browser always sends `Origin` on a cross-site state-changing request, so any
 * unsafe request that names a different origin than the frontend is refused. Clients that send no Origin
 * (servers, scripts) are not browsers and cannot be tricked into riding a cookie.
 */
export function originGuard(allowedOrigin: string): RequestHandler {
  const allowed = new URL(allowedOrigin).origin;
  return (req, _res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    const origin = req.header('origin');
    if (origin && origin !== allowed) throw new AppError(403, 'Request origin is not allowed', 'bad_origin');
    return next();
  };
}
