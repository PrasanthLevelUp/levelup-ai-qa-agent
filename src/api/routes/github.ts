/**
 * GitHub Integration API Routes
 *
 * GET  /api/github/status         — Check connection status
 * GET  /api/github/repos          — List accessible repositories
 * GET  /api/github/repos/:owner/:repo/branches — List branches
 * POST /api/github/create-pr      — Create PR with generated files
 *
 * Uses the GitHub PAT stored via Tools page (notification_configs).
 * Token is NEVER returned or logged by these endpoints.
 */

import { Router, type Request, type Response } from 'express';
import {
  GitHubService,
  type PRCreationRequest,
} from '../../integrations/github-service';
import { getGeneratedScript } from '../../db/postgres';
import type { GeneratedFile } from '../../script-gen/script-gen-engine';
import { logger } from '../../utils/logger';

const MOD = 'github-routes';

export function createGitHubRouter(): Router {
  const router = Router();
  const github = new GitHubService();

  /* ── Connection Status ───────────────────────────────── */
  router.get('/status', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const status = await github.getConnectionStatus(companyId);
      res.json({ success: true, data: status });
    } catch (err: any) {
      logger.error(MOD, 'GET /status error', { error: err.message });
      res.status(500).json({ success: false, error: 'Failed to check GitHub status' });
    }
  });

  /* ── List Repositories ───────────────────────────────── */
  router.get('/repos', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const page = parseInt(req.query.page as string) || 1;
      const perPage = parseInt(req.query.per_page as string) || 30;
      const sort = String(req.query.sort || 'pushed');

      const result = await github.listRepos(companyId, { page, perPage, sort });

      if (result.error) {
        res.status(400).json({ success: false, error: result.error });
        return;
      }

      res.json({
        success: true,
        data: result.repos,
        pagination: { page, perPage, hasMore: result.hasMore },
      });
    } catch (err: any) {
      logger.error(MOD, 'GET /repos error', { error: err.message });
      res.status(500).json({ success: false, error: 'Failed to list repositories' });
    }
  });

  /* ── List Branches for a Repo ────────────────────────── */
  router.get('/repos/:owner/:repo/branches', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const owner = String(req.params.owner);
      const repo = String(req.params.repo);

      if (!owner || !repo) {
        res.status(400).json({ success: false, error: 'owner and repo are required' });
        return;
      }

      const result = await github.listBranches(owner, repo, companyId);

      if (result.error) {
        res.status(400).json({ success: false, error: result.error });
        return;
      }

      res.json({ success: true, data: result.branches });
    } catch (err: any) {
      logger.error(MOD, 'GET /repos/:owner/:repo/branches error', { error: err.message });
      res.status(500).json({ success: false, error: 'Failed to list branches' });
    }
  });

  /* ── Create Pull Request ─────────────────────────────── */
  router.post('/create-pr', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const {
        repoOwner,
        repoName,
        branchName,
        title,
        body,
        files,
        baseBranch,
        scriptId,
      } = req.body;

      // Option 1: Provide files directly
      // Option 2: Provide scriptId to load files from a previous generation
      let resolvedFiles: Array<{ path: string; content: string }> = files || [];

      if (scriptId && !files?.length) {
        const script = await getGeneratedScript(scriptId, companyId);
        if (!script) {
          res.status(404).json({ success: false, error: 'Script not found' });
          return;
        }
        if (!script.script_content || !script.files_generated) {
          res.status(400).json({ success: false, error: 'Script has no generated files' });
          return;
        }

        // Reconstruct files from stored content
        const filesInfo = script.files_generated as Array<{ path: string; size: number; type: string }>;
        const chunks = (script.script_content as string).split('\n// === ').filter(Boolean);
        resolvedFiles = chunks.map((chunk: string, i: number) => {
          const firstNewline = chunk.indexOf('\n');
          const filePath = chunk.substring(0, firstNewline).replace(' ===', '').trim();
          const content = chunk.substring(firstNewline + 1);
          return { path: filePath, content };
        });
      }

      if (!resolvedFiles.length) {
        res.status(400).json({ success: false, error: 'No files to commit. Provide files array or scriptId.' });
        return;
      }

      if (!repoOwner || !repoName) {
        res.status(400).json({ success: false, error: 'repoOwner and repoName are required' });
        return;
      }

      const prRequest: PRCreationRequest = {
        repoOwner,
        repoName,
        branchName: branchName || `levelup/generated-tests-${Date.now()}`,
        title: title || '🧪 LevelUp: AI-Generated Test Scripts',
        body: body || 'Generated by LevelUp AI QA Agent',
        files: resolvedFiles,
        baseBranch,
      };

      logger.info(MOD, 'Creating PR', {
        repo: `${repoOwner}/${repoName}`,
        branch: prRequest.branchName,
        fileCount: resolvedFiles.length,
      });

      const result = await github.createPullRequest(prRequest, companyId);

      if (!result.success) {
        res.status(400).json({ success: false, error: result.error });
        return;
      }

      res.json({ success: true, data: result });
    } catch (err: any) {
      logger.error(MOD, 'POST /create-pr error', { error: err.message });
      res.status(500).json({ success: false, error: 'Failed to create pull request' });
    }
  });

  return router;
}
