/**
 * Webhook Receivers for Cloud Test Platforms
 * 
 * POST /api/hooks/browserstack — Receives BrowserStack build_finished callbacks
 * POST /api/hooks/lambdatest   — Receives LambdaTest build completion callbacks
 * 
 * Both endpoints:
 *   1. Verify webhook signature (HMAC SHA-256) if secret configured
 *   2. Extract build ID from payload
 *   3. Fetch full session results via provider's REST API
 *   4. Feed into the ingestion pipeline
 * 
 * Company is identified by the webhook URL token:
 *   /api/hooks/browserstack?token=lvlp_live_xxx
 */

import { Router, type Request, type Response } from 'express';
import * as crypto from 'crypto';
import { verifyApiKey, hasScope } from '../services/api-key-service';
import { getPool } from '../../db/postgres';
const pool = getPool();
import { logger } from '../../utils/logger';

const MOD = 'hooks';
const router = Router();

/**
 * POST /api/hooks/browserstack
 * BrowserStack sends build_finished webhook with session data.
 * Docs: https://www.browserstack.com/docs/automate/api-reference
 */
router.post('/browserstack', async (req: Request, res: Response) => {
  try {
    // Authenticate via token query param (API key)
    const token = req.query.token as string;
    if (!token) {
      res.status(401).json({ error: 'Missing token parameter. Append ?token=lvlp_live_xxx to webhook URL.' });
      return;
    }

    const apiKey = await verifyApiKey(token);
    if (!apiKey || !hasScope(apiKey, 'ingest:write')) {
      res.status(401).json({ error: 'Invalid or unauthorized token.' });
      return;
    }

    // Optional: verify BrowserStack webhook signature
    const webhookSecret = await getCompanyWebhookSecret(apiKey.company_id, 'browserstack');
    if (webhookSecret) {
      const signature = req.headers['x-signature'] as string || req.headers['x-percy-digest'] as string;
      const bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      if (!verifyHmacSignature(bodyStr, signature, webhookSecret)) {
        logger.warn(MOD, 'BrowserStack webhook signature mismatch', { companyId: apiKey.company_id });
        res.status(403).json({ error: 'Invalid webhook signature.' });
        return;
      }
    }

    const payload = req.body;
    const buildId = payload?.build_id || payload?.id || payload?.build?.id;
    const buildName = payload?.build_name || payload?.name || payload?.build?.name;
    const status = payload?.status || payload?.build?.status;

    logger.info(MOD, 'BrowserStack webhook received', {
      companyId: apiKey.company_id,
      buildId,
      buildName,
      status,
    });

    // Log the ingestion
    const ingestionResult = await pool.query(
      `INSERT INTO ingestion_logs
        (company_id, provider, build_id, status, metadata)
       VALUES ($1, 'browserstack', $2, 'received', $3)
       RETURNING id`,
      [
        apiKey.company_id,
        buildId,
        JSON.stringify({
          triggerSource: 'webhook',
          buildName,
          webhookStatus: status,
          rawPayloadKeys: Object.keys(payload || {}),
        }),
      ],
    );

    const ingestionId = ingestionResult.rows[0].id;

    // TODO Phase 2: Fetch full session results from BrowserStack REST API
    // using company's stored BS credentials, then parse with BrowserStack adapter
    // For now, log and acknowledge
    await pool.query(
      `UPDATE ingestion_logs SET status = 'received',
       error_message = 'BrowserStack adapter coming in Phase 2. Build data logged.'
       WHERE id = $1`,
      [ingestionId],
    );

    res.status(200).json({
      success: true,
      ingestionId,
      message: 'BrowserStack webhook received. Full session parsing coming in Phase 2.',
      buildId,
    });

  } catch (err: any) {
    logger.error(MOD, 'BrowserStack hook error', { error: err.message });
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

/**
 * POST /api/hooks/lambdatest
 * LambdaTest (TestMu AI) sends build completion webhook.
 */
router.post('/lambdatest', async (req: Request, res: Response) => {
  try {
    const token = req.query.token as string;
    if (!token) {
      res.status(401).json({ error: 'Missing token parameter.' });
      return;
    }

    const apiKey = await verifyApiKey(token);
    if (!apiKey || !hasScope(apiKey, 'ingest:write')) {
      res.status(401).json({ error: 'Invalid or unauthorized token.' });
      return;
    }

    // Optional: verify LambdaTest webhook signature
    const webhookSecret = await getCompanyWebhookSecret(apiKey.company_id, 'lambdatest');
    if (webhookSecret) {
      const signature = req.headers['x-lt-signature'] as string;
      const bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
      if (!verifyHmacSignature(bodyStr, signature, webhookSecret)) {
        res.status(403).json({ error: 'Invalid webhook signature.' });
        return;
      }
    }

    const payload = req.body;
    const buildId = payload?.build_id || payload?.session_id || payload?.data?.build_id;
    const buildName = payload?.build_name || payload?.data?.build_name;

    logger.info(MOD, 'LambdaTest webhook received', {
      companyId: apiKey.company_id,
      buildId,
      buildName,
    });

    const ingestionResult = await pool.query(
      `INSERT INTO ingestion_logs
        (company_id, provider, build_id, status, metadata)
       VALUES ($1, 'lambdatest', $2, 'received', $3)
       RETURNING id`,
      [
        apiKey.company_id,
        buildId,
        JSON.stringify({
          triggerSource: 'webhook',
          buildName,
          rawPayloadKeys: Object.keys(payload || {}),
        }),
      ],
    );

    const ingestionId = ingestionResult.rows[0].id;

    await pool.query(
      `UPDATE ingestion_logs SET status = 'received',
       error_message = 'LambdaTest adapter coming in Phase 2. Build data logged.'
       WHERE id = $1`,
      [ingestionId],
    );

    res.status(200).json({
      success: true,
      ingestionId,
      message: 'LambdaTest webhook received. Full session parsing coming in Phase 2.',
      buildId,
    });

  } catch (err: any) {
    logger.error(MOD, 'LambdaTest hook error', { error: err.message });
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});

/**
 * GET /api/hooks/info — Get webhook URLs for a company
 */
router.get('/info', async (req: Request, res: Response) => {
  try {
    const companyId = (req as any).companyId;
    const baseUrl = process.env['PUBLIC_API_URL'] || `${req.protocol}://${req.get('host')}`;

    res.json({
      webhookUrls: {
        browserstack: `${baseUrl}/api/hooks/browserstack?token=YOUR_API_KEY`,
        lambdatest: `${baseUrl}/api/hooks/lambdatest?token=YOUR_API_KEY`,
        github: `${baseUrl}/api/webhook/github`,
      },
      instructions: {
        browserstack: 'In BrowserStack Dashboard → Settings → Webhooks, add the URL above. Replace YOUR_API_KEY with your LevelUp API key.',
        lambdatest: 'In LambdaTest Dashboard → Settings → Webhooks, add the URL above. Replace YOUR_API_KEY with your LevelUp API key.',
        ci_pipeline: `curl -X POST ${baseUrl}/api/ingest -H "Authorization: Bearer YOUR_API_KEY" -H "Content-Type: application/json" -d @test-results.json`,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- Helpers ---

function verifyHmacSignature(body: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  try {
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    // Handle both raw hex and prefixed formats (sha256=xxx)
    const actual = signature.startsWith('sha256=') ? signature.slice(7) : signature;
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
  } catch {
    return false;
  }
}

async function getCompanyWebhookSecret(companyId: number, provider: string): Promise<string | null> {
  try {
    const result = await pool.query(
      `SELECT config FROM notification_configs
       WHERE tool_type = $1 AND (company_id = $2 OR company_id IS NULL)
       ORDER BY company_id DESC NULLS LAST LIMIT 1`,
      [`${provider}_webhook`, companyId],
    );
    if (result.rows.length > 0) {
      return result.rows[0].config?.webhook_secret || null;
    }
  } catch { /* ignore */ }
  return null;
}

export { router as hooksRouter };
