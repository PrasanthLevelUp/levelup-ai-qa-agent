/**
 * User Credential Management API Routes
 *
 * POST   /api/credentials              — Store a new encrypted credential
 * GET    /api/credentials              — List current user's credentials (metadata only)
 * GET    /api/credentials/company      — List all company credentials (admin only)
 * DELETE /api/credentials/:id          — Deactivate a credential
 * GET    /api/credentials/status/:type — Check if a credential type is configured
 *
 * Credentials are stored encrypted with AES-256-GCM per user.
 * The encrypted values are NEVER returned in API responses.
 */

import { Router, type Request, type Response } from 'express';
import {
  createUserCredential,
  getUserCredential,
  listUserCredentials,
  listCompanyCredentials,
  deactivateUserCredential,
  touchCredentialUsage,
  logAudit,
} from '../../db/postgres';
import { encryptCredential, decryptCredential, isEncryptionConfigured } from '../../utils/crypto';
import { logger } from '../../utils/logger';

const MOD = 'credentials-routes';

export function createCredentialsRouter(): Router {
  const router = Router();

  /* ── Store a credential ─────────────────────────────────── */
  router.post('/', async (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId as number | undefined;
      const companyId = (req as any).companyId as number;

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: 'User authentication required to store credentials.',
        });
      }

      if (!isEncryptionConfigured()) {
        return res.status(500).json({
          success: false,
          error: 'Credential encryption is not configured. Contact administrator.',
        });
      }

      const { credentialType, label, value, metadata, isCompanyDefault } = req.body;

      if (!credentialType || !value) {
        return res.status(400).json({
          success: false,
          error: 'credentialType and value are required.',
        });
      }

      // Validate credential type
      const validTypes = ['github', 'gitlab', 'jira', 'slack', 'teams', 'bitbucket', 'azure_devops'];
      if (!validTypes.includes(credentialType)) {
        return res.status(400).json({
          success: false,
          error: `Invalid credentialType. Must be one of: ${validTypes.join(', ')}`,
        });
      }

      // Encrypt the credential value
      const valueStr = typeof value === 'string' ? value : JSON.stringify(value);
      const encrypted = encryptCredential(valueStr);

      const row = await createUserCredential({
        user_id: userId,
        company_id: companyId,
        credential_type: credentialType,
        label: label || 'default',
        encrypted_value: encrypted.encrypted,
        iv: encrypted.iv,
        auth_tag: encrypted.authTag,
        metadata: metadata || {},
        is_company_default: isCompanyDefault || false,
      });

      // Audit log
      await logAudit({
        user_id: userId,
        username: (req as any).username || 'unknown',
        action: 'credential.created',
        resource: 'user_credentials',
        resource_id: String(row.id),
        ip_address: String(req.ip || ''),
        user_agent: String(req.headers['user-agent'] || ''),
        details: { credentialType, label: label || 'default', isCompanyDefault: isCompanyDefault || false },
      });

      logger.info(MOD, 'Credential stored', { userId, credentialType, credentialId: row.id });

      res.json({
        success: true,
        data: {
          id: row.id,
          credentialType: row.credential_type,
          label: row.label,
          metadata: row.metadata,
          isCompanyDefault: row.is_company_default,
          createdAt: row.created_at,
        },
      });
    } catch (err: any) {
      logger.error(MOD, 'POST / error', { error: err.message });
      res.status(500).json({ success: false, error: 'Failed to store credential' });
    }
  });

  /* ── List user's credentials ────────────────────────────── */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId as number | undefined;
      const companyId = (req as any).companyId as number;

      if (!userId) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const creds = await listUserCredentials(userId, companyId);
      res.json({
        success: true,
        data: creds.map(c => ({
          id: c.id,
          credentialType: c.credential_type,
          label: c.label,
          metadata: c.metadata,
          isCompanyDefault: c.is_company_default,
          expiresAt: c.expires_at,
          lastUsedAt: c.last_used_at,
          createdAt: c.created_at,
        })),
      });
    } catch (err: any) {
      logger.error(MOD, 'GET / error', { error: err.message });
      res.status(500).json({ success: false, error: 'Failed to list credentials' });
    }
  });

  /* ── List company credentials (admin) ───────────────────── */
  router.get('/company', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number;
      const type = req.query.type as string | undefined;

      const creds = await listCompanyCredentials(companyId, type);
      res.json({
        success: true,
        data: creds.map(c => ({
          id: c.id,
          userId: c.user_id,
          username: (c as any).username,
          credentialType: c.credential_type,
          label: c.label,
          metadata: c.metadata,
          isCompanyDefault: c.is_company_default,
          expiresAt: c.expires_at,
          lastUsedAt: c.last_used_at,
          createdAt: c.created_at,
        })),
      });
    } catch (err: any) {
      logger.error(MOD, 'GET /company error', { error: err.message });
      res.status(500).json({ success: false, error: 'Failed to list company credentials' });
    }
  });

  /* ── Check credential status ────────────────────────────── */
  router.get('/status/:type', async (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId as number | undefined;
      const companyId = (req as any).companyId as number;
      const credentialType = String(req.params.type);

      if (!userId) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      const cred = await getUserCredential(userId, companyId, credentialType);

      if (!cred) {
        return res.json({
          success: true,
          data: {
            configured: false,
            source: null,
          },
        });
      }

      res.json({
        success: true,
        data: {
          configured: true,
          source: cred.user_id === userId ? 'personal' : 'company_default',
          metadata: cred.metadata,
          lastUsedAt: cred.last_used_at,
          expiresAt: cred.expires_at,
        },
      });
    } catch (err: any) {
      logger.error(MOD, 'GET /status/:type error', { error: err.message });
      res.status(500).json({ success: false, error: 'Failed to check credential status' });
    }
  });

  /* ── Deactivate a credential ────────────────────────────── */
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const userId = (req as any).userId as number | undefined;
      const companyId = (req as any).companyId as number;
      const credentialId = parseInt(String(req.params.id), 10);

      if (!userId) {
        return res.status(401).json({ success: false, error: 'Authentication required' });
      }

      if (isNaN(credentialId)) {
        return res.status(400).json({ success: false, error: 'Invalid credential ID' });
      }

      const deleted = await deactivateUserCredential(credentialId, userId, companyId);
      if (!deleted) {
        return res.status(404).json({ success: false, error: 'Credential not found or not owned by you' });
      }

      // Audit log
      await logAudit({
        user_id: userId,
        username: (req as any).username || 'unknown',
        action: 'credential.deleted',
        resource: 'user_credentials',
        resource_id: String(credentialId),
        ip_address: String(req.ip || ''),
        user_agent: String(req.headers['user-agent'] || ''),
      });

      res.json({ success: true });
    } catch (err: any) {
      logger.error(MOD, 'DELETE /:id error', { error: err.message });
      res.status(500).json({ success: false, error: 'Failed to delete credential' });
    }
  });

  return router;
}
