// src/middleware/errorHandler.js
// Central Express error handler. Mounted last in server.js.
import { logger } from '../lib/logger.js';

/** Throw this from routes/services for predictable HTTP status codes. */
export class AppError extends Error {
  constructor(message, status = 400, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.details = details;
  }
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  if (status >= 500) {
    logger.error('Unhandled error', { path: req.path, message: err.message });
  } else {
    logger.warn('Request error', { path: req.path, message: err.message });
  }
  res.status(status).json({
    error: err.message || 'Internal Server Error',
    ...(err.details ? { details: err.details } : {}),
  });
}
