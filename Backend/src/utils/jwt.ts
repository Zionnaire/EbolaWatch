import { createHmac, timingSafeEqual } from 'node:crypto';
import { AppError } from './appError.js';

/**
 * Minimal HS256 JSON Web Token implementation (RFC 7519) on node:crypto, so authentication needs no extra
 * dependency. Deliberately narrow: only HS256, an exactly-matching header (so `alg: none` and algorithm
 * confusion are rejected outright), a required expiry, and a required token type.
 */
export type TokenType = 'access' | 'refresh';

export interface TokenClaims {
  /** User id. */
  sub: string;
  role: string;
  /** Organization id, or null for a platform operator. */
  org: string | null;
  /** The user's tokenVersion when issued: bumping it on the user revokes every older token. */
  tv: number;
  typ: TokenType;
  iat: number;
  exp: number;
}

const b64 = (v: Buffer | string) => Buffer.from(v).toString('base64url');
const HEADER = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

const sign = (data: string, secret: string) => createHmac('sha256', secret).update(data).digest();

export function signToken(
  claims: Omit<TokenClaims, 'iat' | 'exp'>,
  secret: string,
  ttlSeconds: number,
  nowMs: number = Date.now(),
): string {
  const iat = Math.floor(nowMs / 1000);
  const payload = b64(JSON.stringify({ ...claims, iat, exp: iat + ttlSeconds }));
  const data = `${HEADER}.${payload}`;
  return `${data}.${b64(sign(data, secret))}`;
}

const invalid = () => new AppError(401, 'Invalid or expired session', 'invalid_token');

export function verifyToken(
  token: string,
  secret: string,
  expectedType: TokenType,
  nowMs: number = Date.now(),
): TokenClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw invalid();
  const [header, payload, signature] = parts as [string, string, string];
  if (header !== HEADER) throw invalid(); // anything but our exact HS256 header, including "alg":"none"

  const expected = sign(`${header}.${payload}`, secret);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw invalid();

  let claims: Partial<TokenClaims>;
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<TokenClaims>;
  } catch {
    throw invalid();
  }
  if (
    typeof claims.sub !== 'string' ||
    typeof claims.role !== 'string' ||
    !(typeof claims.org === 'string' || claims.org === null) ||
    typeof claims.tv !== 'number' ||
    typeof claims.iat !== 'number' ||
    typeof claims.exp !== 'number' ||
    claims.typ !== expectedType
  ) {
    throw invalid();
  }
  if (claims.exp * 1000 <= nowMs) throw new AppError(401, 'Your session has expired', 'token_expired');
  return claims as TokenClaims;
}
