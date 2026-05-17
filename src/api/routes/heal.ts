/**
 * POST /api/heal — Queue a healing job
 */

import { Router, type Request, type Response } from 'express';
import { JobQueue } from '../queue/job-queue';
import { RepoManager } from '../services/repo-manager';

const router = Router();

export function createHealRouter(jobQueue: JobQueue, repoManager: RepoManager): Router {
  router.post('/', (req: Request, res: Response) => {
    const { repository, branch, commit } = req.body as {
      repository?: string;
      branch?: string;
      commit?: string;
    };

    if (!repository) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Missing required field: repository (repo ID or URL)',
      });
      return;
    }

    // Resolve repository
    let repoId = repository;
    let repoUrl: string | undefined;

    if (repository.startsWith('http')) {
      // It's a URL — check if we have it configured
      const existing = repoManager.findRepo(repository);
      if (existing) {
        repoId = existing.id;
        repoUrl = existing.url;
      } else {
        repoId = repository;
        repoUrl = repository;
      }
    } else {
      const repo = repoManager.getRepo(repository);
      if (!repo) {
        res.status(404).json({
          error: 'Not Found',
          message: `Repository not found: ${repository}. Use GET /api/repos to list available repositories.`,
        });
        return;
      }
      repoUrl = repo.url;
    }

    const cid = (req as any).companyId;
    const job = jobQueue.createJob(repoId, branch ?? 'main', commit, repoUrl, cid);

    res.status(202).json({
      jobId: job.id,
      status: job.status,
      message: 'Healing job queued',
      createdAt: job.createdAt,
    });
  });

  return router;
}
