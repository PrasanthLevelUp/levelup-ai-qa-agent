/**
 * POST /api/ingest — Universal Test Results Ingestion Gateway
 * 
 * Accepts test results from any CI pipeline or cloud grid provider.
 * Authenticates via company API key (Bearer lvlp_live_xxx).
 * Auto-detects format or uses ?provider= hint.
 * Queues failures for healing pipeline.
 * 
 * Supported formats:
 *   - Playwright JSON (application/json)
 *   - JUnit XML (application/xml or text/xml)
 *   - Explicit provider via ?provider=playwright|junit
 *
 * Usage from CI:
 *   curl -X POST https://api.levelupqa.com/api/ingest \
 *     -H "Authorization: Bearer lvlp_live_xxx" \
 *     -H "Content-Type: application/json" \
 *     -d @test-results.json
 *
 *   curl -X POST https://api.levelupqa.com/api/ingest?provider=junit \
 *     -H "Authorization: Bearer lvlp_live_xxx" \
 *     -H "Content-Type: application/xml" \
 *     -d @test-results.xml
 */

import { Router, type Request, type Response } from 'express';
import { verifyApiKey, hasScope, type ApiKeyRecord } from '../services/api-key-service';
import { autoDetectAndParse, parseWithProvider, getSupportedProviders } from '../../providers/adapter-factory';
import type { ProviderType, IngestPayload } from '../../providers/types';
import { getPool } from '../../db/postgres';
const pool = getPool();
import { JobQueue } from '../queue/job-queue';
import { logger } from '../../utils/logger';

const MOD = 'ingest-api';
const router = Router();

// Simple in-memory rate limiter per company
const rateLimits = new Map<number, { count: number; resetAt: number }>();

function checkRateLimit(apiKey: ApiKeyRecord): boolean {
  const now = Date.now();
  const window = 60_000; // 1 minute window
  let entry = rateLimits.get(apiKey.company_id);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + window };
    rateLimits.set(apiKey.company_id, entry);
  }

  entry.count++;
  return entry.count <= apiKey.rate_limit;
}

