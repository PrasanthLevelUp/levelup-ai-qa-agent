/**
 * Repository management endpoints
 */

import { Router, type Request, type Response } from 'express';
import { RepoManager } from '../services/repo-manager';

const router = Router();

export function createReposRouter(repoManager: RepoManager): Router {
  // GET /api/repos — list all repos
  router.get('/', (_req: Request, res: Response) => {
    const repositories = repoManager.listRepos();
    res.json({ repositories });
  });

  // GET /api/repos/:id — get single repo
  router.get('/:id', (req: Request, res: Response) => {
    const id = req.params['id'] as string;
    const repo = repoManager.getRepo(id);
    if (!repo) {
      res.status(404).json({ error: 'Not Found', message: `Repository not found: ${id}` });
      return;
    }
    res.json(repo);
  });

  // POST /api/repos — add new repository
  router.post('/', (req: Request, res: Response) => {
    const { name, url, branch, localPath } = req.body as {
      name?: string;
      url?: string;
      branch?: string;
      localPath?: string;
    };

    if (!name || !url) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Missing required fields: name, url',
      });
      return;
    }

    const repo = repoManager.addRepo({
      name,
      url,
      branch: branch ?? 'main',
      localPath,
      enabled: true,
    });

    res.status(201).json({
      id: repo.id,
      message: 'Repository added',
      repository: repo,
    });
  });

  // PUT /api/repos/:id — update repository
  router.put('/:id', (req: Request, res: Response) => {
    const id = req.params['id'] as string;
    const updated = repoManager.updateRepo(id, req.body);
    if (!updated) {
      res.status(404).json({ error: 'Not Found', message: `Repository not found: ${id}` });
      return;
    }
    res.json({ message: 'Repository updated', repository: updated });
  });

  // DELETE /api/repos/:id — remove repository
  router.delete('/:id', (req: Request, res: Response) => {
    const id = req.params['id'] as string;
    const removed = repoManager.removeRepo(id);
    if (!removed) {
      res.status(404).json({ error: 'Not Found', message: `Repository not found: ${id}` });
      return;
    }
    res.json({ message: 'Repository removed' });
  });

  return router;
}
