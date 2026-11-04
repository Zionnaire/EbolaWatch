import type { Request, Response } from 'express';
import {
  AcceptInviteRequestSchema,
  ChangePasswordRequestSchema,
  ClaimRequestSchema,
  LoginRequestSchema,
} from '../contracts/api/index.js';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  clearAuthCookies,
  parseCookies,
  setAuthCookies,
  type CookieSettings,
} from '../auth/cookies.js';
import { currentPrincipal } from '../auth/middleware.js';
import type { AuthService, Session } from '../services/tenancy/authService.js';
import { AppError } from '../utils/appError.js';

export interface AuthControllerDeps {
  auth: AuthService;
  cookies: CookieSettings;
}

export function authController(d: AuthControllerDeps) {
  /** Sets the session cookies and returns who the user is (never the tokens themselves). */
  const start = (res: Response, s: Session, status = 200) => {
    setAuthCookies(res, s.tokens, d.cookies);
    res.status(status).json(s.me);
  };

  return {
    login: async (req: Request, res: Response) => {
      const { email, password } = LoginRequestSchema.parse(req.body);
      start(res, await d.auth.login(email, password));
    },

    refresh: async (req: Request, res: Response) => {
      const token = parseCookies(req.header('cookie'))[REFRESH_COOKIE];
      if (!token) throw new AppError(401, 'Authentication is required', 'unauthenticated');
      try {
        start(res, await d.auth.refresh(token));
      } catch (err) {
        clearAuthCookies(res, d.cookies); // a refresh that fails ends the session
        throw err;
      }
    },

    logout: (_req: Request, res: Response) => {
      clearAuthCookies(res, d.cookies);
      res.json({ ok: true });
    },

    me: async (_req: Request, res: Response) => {
      res.json(await d.auth.me(currentPrincipal(res).userId));
    },

    changePassword: async (req: Request, res: Response) => {
      const { currentPassword, newPassword } = ChangePasswordRequestSchema.parse(req.body);
      start(res, await d.auth.changePassword(currentPrincipal(res).userId, currentPassword, newPassword));
    },

    claimInfo: async (req: Request, res: Response) => {
      res.json(await d.auth.claimInfo(String(req.params.token)));
    },

    claim: async (req: Request, res: Response) => {
      start(res, await d.auth.claim(String(req.params.token), ClaimRequestSchema.parse(req.body)), 201);
    },

    inviteInfo: async (req: Request, res: Response) => {
      res.json(await d.auth.inviteInfo(String(req.params.token)));
    },

    acceptInvite: async (req: Request, res: Response) => {
      start(
        res,
        await d.auth.acceptInvite(String(req.params.token), AcceptInviteRequestSchema.parse(req.body)),
        201,
      );
    },
  };
}

export { ACCESS_COOKIE };
