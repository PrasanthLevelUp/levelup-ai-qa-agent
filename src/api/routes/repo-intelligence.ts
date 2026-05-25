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
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
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

/** Check if a string looks like a remote URL (GitHub, GitLab, etc.) */
function isRemoteUrl(str: string): boolean {
  return /^https?:\/\//.test(str) || /^git@/.test(str);
}

/**
 * Clone a remote repository to a temporary directory.
 * Returns the path to the cloned directory.
 * Supports GitHub authentication via GITHUB_TOKEN env var.
 */
function cloneToTemp(repoUrl: string, branch: string = 'main'): string {
  const tmpDir = path.join(os.tmpdir(), `repo_scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  // Inject GitHub token for private repos if available
  let cloneUrl = repoUrl;
  const ghToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (ghToken && repoUrl.includes('github.com') && repoUrl.startsWith('https://')) {
    // https://github.com/owner/repo → https://<token>@github.com/owner/repo
    cloneUrl = repoUrl.replace('https://github.com', `https://${ghToken}@github.com`);
  }

  // Ensure .git suffix for clone compatibility
  if (!cloneUrl.endsWith('.git')) {
    cloneUrl += '.git';
  }

  logger.info(MOD, `Cloning ${repoUrl} (branch: ${branch}) to temp dir...`);

  try {
    execSync(
      `git clone --depth 1 --branch "${branch}" "${cloneUrl}" "${tmpDir}"`,
      { encoding: 'utf-8', timeout: 120_000, stdio: 'pipe' }
    );
  } catch (err: any) {
    // Clean up on failure
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

    const msg = err.stderr || err.message || String(err);
    if (msg.includes('Authentication') || msg.includes('could not read Username')) {
      throw new Error(
        `GitHub authentication failed for ${repoUrl}. ` +
        `To scan private repos, set GITHUB_TOKEN environment variable on Railway.`
      );
    }
    if (msg.includes('not found') || msg.includes('does not exist')) {
      throw new Error(`Repository not found: ${repoUrl}. Check the URL and branch name.`);
    }
    if (msg.includes('Remote branch') && msg.includes('not found')) {
      throw new Error(`Branch "${branch}" not found in ${repoUrl}.`);
    }
    throw new Error(`Failed to clone repository: ${msg.slice(0, 500)}`);
  }

  logger.info(MOD, `Clone complete → ${tmpDir}`);
  return tmpDir;
}

/** Safely remove a temp directory */
function cleanupTemp(dirPath: string): void {
  try {
    if (dirPath.startsWith(os.tmpdir()) && fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
      logger.info(MOD, `Cleaned up temp dir: ${dirPath}`);
    }
  } catch (err: any) {
    logger.warn(MOD, `Failed to clean up temp dir ${dirPath}: ${err.message}`);
  }
}

export function createRepoIntelligenceRouter(): Router {
  const router = Router();

  /* ── POST /scan — Trigger repository scan ───────────── */
  router.post('/scan', async (req: Request, res: Response) => {
    const startTime = Date.now();
    let tempCloneDir: string | null = null;

    try {
      const { repoPath, repoId, branch } = req.body as {
        repoPath?: string;
        repoId?: string;
        branch?: string;
      };

      if (!repoId) {
        return res.status(400).json({
          success: false,
          error: 'repoId is required',
        });
      }

      if (!repoPath) {
        return res.status(400).json({
          success: false,
          error: 'repoPath (local path or repository URL) is required',
        });
      }

      let scanPath: string;

      if (isRemoteUrl(repoPath)) {
        // ── Remote repository: clone to temp directory ──
        logger.info(MOD, `Remote URL detected for ${repoId}: ${repoPath}`);
        tempCloneDir = cloneToTemp(repoPath, branch || 'main');
        scanPath = tempCloneDir;
      } else {
        // ── Local path: use directly ──
        if (!fs.existsSync(repoPath)) {
          return res.status(400).json({
            success: false,
            error: `Repository path does not exist: ${repoPath}`,
          });
        }
        scanPath = repoPath;
      }

      logger.info(MOD, `Starting scan for repo: ${repoId} at ${scanPath}`);

      const engine = new RepositoryContextEngine();
      const { profile, chunks } = engine.scan(scanPath);

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
    } finally {
      // Always clean up temp clone
      if (tempCloneDir) {
        cleanupTemp(tempCloneDir);
      }
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


