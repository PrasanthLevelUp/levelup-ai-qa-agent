/**
 * Repository Intelligence API Routes
 *
 * POST /api/repo-intelligence/scan           — Trigger full scan on a repository
 * GET  /api/repo-intelligence/list            — List all scanned repositories
 * GET  /api/repo-intelligence/:repoId         — Get stored profile for a repo
 * GET  /api/repo-intelligence/:repoId/helpers  — Get reusable helpers
 * GET  /api/repo-intelligence/:repoId/flows    — Get business flows
 * GET  /api/repo-intelligence/:repoId/chunks   — Get/search code chunks
 * GET  /api/repo-intelligence/:repoId/summary  — Compact summary for AI prompts
 */

import { Router, type Request, type Response } from 'express';
import * as fs from 'fs';
import { UnsupportedLanguageError, SUPPORTED_LANGUAGES } from '../../context/repository-context-engine';
import { buildAIPromptContext } from '../../context/prompt-builder';
import {
  getRepositoryContext,
  getRepositoryContextById,
  searchCodeChunks,
  listRepositoryContexts,
} from '../../db/postgres';
// Phase 2: the clone→scan→persist pipeline is shared with the background
// worker via repo-scan-service so both paths behave identically.
import { scanAndPersistRepo, isRemoteUrl } from '../../services/repo-scan-service';
import { enqueueRepoJob, getRepoJobStatus } from '../../jobs/repo-jobs';
import { workersEnabled } from '../../jobs/queue-config';
import { logger } from '../../utils/logger';

const MOD = 'repo-intelligence';

