import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Author handles are stored only as HMAC-SHA256 with a server-side secret. A bare SHA-256 of a handle is
 * brute-forceable from a list of known handles; the secret makes that infeasible without the key.
 */
export function hashAuthor(secret: string, platform: string, handle: string): string {
  const normalised = handle.trim().replace(/^@+/, '').toLowerCase();
  return createHmac('sha256', secret).update(`${platform.toLowerCase()}:${normalised}`).digest('hex');
}

/** Hash of the (already scrubbed) text; part of the classification idempotency key. */
export function textHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Constant-time string comparison that is safe for inputs of different lengths. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
