import { rateLimit } from 'express-rate-limit';

export function apiRateLimiter(limitPerMinute = 300) {
  return rateLimit({
    windowMs: 60_000,
    limit: limitPerMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'rate_limited', message: 'Too many requests' } },
  });
}

/**
 * Stricter limit for the unauthenticated endpoints that take a secret (passwords, claim and invite tokens), per
 * client address. Slows online guessing; the strong password hash and the uniform error do the rest.
 */
export function authRateLimiter(limitPerMinute: number) {
  return rateLimit({
    windowMs: 60_000,
    limit: limitPerMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'rate_limited', message: 'Too many attempts. Wait a minute and try again.' } },
  });
}
