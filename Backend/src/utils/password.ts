import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/** scrypt parameters (OWASP-acceptable). They are stored in each hash, so they can be raised later. */
const N = 16_384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const maxmem = (n: number, r: number) => 128 * n * r * 2;

/** `scrypt$N$r$p$<salt>$<hash>` (salt and hash base64url). */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, KEY_LENGTH, { N, r: R, p: P, maxmem: maxmem(N, R) });
  return ['scrypt', N, R, P, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

/** Constant-time check. A malformed stored hash is simply "no match". */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  if (![params.N, params.r, params.p].every((v) => Number.isInteger(v) && v > 0)) return false;
  try {
    const expected = Buffer.from(hash, 'base64url');
    const actual = await scrypt(password, Buffer.from(salt, 'base64url'), expected.length, {
      ...params,
      maxmem: maxmem(params.N, params.r),
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | null = null;
/**
 * Verifies against a throwaway hash. Used when the email is unknown so that "no such user" costs the same time
 * as "wrong password" and login does not reveal which emails exist.
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummy ??= hashPassword('not-a-real-password');
  await verifyPassword(password, await dummy);
}
