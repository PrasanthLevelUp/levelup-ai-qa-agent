/**
 * Job Queue System — in-memory queue backed by SQLite for persistence.
 */

import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../../db/sqlite';
import { logger } from '../../utils/logger';

const MOD = 'job-queue';

export enum JobStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

export interface HealingJob {
  id: string;
  repositoryId: string;
  repositoryUrl?: string;
  branch: string;
  commit?: string;
  status: JobStatus;
  progress: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: any;
  error?: string;
}

// In-memory store for active jobs
const jobs = new Map<string, HealingJob>();

function initJobsTable(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS healing_jobs (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      repository_url TEXT,
      branch TEXT DEFAULT 'main',
      commit_sha TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      progress TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      completed_at TEXT,
      result TEXT,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON healing_jobs(status);
  `);
}

export class JobQueue {
  private processing = false;
  private readonly workers: Array<(job: HealingJob) => Promise<any>>;
  private readonly maxConcurrent: number;
  private activeCount = 0;

  constructor(maxConcurrent = 1) {
    this.maxConcurrent = maxConcurrent;
    this.workers = [];
    initJobsTable();
    this.loadPersistedJobs();
  }

  /**
   * Register a worker function to process jobs.
   */
  onJob(handler: (job: HealingJob) => Promise<any>): void {
    this.workers.push(handler);
  }

  /**
   * Create a new healing job and add to queue.
   */
  createJob(repositoryId: string, branch = 'main', commit?: string, repositoryUrl?: string): HealingJob {
    const job: HealingJob = {
      id: `job_${uuidv4().slice(0, 12)}`,
      repositoryId,
      repositoryUrl,
      branch,
      commit,
      status: JobStatus.PENDING,
      progress: 'Queued for processing',
      createdAt: new Date().toISOString(),
    };

    jobs.set(job.id, job);
    this.persistJob(job);

    logger.info(MOD, 'Job created', { jobId: job.id, repositoryId, branch });

    // Start processing queue
    this.processQueue();

    return job;
  }

  /**
   * Get job by ID.
   */
  getJob(jobId: string): HealingJob | null {
    return jobs.get(jobId) ?? this.loadJobFromDb(jobId);
  }

  /**
   * List all jobs, optionally filtered by status.
   */
  listJobs(status?: JobStatus): HealingJob[] {
    const allJobs = Array.from(jobs.values());
    if (status) {
      return allJobs.filter((j) => j.status === status);
    }
    return allJobs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  /**
   * Update job status and progress.
   */
  updateJob(jobId: string, updates: Partial<HealingJob>): void {
    const job = jobs.get(jobId);
    if (!job) return;

    Object.assign(job, updates);
    this.persistJob(job);
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.activeCount >= this.maxConcurrent) return;
    this.processing = true;

    try {
      const pendingJobs = this.listJobs(JobStatus.PENDING);

      for (const job of pendingJobs) {
        if (this.activeCount >= this.maxConcurrent) break;

        this.activeCount++;
        job.status = JobStatus.RUNNING;
        job.startedAt = new Date().toISOString();
        job.progress = 'Starting healing process...';
        this.persistJob(job);

        // Process job asynchronously
        this.executeJob(job).finally(() => {
          this.activeCount--;
          this.processQueue(); // Process next in queue
        });
      }
    } finally {
      this.processing = false;
    }
  }

  private async executeJob(job: HealingJob): Promise<void> {
    try {
      for (const worker of this.workers) {
        const result = await worker(job);
        job.result = result;
      }

      job.status = JobStatus.COMPLETED;
      job.completedAt = new Date().toISOString();
      job.progress = 'Healing complete';

      logger.info(MOD, 'Job completed', { jobId: job.id });
    } catch (error) {
      job.status = JobStatus.FAILED;
      job.completedAt = new Date().toISOString();
      job.error = (error as Error).message;
      job.progress = `Failed: ${(error as Error).message}`;

      logger.error(MOD, 'Job failed', {
        jobId: job.id,
        error: (error as Error).message,
      });
    }

    this.persistJob(job);
  }

  private persistJob(job: HealingJob): void {
    try {
      getDb().prepare(`
        INSERT OR REPLACE INTO healing_jobs
          (id, repository_id, repository_url, branch, commit_sha, status, progress,
           created_at, started_at, completed_at, result, error)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        job.id,
        job.repositoryId,
        job.repositoryUrl ?? null,
        job.branch,
        job.commit ?? null,
        job.status,
        job.progress,
        job.createdAt,
        job.startedAt ?? null,
        job.completedAt ?? null,
        job.result ? JSON.stringify(job.result) : null,
        job.error ?? null,
      );
    } catch (error) {
      logger.error(MOD, 'Failed to persist job', { jobId: job.id, error: (error as Error).message });
    }
  }

  private loadJobFromDb(jobId: string): HealingJob | null {
    try {
      const row = getDb().prepare('SELECT * FROM healing_jobs WHERE id = ?').get(jobId) as any;
      if (!row) return null;

      const job: HealingJob = {
        id: row.id,
        repositoryId: row.repository_id,
        repositoryUrl: row.repository_url,
        branch: row.branch,
        commit: row.commit_sha,
        status: row.status,
        progress: row.progress,
        createdAt: row.created_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        result: row.result ? JSON.parse(row.result) : undefined,
        error: row.error,
      };

      jobs.set(job.id, job);
      return job;
    } catch {
      return null;
    }
  }

  private loadPersistedJobs(): void {
    try {
      const rows = getDb().prepare(
        'SELECT * FROM healing_jobs WHERE status IN (?, ?) ORDER BY created_at DESC LIMIT 50',
      ).all(JobStatus.PENDING, JobStatus.RUNNING) as any[];

      for (const row of rows) {
        const job: HealingJob = {
          id: row.id,
          repositoryId: row.repository_id,
          repositoryUrl: row.repository_url,
          branch: row.branch,
          commit: row.commit_sha,
          status: row.status === JobStatus.RUNNING ? JobStatus.PENDING : row.status,
          progress: row.progress,
          createdAt: row.created_at,
          startedAt: row.started_at,
          completedAt: row.completed_at,
          result: row.result ? JSON.parse(row.result) : undefined,
          error: row.error,
        };
        jobs.set(job.id, job);
      }

      logger.info(MOD, 'Loaded persisted jobs', { count: rows.length });
    } catch {
      logger.warn(MOD, 'No persisted jobs to load');
    }
  }
}
