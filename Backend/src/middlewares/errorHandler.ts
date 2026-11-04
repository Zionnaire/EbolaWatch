import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/appError.js';
import { logger } from '../utils/logger.js';

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: { code: err.code, message: err.message } });
    return;
  }
  if (err instanceof ZodError) {
    res
      .status(400)
      .json({ error: { code: 'validation_error', message: 'Invalid request', issues: err.issues } });
    return;
  }
  // body-parser and friends set `status` on client errors (e.g. malformed JSON)
  const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) logger.error({ err }, 'unhandled error');
  res.status(status).json({
    error: {
      code: status === 500 ? 'internal' : 'bad_request',
      message: status === 500 ? 'Internal error' : String(err.message),
    },
  });
};
