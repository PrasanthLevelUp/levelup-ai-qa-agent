/**
 * API Key Authentication Middleware
 */

import type { Request, Response, NextFunction } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../utils/logger';

const MOD = 'auth-middleware';

interface ApiKeyEntry {
  key: string;
  name: string;
  active: boolean;
}

interface ApiKeysConfig {
  keys: ApiKeyEntry[];
}

let cachedKeys: ApiKeysConfig | null = null;

function loadApiKeys(): ApiKeysConfig {
  if (cachedKeys) return cachedKeys;

  const configPath = path.join(__dirname, '../../config/api-keys.json');
  if (!fs.existsSync(configPath)) {
    logger.warn(MOD, 'api-keys.json not found, using empty key list');
    return { keys: [] };
  }

  cachedKeys = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as ApiKeysConfig;
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
  const config = loadApiKeys();
  const matchedKey = config.keys.find((k) => k.key === token && k.active);

  if (!matchedKey) {
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
  (req as any).apiKeyName = matchedKey.name;
  logger.debug(MOD, 'Authenticated', { keyName: matchedKey.name });
  next();
}
