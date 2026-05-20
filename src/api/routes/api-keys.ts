/**
 * API Keys Management Routes
 * CRUD operations for per-company API keys.
 * Protected by user authentication (JWT cookie) — only admins can manage keys.
 */

import { Router, type Request, type Response } from 'express';
import {
  generateApiKey,
  listApiKeys,
  revokeApiKey,
  type ApiKeyScope,
} from '../services/api-key-service';
import { logger } from '../../utils/logger';

const MOD = 'api-keys-route';
const router = Router();

const VALID_SCOPES: ApiKeyScope[] = ['ingest:write', 'jobs:read', 'jobs:trigger', 'healing:read', 'scripts:generate', 'admin'];

/**
 * POST /api/keys — Generate a new API key
 * Body: { name, scopes?, rateLimit?, expiresInDays? }
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const companyId = (req as any).companyId;
    if (!companyId) {
      res.status(400).json({ error: 'Company context required' });
      return;
    }

    const { name, scopes, rateLimit, expiresInDays } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'name is required' });
      return;
    }

    // Validate scopes
    const requestedScopes: ApiKeyScope[] = scopes || ['ingest:write'];
    for (const s of requestedScopes) {
      if (!VALID_SCOPES.includes(s)) {
        res.status(400).json({
          error: `Invalid scope: ${s}`,
          validScopes: VALID_SCOPES,
        });
        return;
      }
    }

    const { rawKey, record } = await generateApiKey(
      companyId,
      name.trim(),
      requestedScopes,
      rateLimit || 1000,
      expiresInDays,
    );

    logger.info(MOD, 'API key created', { companyId, name: name.trim(), prefix: record.prefix });

    res.status(201).json({
      message: 'API key created. Save this key — it will not be shown again.',
      key: rawKey,
      id: record.id,
      prefix: record.prefix,
      name: record.name,
      scopes: record.scopes,
      rateLimit: record.rate_limit,
      expiresAt: record.expires_at,
      createdAt: record.created_at,
    });
  } catch (err: any) {
    logger.error(MOD, 'Create key error', { error: err.message });
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

/**
 * GET /api/keys — List all API keys for company
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const companyId = (req as any).companyId;
    if (!companyId) {
      res.status(400).json({ error: 'Company context required' });
      return;
    }

    const keys = await listApiKeys(companyId);
    res.json({ keys });
  } catch (err: any) {
    logger.error(MOD, 'List keys error', { error: err.message });
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

/**
 * DELETE /api/keys/:id — Revoke an API key
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const companyId = (req as any).companyId;
    const keyId = parseInt(req.params.id as string);

    if (!companyId || isNaN(keyId)) {
      res.status(400).json({ error: 'Invalid request' });
      return;
    }

    const revoked = await revokeApiKey(keyId, companyId);
    if (revoked) {
      res.json({ message: 'API key revoked', id: keyId });
    } else {
      res.status(404).json({ error: 'API key not found or already revoked' });
    }
  } catch (err: any) {
    logger.error(MOD, 'Revoke key error', { error: err.message });
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

export { router as apiKeysRouter };
