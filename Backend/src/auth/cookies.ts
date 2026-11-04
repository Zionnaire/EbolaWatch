import type { CookieOptions, Response } from 'express';

export const ACCESS_COOKIE = 'ew_access';
export const REFRESH_COOKIE = 'ew_refresh';

export interface CookieSettings {
  secure: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
}

/** Minimal Cookie header parser (we only ever read our own two cookies). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      /* ignore a malformed value */
    }
  }
  return out;
}

const base = (s: CookieSettings): CookieOptions => ({
  httpOnly: true,
  secure: s.secure,
  sameSite: s.sameSite,
});

/**
 * Tokens live only in HttpOnly cookies (JavaScript cannot read them). The refresh cookie is sent only to the auth
 * endpoints. `SameSite=None` (needed when the frontend is on another site) requires `Secure`.
 */
export function setAuthCookies(
  res: Response,
  tokens: { access: string; refresh: string },
  s: CookieSettings,
): void {
  res.cookie(ACCESS_COOKIE, tokens.access, { ...base(s), path: '/', maxAge: s.accessTtlSeconds * 1000 });
  res.cookie(REFRESH_COOKIE, tokens.refresh, {
    ...base(s),
    path: '/api/auth',
    maxAge: s.refreshTtlSeconds * 1000,
  });
}

export function clearAuthCookies(res: Response, s: CookieSettings): void {
  res.clearCookie(ACCESS_COOKIE, { ...base(s), path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...base(s), path: '/api/auth' });
}
