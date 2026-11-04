import { createHash, randomBytes } from 'node:crypto';

/** A single-use secret for claim and invite links. Only its hash is stored, so a database leak reveals no links. */
export function newOpaqueToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashOpaqueToken(token) };
}

export function hashOpaqueToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
