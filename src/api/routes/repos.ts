/**
 * Repository management endpoints
 *
 * Dual-mode: Uses database-backed repositories (projects → repositories table)
 * when company context is available. Falls back to flat-file RepoManager for
 * legacy CLI / webhook / healing-job use cases.
 *
 * Query params:
 *   ?project_id=N — filter by project (uses DB)
 *   (no project_id) — returns all repos for the company (uses DB if companyId present)
 */

import { Router, type Request, type Response } from 'express';
import { RepoManager } from '../services/repo-manager';
import {
  listRepositories,
  listAllRepositories,
  addRepository,
  getRepository,
  updateRepository,
  deleteRepository,
} from '../../db/postgres';
import { logger } from '../../utils/logger';

const MOD = 'repos-routes';

export function createReposRouter(repoManager: RepoManager): Router {
  const router = Router();

  /**
   * GET /api/repos — list repositories
   *
   * If companyId is present (authenticated dashboard request):
   *   - With ?project_id=N → only repos for that project
   *   - Without project_id → all repos for the company
   * Otherwise: falls back to RepoManager (flat-file)
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const projectIdRaw = req.query.project_id || req.headers['x-project-id'];
      const projectId = projectIdRaw ? parseInt(String(projectIdRaw), 10) : undefined;

      if (companyId) {
        // Database-backed mode
        let repos: any[];
        if (projectId && !isNaN(projectId)) {
          repos = await listRepositories(projectId, companyId);
        } else {
          repos = await listAllRepositories(companyId);
        }
        return res.json({ repositories: repos });
      }

      // Legacy fallback — flat-file RepoManager (CLI / webhook mode)
      const repositories = repoManager.listRepos();
      return res.json({ repositories });
    } catch (err: any) {
      logger.error(MOD, 'Failed to list repos', { error: err.message });
      return res.status(500).json({ error: 'Failed to list repositories' });
    }
  });

  // GET /api/repos/:id — get single repo
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const id = req.params['id'] as string;

      if (companyId) {
        const numericId = parseInt(id, 10);
        if (!isNaN(numericId)) {
          const repo = await getRepository(numericId, companyId);
          if (!repo) return res.status(404).json({ error: 'Repository not found' });
          return res.json(repo);
        }
      }

      // Legacy fallback
      const repo = repoManager.getRepo(id);
      if (!repo) {
        return res.status(404).json({ error: 'Not Found', message: `Repository not found: ${id}` });
      }
      return res.json(repo);
    } catch (err: any) {
      logger.error(MOD, 'Failed to get repo', { error: err.message });
      return res.status(500).json({ error: 'Failed to get repository' });
    }
  });

  // POST /api/repos — add new repository
  router.post('/', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const projectIdRaw = req.body.project_id || req.query.project_id || req.headers['x-project-id'];
      const projectId = projectIdRaw ? parseInt(String(projectIdRaw), 10) : undefined;

      const { name, url, branch, localPath, type } = req.body;

      if (!name || !url) {
        return res.status(400).json({ error: 'Missing required fields: name, url' });
      }

      if (companyId && projectId) {
        const repo = await addRepository({
          project_id: projectId,
          company_id: companyId,
          name,
          url,
          branch: branch || 'main',
          type: type || 'web',
        });
        return res.status(201).json({ repository: repo });
      }

      // Legacy fallback
      const repo = repoManager.addRepo({
        name, url, branch: branch ?? 'main', localPath, enabled: true,
      });
      return res.status(201).json({ id: repo.id, message: 'Repository added', repository: repo });
    } catch (err: any) {
      logger.error(MOD, 'Failed to add repo', { error: err.message });
      return res.status(500).json({ error: 'Failed to add repository' });
    }
  });

  // PUT /api/repos/:id — update repository
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const id = req.params['id'] as string;

      if (companyId) {
        const numericId = parseInt(id, 10);
        if (!isNaN(numericId)) {
          const updated = await updateRepository(numericId, companyId, req.body);
          if (!updated) return res.status(404).json({ error: 'Repository not found' });
          return res.json({ repository: updated });
        }
      }

      // Legacy fallback
      const updated = repoManager.updateRepo(id, req.body);
      if (!updated) {
        return res.status(404).json({ error: 'Not Found', message: `Repository not found: ${id}` });
      }
      return res.json({ message: 'Repository updated', repository: updated });
    } catch (err: any) {
      logger.error(MOD, 'Failed to update repo', { error: err.message });
      return res.status(500).json({ error: 'Failed to update repository' });
    }
  });

  // DELETE /api/repos/:id — remove repository
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const id = req.params['id'] as string;

      if (companyId) {
        const numericId = parseInt(id, 10);
        if (!isNaN(numericId)) {
          const deleted = await deleteRepository(numericId, companyId);
          if (!deleted) return res.status(404).json({ error: 'Repository not found' });
          return res.json({ deleted: true, id: numericId });
        }
      }

      // Legacy fallback
      const removed = repoManager.removeRepo(id);
      if (!removed) {
        return res.status(404).json({ error: 'Not Found', message: `Repository not found: ${id}` });
      }
      return res.json({ message: 'Repository removed' });
    } catch (err: any) {
      logger.error(MOD, 'Failed to delete repo', { error: err.message });
      return res.status(500).json({ error: 'Failed to delete repository' });
    }
  });

  return router;
}
