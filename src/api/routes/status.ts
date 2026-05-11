/**
 * GET /api/status/:jobId — Get job status
 */

import { Router, type Request, type Response } from 'express';
import { JobQueue } from '../queue/job-queue';

const router = Router();

export function createStatusRouter(jobQueue: JobQueue): Router {
  router.get('/:jobId', (req: Request, res: Response) => {
    const jobId = req.params['jobId'] as string;
    const job = jobQueue.getJob(jobId);

    if (!job) {
      res.status(404).json({
        error: 'Not Found',
        message: `Job not found: ${jobId}`,
      });
      return;
    }

    res.json({
      jobId: job.id,
      status: job.status,
      progress: job.progress,
      repositoryId: job.repositoryId,
      branch: job.branch,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      completedAt: job.completedAt,
      error: job.error,
    });
  });

  // List all jobs
  router.get('/', (_req: Request, res: Response) => {
    const allJobs = jobQueue.listJobs();
    res.json({
      jobs: allJobs.map((j) => ({
        jobId: j.id,
        status: j.status,
        progress: j.progress,
        repositoryId: j.repositoryId,
        createdAt: j.createdAt,
        completedAt: j.completedAt,
      })),
    });
  });

  return router;
}
