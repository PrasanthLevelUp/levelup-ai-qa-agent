/**
 * POST /api/heal — Queue a healing job
 */

import { Router, type Request, type Response } from 'express';
import { JobQueue } from '../queue/job-queue';
import { RepoManager } from '../services/repo-manager';
import { listAllRepositories, type ExecutionProfile } from '../../db/postgres';
import { logger } from '../../utils/logger';

const MOD = 'heal-route';
const router = Router();

const VALID_PROFILES: ReadonlyArray<ExecutionProfile> = ['fast', 'standard', 'healing', 'debug'];

/** Validate a client-supplied execution profile; returns undefined if absent/invalid. */
function parseRequestedProfile(value: unknown): ExecutionProfile | undefined {
  return typeof value === 'string' && (VALID_PROFILES as readonly string[]).includes(value)
    ? (value as ExecutionProfile)
    : undefined;
}

/** Normalize a git URL for comparison: drop protocol, trailing .git, lowercase. */
function normalizeRepoUrl(url: string): string {
  return url.trim().replace(/^https?:\/\//, '').replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();
}

export function createHealRouter(jobQueue: JobQueue, repoManager: RepoManager): Router {
  router.post('/', async (req: Request, res: Response) => {
    const { repository, branch, commit, projectId, testFile, profile, collectHealingArtifacts } = req.body as {
      repository?: string;
      branch?: string;
      commit?: string;
      projectId?: number;
      testFile?: string;
      /** Per-request execution profile override (CI smoke → 'fast', investigation → 'debug', ...). */
      profile?: string;
      /** Per-request override for collecting extra healing artifacts (trace/video/HAR). */
      collectHealingArtifacts?: boolean;
    };

    // Per-request overrides — win over the project-level ExecutionSettings default.
    const requestedProfile = parseRequestedProfile(profile);
    const requestedCollectHealingArtifacts =
      typeof collectHealingArtifacts === 'boolean' ? collectHealingArtifacts : undefined;

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
    const pid = typeof projectId === 'number' ? projectId : (req as any).projectId;

    // SECURITY: For company-scoped requests, the repo being healed MUST be one of
    // that company's configured repositories. This prevents healing an arbitrary or
    // another tenant's repo URL (cross-tenant contamination). We also resolve the
    // CANONICAL url/branch from the DB record so the job never trusts a client-supplied
    // URL that doesn't belong to the tenant.
    if (cid && repoUrl) {
      try {
        const companyRepos = await listAllRepositories(cid);
        const target = normalizeRepoUrl(repoUrl);
        const match = companyRepos.find((r: any) => r.url && normalizeRepoUrl(r.url) === target);
        if (!match) {
          logger.warn(MOD, 'Rejected heal: repo not configured for company', {
            companyId: cid, requestedUrl: repoUrl,
            configuredUrls: companyRepos.map((r: any) => r.url),
          });
          res.status(403).json({
            error: 'Forbidden',
            message: `Repository "${repoUrl}" is not configured for your account. Add it under Configured Repositories before healing.`,
          });
          return;
        }
        // Use the DB record as the source of truth for url/branch/project scoping.
        repoUrl = match.url;
        if (match.id != null) repoId = String(match.id);
      } catch (err: any) {
        logger.error(MOD, 'Failed to validate repo ownership', { error: err?.message, companyId: cid });
        res.status(500).json({ error: 'Internal Error', message: 'Failed to validate repository ownership' });
        return;
      }
    }

    const job = jobQueue.createJob(
      repoId, branch ?? 'main', commit, repoUrl, cid, pid, testFile,
      requestedProfile, requestedCollectHealingArtifacts,
    );

    res.status(202).json({
      jobId: job.id,
      status: job.status,
      message: 'Healing job queued',
      createdAt: job.createdAt,
    });
  });

  return router;
}
