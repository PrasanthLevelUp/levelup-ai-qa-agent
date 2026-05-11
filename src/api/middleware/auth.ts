/**
 * API Key Authentication Middleware
 * Reads API keys from environment variables (not from JSON config files).
 * Supports comma-separated list: API_KEYS="key1,key2,key3"
 */

import type { Request, Response, NextFunction } from 'express';
import { logger } from '../../utils/logger';

const MOD = 'auth-middleware';

let cachedKeys: string[] | null = null;

function loadApiKeys(): string[] {
  if (cachedKeys) return cachedKeys;

  const envKeys = process.env['API_KEYS'] || '';
  if (!envKeys.trim()) {
    logger.warn(MOD, 'API_KEYS environment variable not set or empty. All API requests will be rejected.');
    cachedKeys = [];
    return cachedKeys;
  }

  cachedKeys = envKeys
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  logger.info(MOD, `Loaded ${cachedKeys.length} API key(s) from environment`);
  return cachedKeys;
}

export function reloadApiKeys(): void {
  cachedKeys = null;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization header. Use: Bearer <API_KEY>',
    });
    return;
  }

  const token = authHeader.slice(7).trim();
  const validKeys = loadApiKeys();

  if (validKeys.length === 0) {
    logger.error(MOD, 'No API keys configured. Set API_KEYS environment variable.');
    res.status(500).json({
      error: 'Server Configuration Error',
      message: 'API authentication is not configured. Contact administrator.',
    });
    return;
  }

  if (!validKeys.includes(token)) {
    logger.warn(MOD, 'Invalid API key attempt', {
      keyPrefix: token.slice(0, 8) + '...',
    });
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or inactive API key.',
    });
    return;
  }

  // Attach key info to request
  (req as any).apiKeyName = `key_${validKeys.indexOf(token) + 1}`;
  logger.debug(MOD, 'Authenticated', { keyIndex: validKeys.indexOf(token) + 1 });
  next();
}