export function createIngestRouter(jobQueue: JobQueue): Router {

  /**
   * POST /api/ingest — Submit test results for analysis & healing
   */
  router.post('/', async (req: Request, res: Response) => {
    try {
      // --- 1. Authenticate via API key ---
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith('Bearer ')) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Missing Authorization header. Use: Bearer lvlp_live_xxx',
          docs: 'https://docs.levelupqa.com/api/ingest',
        });
        return;
      }

      const rawKey = authHeader.slice(7).trim();
      const apiKey = await verifyApiKey(rawKey);
      if (!apiKey) {
        res.status(401).json({
          error: 'Unauthorized',
          message: 'Invalid, inactive, or expired API key.',
        });
        return;
      }

      // --- 2. Check scope ---
      if (!hasScope(apiKey, 'ingest:write')) {
        res.status(403).json({
          error: 'Forbidden',
          message: 'API key does not have ingest:write scope.',
        });
        return;
      }

      // --- 3. Rate limit ---
      if (!checkRateLimit(apiKey)) {
        res.status(429).json({
          error: 'Rate Limit Exceeded',
          message: `Rate limit: ${apiKey.rate_limit} requests/minute`,
        });
        return;
      }

      // --- 4. Parse body ---
      const contentType = req.headers['content-type'] || '';
      const providerHint = (req.query.provider as string)?.toLowerCase();
      let rawData: any;

      if (contentType.includes('xml') || providerHint === 'junit') {
        // For XML, body may be string or buffer
        rawData = typeof req.body === 'string' ? req.body : req.body?.toString?.() || '';
      } else {
        rawData = req.body;
      }

      if (!rawData || (typeof rawData === 'object' && Object.keys(rawData).length === 0)) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Empty request body. Send test results as JSON or XML.',
          supported: getSupportedProviders(),
        });
        return;
      }

      // --- 5. Extract metadata from headers/query ---
      const meta: Record<string, any> = {
        repoUrl: req.headers['x-repo-url'] || req.query.repo_url,
        repoName: req.headers['x-repo-name'] || req.query.repo_name,
        branch: req.headers['x-branch'] || req.query.branch,
        commit: req.headers['x-commit'] || req.query.commit,
        buildId: req.headers['x-build-id'] || req.query.build_id,
        triggerSource: 'api',
      };

      // --- 6. Parse with adapter ---
      let payload: IngestPayload;
      try {
        if (providerHint) {
          payload = parseWithProvider(providerHint as ProviderType, rawData, meta);
        } else {
          payload = autoDetectAndParse(rawData, meta);
        }
      } catch (parseErr: any) {
        res.status(422).json({
          error: 'Unprocessable Entity',
          message: parseErr.message,
          supported: getSupportedProviders(),
        });
        return;
      }

      // --- 7. Create ingestion log ---
      const ingestionResult = await pool.query(
        `INSERT INTO ingestion_logs
          (company_id, provider, build_id, repo_url, branch, commit_sha,
           total_tests, passed_tests, failed_tests, skipped_tests, status, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [
          apiKey.company_id,
          payload.provider,
          payload.buildId,
          payload.repoUrl,
          payload.branch,
          payload.commit,
          payload.totalTests,
          payload.passedTests,
          payload.failedTests,
          payload.skippedTests,
          payload.failedTests > 0 ? 'processing' : 'completed',
          JSON.stringify({ triggerSource: 'api', companyName: apiKey.company_name }),
        ],
      );
      const ingestionId = ingestionResult.rows[0].id;

      logger.info(MOD, 'Ingestion received', {
        ingestionId,
        companyId: apiKey.company_id,
        company: apiKey.company_name,
        provider: payload.provider,
        total: payload.totalTests,
        failed: payload.failedTests,
        failures: payload.results.length,
      });

      // --- 8. Queue healing if there are failures ---
      let healingJobId: string | null = null;

      if (payload.results.length > 0 && payload.repoUrl) {
        // Create a healing job from the ingested results
        const job = jobQueue.createJob(
          payload.repoName || payload.repoUrl,
          payload.branch || 'main',
          payload.commit,
          payload.repoUrl,
          apiKey.company_id,
        );
        healingJobId = job.id;

        // Store the pre-parsed artifacts on the job so the pipeline can skip execution
        (job as any).ingestedPayload = payload;
        (job as any).ingestionId = ingestionId;

        // Update ingestion log with job reference
        await pool.query(
          'UPDATE ingestion_logs SET healing_job_id = $1 WHERE id = $2',
          [healingJobId, ingestionId],
        );

        logger.info(MOD, 'Healing job queued from ingestion', {
          ingestionId, healingJobId,
          failures: payload.results.length,
        });
      } else if (payload.results.length > 0 && !payload.repoUrl) {
        // Failures found but no repo URL — store for analysis only
        await pool.query(
          `UPDATE ingestion_logs SET status = 'completed',
           error_message = 'No repo_url provided — analysis only, no healing triggered',
           completed_at = NOW()
           WHERE id = $1`,
          [ingestionId],
        );
      } else {
        // All tests passed
        await pool.query(
          `UPDATE ingestion_logs SET status = 'completed', completed_at = NOW() WHERE id = $1`,
          [ingestionId],
        );
      }

      // --- 9. Return response ---
      res.status(202).json({
        success: true,
        ingestionId,
        provider: payload.provider,
        summary: {
          total: payload.totalTests,
          passed: payload.passedTests,
          failed: payload.failedTests,
          skipped: payload.skippedTests,
          failuresDetected: payload.results.length,
        },
        healingJobId,
        status: healingJobId ? 'healing_queued' : (payload.failedTests > 0 ? 'analysis_only' : 'all_passed'),
        message: healingJobId
          ? `${payload.results.length} failure(s) detected. Healing job queued.`
          : payload.failedTests > 0
            ? `${payload.results.length} failure(s) detected but no repo_url provided. Set X-Repo-Url header or ?repo_url= param to enable auto-healing.`
            : 'All tests passed. No healing needed.',
      });

    } catch (err: any) {
      logger.error(MOD, 'Ingest error', { error: err.message, stack: err.stack });
      res.status(500).json({ error: 'Internal Server Error', message: err.message });
    }
  });

  /**
   * GET /api/ingest/history — List ingestion history for a company
   */
  router.get('/history', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const offset = parseInt(req.query.offset as string) || 0;

      const result = await pool.query(
        `SELECT * FROM ingestion_logs
         WHERE company_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [companyId, limit, offset],
      );

      const countResult = await pool.query(
        'SELECT COUNT(*) as total FROM ingestion_logs WHERE company_id = $1',
        [companyId],
      );

      res.json({
        items: result.rows,
        total: parseInt(countResult.rows[0].total),
        limit,
        offset,
      });
    } catch (err: any) {
      logger.error(MOD, 'Ingest history error', { error: err.message });
      res.status(500).json({ error: 'Internal Server Error', message: err.message });
    }
  });

  /**
   * GET /api/ingest/providers — List supported providers
   */
  router.get('/providers', (_req: Request, res: Response) => {
    res.json({
      providers: getSupportedProviders(),
      upcoming: ['browserstack', 'lambdatest', 'cypress', 'allure'],
    });
  });

  return router;
}
