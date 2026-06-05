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
import { parseScriptContent } from '../../services/script-file-parser';
import { logger } from '../../utils/logger';

/**
 * Validate a repo-relative file path before sending it to the GitHub service.
 * Mirrors the GitHubService sanitization rules (no traversal, no absolute
 * paths) and additionally rejects any residual delimiter artifacts (e.g. a
 * leading `//` or trailing ` ===`) that would otherwise be silently pushed.
 */
function isValidRepoPath(p: string): boolean {
  if (!p || !p.trim()) return false;
  const path = p.trim();
  if (path.includes('..') || path.startsWith('/')) return false;
  // Reject leftover comment/delimiter artifacts from malformed parsing.
  if (path.startsWith('//') || path.includes('===')) return false;
  return true;
}

const MOD = 'github-routes';

export function createGitHubRouter(): Router {
  const router = Router();
  const github = new GitHubService();

  /* ── Connection Status ───────────────────────────────── */
  router.get('/status', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const userId = (req as any).userId as number | undefined;
      const status = await github.getConnectionStatus(companyId, userId);
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
      const userId = (req as any).userId as number | undefined;
      const page = parseInt(req.query.page as string) || 1;
      const perPage = parseInt(req.query.per_page as string) || 30;
      const sort = String(req.query.sort || 'pushed');

      const result = await github.listRepos(companyId, { page, perPage, sort }, userId);

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
      const userId = (req as any).userId as number | undefined;
      const owner = String(req.params.owner);
      const repo = String(req.params.repo);

      if (!owner || !repo) {
        res.status(400).json({ success: false, error: 'owner and repo are required' });
        return;
      }

      const result = await github.listBranches(owner, repo, companyId, userId);

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
      const userId = (req as any).userId as number | undefined;
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

        // Reconstruct files from stored content using the shared parser. This
        // correctly strips `// === <path> ===` delimiters (including the first
        // header which has no leading newline) instead of the previous manual
        // string splitting that left a `// ` prefix and trailing ` ===` in the
        // path (root cause of the "Invalid file path" error).
        const parsed = parseScriptContent(
          script.script_content as string,
          script.files_generated,
        );
        resolvedFiles = parsed.map((f) => ({ path: f.path, content: f.content }));
      }

      if (!resolvedFiles.length) {
        res.status(400).json({ success: false, error: 'No files to commit. Provide files array or scriptId.' });
        return;
      }

      if (!repoOwner || !repoName) {
        res.status(400).json({ success: false, error: 'repoOwner and repoName are required' });
        return;
      }

      // Final guard: reject any malformed path (covers both the scriptId and the
      // directly-provided `files` paths) before reaching the GitHub service.
      const invalidPaths = resolvedFiles.filter((f) => !isValidRepoPath(f.path));
      if (invalidPaths.length > 0) {
        res.status(400).json({
          success: false,
          error: `Cannot create PR — invalid file path(s): ${invalidPaths.map((f) => f.path).join(', ')}`,
        });
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

      const result = await github.createPullRequest(prRequest, companyId, userId);

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
