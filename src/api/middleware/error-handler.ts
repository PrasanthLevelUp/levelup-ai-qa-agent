/**
 * Global Error Handler Middleware
 */

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../../utils/logger';

const MOD = 'error-handler';

export function errorHandler(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  logger.error(MOD, 'Unhandled error', {
    message: err.message,
    stack: err.stack?.slice(0, 500),
  });

  const statusCode = (err as any).statusCode || 500;

  res.status(statusCode).json({
    error: statusCode === 500 ? 'Internal Server Error' : err.message,
    message: err.message,
    ...(process.env.NODE_ENV !== 'production' ? { stack: err.stack } : {}),
  });
}
