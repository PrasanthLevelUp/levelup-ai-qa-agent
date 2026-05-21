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
import { RepositoryContextEngine } from '../../context/repository-context-engine';
import { buildAIPromptContext } from '../../context/prompt-builder';
import {
  saveRepositoryContext,
  getRepositoryContext,
  getRepositoryContextById,
  saveCodeChunks,
  searchCodeChunks,
  listRepositoryContexts,
} from '../../db/postgres';
import { extractCodeChunks } from '../../context/repository-context-engine';
import { logger } from '../../utils/logger';

const MOD = 'repo-intelligence';

export function createRepoIntelligenceRouter(): Router {
  const router = Router();

  /* ── POST /scan — Trigger repository scan ───────────── */
  router.post('/scan', async (req: Request, res: Response) => {
    const startTime = Date.now();
    try {
      const { repoPath, repoId } = req.body as {
        repoPath?: string;
        repoId?: string;
      };

      if (!repoPath || !repoId) {
        return res.status(400).json({
          success: false,
          error: 'repoPath and repoId are required',
        });
      }

      // Validate path exists
      if (!fs.existsSync(repoPath)) {
        return res.status(400).json({
          success: false,
          error: `Repository path does not exist: ${repoPath}`,
        });
      }

      logger.info(MOD, `Starting scan for repo: ${repoId} at ${repoPath}`);

      const engine = new RepositoryContextEngine();
      const { profile, chunks } = engine.scan(repoPath);

      const scanDurationMs = Date.now() - startTime;

      // Get company_id from request (set by companyMiddleware)
      const companyId = (req as any).companyId as number | undefined;

      // Persist to DB
      const contextId = await saveRepositoryContext(repoId, profile, scanDurationMs, companyId);
      const chunksInserted = await saveCodeChunks(contextId, chunks);

      logger.info(MOD, `Scan complete for ${repoId}: ${profile.totalFiles} files, ${profile.helperFunctions.length} helpers, ${chunks.length} chunks in ${scanDurationMs}ms`);

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
          scanDurationMs,
        },
      });
    } catch (err: any) {
      logger.error(MOD, `Scan failed: ${err.message}`);
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
      const profile = await getRepositoryContext(repoId, companyId);
      if (!profile) {
        return res.status(404).json({ success: false, error: 'Repository context not found' });
      }
      return res.json({ success: true, profile });
    } catch (err: any) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── GET /:repoId/helpers — Get reusable helpers ────── */
  router.get('/:repoId/helpers', async (req: Request, res: Response) => {
    try {
      const repoId = req.params['repoId'] as string;
      const companyId = (req as any).companyId as number | undefined;
      const profile = await getRepositoryContext(repoId, companyId);
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
      const profile = await getRepositoryContext(repoId, companyId);
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
      const profile = await getRepositoryContext(repoId, companyId);
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
      const profile = await getRepositoryContext(repoId, companyId);
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


