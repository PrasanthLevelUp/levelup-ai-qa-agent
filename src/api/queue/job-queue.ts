/**
 * Job Queue System — in-memory queue backed by PostgreSQL for persistence.
 */

import { v4 as uuidv4 } from 'uuid';
import { persistJob as dbPersistJob, loadJobFromDb as dbLoadJobFromDb, loadPersistedJobs as dbLoadPersistedJobs } from '../../db/postgres';
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

export class JobQueue {
  private processing = false;
  private readonly workers: Array<(job: HealingJob) => Promise<any>>;
  private readonly maxConcurrent: number;
  private activeCount = 0;

  constructor(maxConcurrent = 1) {
    this.maxConcurrent = maxConcurrent;
    this.workers = [];
    // Jobs table is created in initDb() via postgres.ts schema init
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
    dbPersistJob(job).catch((error) => {
      logger.error(MOD, 'Failed to persist job', { jobId: job.id, error: (error as Error).message });
    });
  }

  private loadJobFromDb(jobId: string): HealingJob | null {
    // Note: This is called synchronously but DB is async now.
    // We fire-and-forget the async load and return null for now.
    // The job will be available in-memory after the next processQueue cycle.
    dbLoadJobFromDb(jobId).then((row) => {
      if (!row) return;
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
    }).catch(() => {});
    return null;
  }

  private loadPersistedJobs(): void {
    dbLoadPersistedJobs([JobStatus.PENDING, JobStatus.RUNNING]).then((rows) => {
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
    }).catch(() => {
      logger.warn(MOD, 'No persisted jobs to load');
    });
  }
}
