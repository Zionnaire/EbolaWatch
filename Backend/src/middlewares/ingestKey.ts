import type { RequestHandler } from 'express';
import { AppError } from '../utils/appError.js';
import { safeEqual } from '../utils/hashing.js';

/** Protects POST /api/ingest. Accepts `X-Api-Key: <key>` or `Authorization: Bearer <key>`; constant-time compare. */
export function ingestKey(expected: string): RequestHandler {
  return (req, _res, next) => {
    const header = req.header('x-api-key');
    const bearer = req.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    const provided = header ?? bearer;
    if (!provided || !safeEqual(provided, expected)) {
      throw new AppError(401, 'Invalid or missing API key', 'invalid_api_key');
    }
    next();
  };
}