export function createRepoIntelligenceRouter(): Router {
  const router = Router();

  /* ── POST /scan — Trigger repository scan ─────────────
   *
   * Two modes:
   *  - Synchronous (default, unchanged): clone → scan → persist → respond with
   *    the profile summary. Preserves the exact Phase 1 contract.
   *  - Asynchronous (opt-in): when background workers are enabled AND the
   *    caller passes `async: true`, the scan is enqueued and the endpoint
   *    returns 202 with a jobId to poll via GET /scan/status/:jobId.
   */
  router.post('/scan', async (req: Request, res: Response) => {
    try {
      const { repoPath, repoId, branch, projectId, async: asyncMode } = req.body as {
        repoPath?: string;
        repoId?: string;
        branch?: string;
        projectId?: number;
        async?: boolean;
      };

      if (!repoId) {
        return res.status(400).json({ success: false, error: 'repoId is required' });
      }
      if (!repoPath) {
        return res.status(400).json({
          success: false,
          error: 'repoPath (local path or repository URL) is required',
        });
      }

      // Validate a local path early (remote URLs are validated at clone time).
      if (!isRemoteUrl(repoPath) && !fs.existsSync(repoPath)) {
        return res.status(400).json({
          success: false,
          error: `Repository path does not exist: ${repoPath}`,
        });
      }

      const companyId = (req as any).companyId as number | undefined;

      // ── Asynchronous path (opt-in, requires workers enabled) ──
      if (asyncMode && workersEnabled()) {
        const enq = await enqueueRepoJob({
          type: 'scan',
          repoId,
          repoPath,
          branch,
          projectId,
          companyId,
          source: 'api',
        });
        if (enq) {
          logger.info(MOD, `Scan enqueued for ${repoId}`, { jobId: enq.jobId });
          return res.status(202).json({
            success: true,
            async: true,
            jobId: enq.jobId,
            statusUrl: `/api/repo-intelligence/scan/status/${enq.jobId}`,
            message: 'Scan queued. Poll statusUrl for progress.',
          });
        }
        // Enqueue failed (Redis down) → fall through to synchronous scan.
        logger.warn(MOD, 'Async requested but enqueue failed — running synchronously');
      }

      // ── Synchronous path (default; behaviour identical to Phase 1) ──
      logger.info(MOD, `Starting synchronous scan for repo: ${repoId}`);
      const result = await scanAndPersistRepo({
        repoId,
        repoPath,
        branch,
        projectId,
        companyId,
      });
      const { profile, contextId, chunksInserted, scanDurationMs } = result;

      return res.json({
        success: true,
        contextId,
        summary: {
          framework: profile.framework,
          language: profile.language,
          testPattern: profile.testPattern,
          locatorStrategy: profile.locatorStrategy,
          totalFiles: profile.totalFiles,
          totalTestFiles: profile.totalTestFiles,
          totalHelperFiles: profile.totalHelperFiles,
          businessFlows: profile.businessFlows.length,
          testSuites: profile.testSuites.length,
          helperFunctions: profile.helperFunctions.length,
          pageObjects: profile.pageObjects.length,
          codeChunks: chunksInserted,
          embedded: result.embed?.embedded,
          scanDurationMs,
        },
      });
    } catch (err: any) {
      if (err instanceof UnsupportedLanguageError) {
        logger.warn(MOD, `Scan rejected — unsupported language: ${err.detectedLanguage}`);
        return res.status(400).json({
          success: false,
          error: err.message,
          errorType: 'UNSUPPORTED_LANGUAGE',
          detectedLanguage: err.detectedLanguage,
          supportedLanguages: SUPPORTED_LANGUAGES,
        });
      }
      logger.error(MOD, `Scan failed: ${err.message}`);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── GET /scan/status/:jobId — Poll async scan progress ─────────── */
  router.get('/scan/status/:jobId', async (req: Request, res: Response) => {
    if (!workersEnabled()) {
      return res.status(404).json({
        success: false,
        error: 'Background workers are disabled. Scans run synchronously; there is no job to poll.',
      });
    }
    try {
      const status = await getRepoJobStatus(String(req.params.jobId));
      if (!status) {
        return res.status(404).json({ success: false, error: 'Job not found' });
      }
      return res.json({ success: true, job: status });
    } catch (err: any) {
      logger.error(MOD, `Job status lookup failed: ${err.message}`);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── GET /list — List all scanned repositories ───────── */
  router.get('/list', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const contexts = await listRepositoryContexts(companyId);
      return res.json({ success: true, repositories: contexts });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── GET /:repoId — Get full profile ────────────────── */
  router.get('/:repoId', async (req: Request, res: Response) => {
    try {
      const repoId = req.params['repoId'] as string;
      const companyId = (req as any).companyId as number | undefined;
      const profile = await getRepositoryContext(repoId, companyId, (req as any).projectId);
      if (!profile) {
        // Return 200 with exists:false instead of 404 — unscanned repos are expected, not errors
        return res.json({ success: true, exists: false, profile: null });
      }
      return res.json({ success: true, exists: true, profile });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── GET /:repoId/helpers — Get reusable helpers ────── */
  router.get('/:repoId/helpers', async (req: Request, res: Response) => {
    try {
      const repoId = req.params['repoId'] as string;
      const companyId = (req as any).companyId as number | undefined;
      const profile = await getRepositoryContext(repoId, companyId, (req as any).projectId);
      if (!profile) {
        return res.status(404).json({ success: false, error: 'Repository context not found' });
      }
      return res.json({
        success: true,
        helpers: profile.helperFunctions,
        pageObjects: profile.pageObjects,
        fixtures: profile.fixtures,
        customCommands: profile.customCommands,
        sharedConstants: profile.sharedConstants,
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── GET /:repoId/flows — Get business flows ────────── */
  router.get('/:repoId/flows', async (req: Request, res: Response) => {
    try {
      const repoId = req.params['repoId'] as string;
      const companyId = (req as any).companyId as number | undefined;
      const profile = await getRepositoryContext(repoId, companyId, (req as any).projectId);
      if (!profile) {
        return res.status(404).json({ success: false, error: 'Repository context not found' });
      }
      return res.json({
        success: true,
        flows: profile.businessFlows,
        testSuites: profile.testSuites,
      });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── GET /:repoId/chunks — Search code chunks ──────── */
  router.get('/:repoId/chunks', async (req: Request, res: Response) => {
    try {
      const repoId = req.params['repoId'] as string;
      const companyId = (req as any).companyId as number | undefined;
      const { type, name, limit } = req.query as {
        type?: string;
        name?: string;
        limit?: string;
      };

      // First get the context ID
      const profile = await getRepositoryContext(repoId, companyId, (req as any).projectId);
      if (!profile) {
        return res.status(404).json({ success: false, error: 'Repository context not found' });
      }

      // We need the actual context row ID — get it via list
      const contexts = await listRepositoryContexts(companyId);
      const ctx = contexts.find(c => c.repoId === repoId);
      if (!ctx) {
        return res.status(404).json({ success: false, error: 'Context ID not found' });
      }

      const chunks = await searchCodeChunks(ctx.id, {
        type: type || undefined,
        namePattern: name || undefined,
        limit: limit ? parseInt(limit, 10) : 100,
      });

      return res.json({ success: true, chunks, total: chunks.length });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── GET /:repoId/summary — Compact AI-prompt summary ─ */
  router.get('/:repoId/summary', async (req: Request, res: Response) => {
    try {
      const repoId = req.params['repoId'] as string;
      const companyId = (req as any).companyId as number | undefined;
      const profile = await getRepositoryContext(repoId, companyId, (req as any).projectId);
      if (!profile) {
        return res.status(404).json({ success: false, error: 'Repository context not found' });
      }

      // Build a compact summary optimized for AI prompt injection
      const summary = buildAIPromptContext(profile);
      return res.json({ success: true, summary });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}


