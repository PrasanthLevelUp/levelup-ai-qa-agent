/**
 * Healing Verification Service — Sprint B Phase 1 (Runner Integration).
 *
 * This is the piece that makes the self-healing learning loop run AUTOMATICALLY,
 * with zero manual intervention:
 *
 *   Heal Applied → Rerun Test → Capture Result → Record Outcome → Learning Happens
 *
 * The `HealingOutcomeService` (Sprint B core) already knows how to record an
 * outcome and update a per-element confidence score. What was missing was the
 * plumbing that connects an *applied* heal to the *result of rerunning the test*
 * and then hands that to the outcome service. This service is that plumbing, and
 * it supports the two distinct ways a heal gets verified in this codebase:
 *
 *   1) SYNCHRONOUS (in-process) — the iterative healing worker in
 *      `src/api/server.ts` applies a fix and reruns the test inline via
 *      `ExecutionEngine.run(...)`. The rerun result is therefore already known
 *      in-process, so there is no queue or callback: the worker calls
 *      `recordOutcomeFromRerun(...)` directly at each point where it learns
 *      whether the healed selector produced a green run. This is THE change that
 *      makes learning automatic for the live healing flow.
 *
 *   2) ASYNCHRONOUS (external / CI) — a heal committed to a GitHub PR (see
 *      `src/api/routes/healing-pr.ts`) is verified later, out of process, when
 *      CI reruns the test and reports back. For that flow we persist a
 *      `healing_verification_jobs` row (`queueVerificationRun`), hand the caller
 *      a `jobId`, and fold the outcome in when the result is reported
 *      (`handleTestResult`). The job table also gives operators visibility into
 *      pending/failed verifications.
 *
 * Both paths converge on `healingOutcomeService.captureHealingOutcome(...)`, so
 * learning is identical regardless of how the rerun happened.
 *
 * DESIGN PRINCIPLES (carried from the rest of the codebase):
 *   • Every write here is BEST-EFFORT and NON-BLOCKING. Recording a verification
 *     outcome must NEVER break the heal path or the test-execution path — if the
 *     DB is down or anything throws, we log and return a benign result.
 *   • Multi-tenant isolation is non-negotiable — company + project are threaded
 *     through every job and every outcome, and job reads can be scoped.
 *   • The engine assigns confidence on a 0–1 scale; the learning loop stores
 *     confidence on a 0–100 scale (matching `healing_confidence_scores`). We
 *     normalise once, here, in `normalizeConfidence`, so callers don't have to.
 */

import * as crypto from 'crypto';
import { logger } from '../utils/logger';
import {
  healingOutcomeService,
  HealingResult,
} from './healing-outcome-service';
import {
  createVerificationJob,
  getVerificationJob,
  updateVerificationJob,
  HealingVerificationJobRecord,
} from '../db/postgres';

const MOD = 'HealingVerificationService';

/* ───────────────────────── Input shapes ──────────────────────────────── */

/**
 * Everything the synchronous worker knows at the moment it learns the result of
 * rerunning a test after applying a heal. Mirrors the variables in scope at the
 * worker's result points (see `src/api/server.ts`).
 */
export interface RecordOutcomeFromRerunInput {
  companyId?: number | null;
  projectId?: number | null;
  /** Optional link back to the profile_changes diff that produced the fix. */
  profileChangeId?: number | null;
  /** Page URL the failing element lived on, when known. */
  baseUrl?: string | null;
  /** Locator family, e.g. 'css' | 'data-testid' | 'xpath'. */
  locatorType?: string | null;
  /** The broken selector that was replaced. */
  originalSelector?: string | null;
  /** The new selector the engine suggested and the worker applied. */
  healedSelector?: string | null;
  /** Healing strategy that produced the fix. */
  strategy?: string | null;
  /**
   * Confidence the engine assigned to the suggestion. Accepts the engine's
   * native 0–1 scale OR an already-0–100 value — normalised internally.
   */
  suggestedConfidence?: number | null;
  /** Either an explicit result, or a process exit code to map. */
  result?: HealingResult | string;
  exitCode?: number;
  testName?: string | null;
  errorMessage?: string | null;
  durationMs?: number | null;
}

/** Config for queueing an asynchronous (external/CI) verification run. */
export interface QueueVerificationConfig {
  companyId?: number | null;
  projectId?: number | null;
  testId?: number | null;
  testName?: string | null;
  /** Correlates a verification job with the healing session that created it. */
  healingSessionId?: string | null;
  baseUrl?: string | null;
  elementId?: string | null;
  locatorType?: string | null;
  originalSelector?: string | null;
  healedSelector?: string | null;
  strategy?: string | null;
  /** Engine confidence (0–1 or 0–100) — normalised before persisting. */
  suggestedConfidence?: number | null;
  profileChangeId?: number | null;
}

/** Payload reported by an external runner when a queued verification finishes. */
export interface HandleTestResultInput {
  jobId: string;
  /** Either an explicit result, or a process exit code to map. */
  result?: HealingResult | string;
  exitCode?: number;
  executionTimeMs?: number | null;
  errorMessage?: string | null;
}

export class HealingVerificationService {
  /* ── Pure helpers (no DB — unit-testable in isolation) ──────────────── */

  /**
   * Map a test-process exit code to a healing result. A zero exit code means
   * the rerun went green (the heal worked); anything else (including signals
   * like 137/SIGKILL) means it did not.
   */
  static mapExitCodeToResult(exitCode: number): HealingResult {
    return exitCode === 0 ? 'pass' : 'fail';
  }

  /**
   * Normalise a confidence value to the 0–100 scale used by the learning loop.
   * The engine emits 0–1 (e.g. 0.85); the confidence-score table stores 0–100.
   * Values in (0,1] are treated as a fraction and scaled up; values already
   * above 1 are assumed to be 0–100 and passed through (clamped to 100).
   */
  static normalizeConfidence(confidence: number | null | undefined): number | null {
    if (confidence == null || Number.isNaN(confidence)) return null;
    if (confidence < 0) return 0;
    const scaled = confidence <= 1 ? confidence * 100 : confidence;
    return Math.min(100, scaled);
  }

  /** Generate a unique, prefixed verification job id. */
  static genJobId(): string {
    return `hv_${crypto.randomUUID()}`;
  }

  /**
   * Resolve a result from either an explicit result string or an exit code.
   * Prefers an explicit result when provided; otherwise maps the exit code;
   * defaults to 'error' when neither is usable (so an unknown state pulls
   * confidence down rather than silently being treated as a pass).
   */
  private resolveResult(
    result?: HealingResult | string,
    exitCode?: number,
  ): HealingResult | string {
    if (result) return result;
    if (typeof exitCode === 'number') return HealingVerificationService.mapExitCodeToResult(exitCode);
    return 'error';
  }

  /* ── Synchronous path (in-process worker) ───────────────────────────── */

  /**
   * Record the outcome of an applied heal whose rerun has ALREADY happened
   * in-process. This is called directly by the iterative healing worker in
   * `src/api/server.ts` at each point where it learns whether the healed
   * selector produced a green run.
   *
   * Best-effort and non-blocking: never throws, so a learning hiccup can never
   * break the live healing flow. Returns the captured outcome id (or null).
   */
  async recordOutcomeFromRerun(
    input: RecordOutcomeFromRerunInput,
  ): Promise<{ outcomeId: number | null; result: HealingResult | string }> {
    const result = this.resolveResult(input.result, input.exitCode);
    try {
      const capture = await healingOutcomeService.captureHealingOutcome({
        companyId: input.companyId,
        projectId: input.projectId,
        profileChangeId: input.profileChangeId,
        baseUrl: input.baseUrl,
        locatorType: input.locatorType,
        originalSelector: input.originalSelector,
        healedSelector: input.healedSelector,
        strategy: input.strategy,
        suggestedConfidence: HealingVerificationService.normalizeConfidence(input.suggestedConfidence),
        result,
        testName: input.testName,
        errorMessage: input.errorMessage,
        durationMs: input.durationMs,
      });
      logger.info(MOD, 'Recorded healing outcome from in-process rerun', {
        result,
        outcomeId: capture.outcomeId,
        elementId: capture.elementId,
        previousConfidence: capture.previousConfidence,
        newConfidence: capture.newConfidence,
      });
      return { outcomeId: capture.outcomeId, result };
    } catch (err: any) {
      // Must never break the heal/test path — log and move on.
      logger.warn(MOD, `recordOutcomeFromRerun failed (non-blocking): ${err?.message || err}`);
      return { outcomeId: null, result };
    }
  }

  /* ── Asynchronous path (external / CI verification) ──────────────────── */

  /**
   * Queue an asynchronous verification run for a heal that will be rerun out of
   * process (e.g. a fix committed to a GitHub PR, verified later by CI). Persists
   * a `healing_verification_jobs` row in 'queued' state and returns its public
   * job id, which the external runner echoes back via `handleTestResult`.
   *
   * Best-effort: if persistence fails we still return a generated job id so the
   * caller's flow is never blocked (the outcome simply won't be tracked).
   */
  async queueVerificationRun(config: QueueVerificationConfig): Promise<{ jobId: string; persisted: boolean }> {
    const jobId = HealingVerificationService.genJobId();
    try {
      await createVerificationJob({
        jobId,
        companyId: config.companyId,
        projectId: config.projectId,
        testId: config.testId,
        testName: config.testName,
        healingSessionId: config.healingSessionId,
        baseUrl: config.baseUrl,
        elementId: config.elementId,
        locatorType: config.locatorType,
        originalSelector: config.originalSelector,
        healedSelector: config.healedSelector,
        strategy: config.strategy,
        suggestedConfidence: HealingVerificationService.normalizeConfidence(config.suggestedConfidence),
        profileChangeId: config.profileChangeId,
      });
      logger.info(MOD, 'Queued healing verification job', { jobId, testName: config.testName });
      return { jobId, persisted: true };
    } catch (err: any) {
      logger.warn(MOD, `queueVerificationRun failed (non-blocking): ${err?.message || err}`);
      return { jobId, persisted: false };
    }
  }

  /**
   * Fold in the result reported by an external runner for a queued job. Looks up
   * the job, marks it 'running', captures the healing outcome using the job's
   * persisted heal details, then transitions the job to 'completed' (or 'failed'
   * if the job can't be found / capture errors). Best-effort and non-blocking.
   */
  async handleTestResult(
    input: HandleTestResultInput,
  ): Promise<{ ok: boolean; outcomeId: number | null; status: string }> {
    const result = this.resolveResult(input.result, input.exitCode);
    try {
      const job = await getVerificationJob(input.jobId);
      if (!job) {
        logger.warn(MOD, `handleTestResult: no verification job for ${input.jobId}`);
        return { ok: false, outcomeId: null, status: 'not_found' };
      }

      await updateVerificationJob(input.jobId, { status: 'running' });

      const capture = await healingOutcomeService.captureHealingOutcome({
        companyId: job.company_id,
        projectId: job.project_id,
        profileChangeId: job.profile_change_id,
        baseUrl: job.base_url,
        elementId: job.element_id,
        locatorType: job.locator_type,
        originalSelector: job.original_selector,
        healedSelector: job.healed_selector,
        strategy: job.strategy,
        suggestedConfidence: job.suggested_confidence == null ? null : Number(job.suggested_confidence),
        result,
        testName: job.test_name,
        errorMessage: input.errorMessage,
        durationMs: input.executionTimeMs,
      });

      await updateVerificationJob(input.jobId, {
        status: 'completed',
        result: String(result),
        durationMs: input.executionTimeMs,
        outcomeId: capture.outcomeId,
        errorMessage: input.errorMessage,
      });

      logger.info(MOD, 'Completed healing verification job', {
        jobId: input.jobId,
        result,
        outcomeId: capture.outcomeId,
      });
      return { ok: true, outcomeId: capture.outcomeId, status: 'completed' };
    } catch (err: any) {
      logger.warn(MOD, `handleTestResult failed (non-blocking): ${err?.message || err}`);
      // Try to flag the job as failed so it isn't stuck 'running' forever.
      try {
        await updateVerificationJob(input.jobId, {
          status: 'failed',
          errorMessage: err?.message || String(err),
        });
      } catch { /* swallow — already best-effort */ }
      return { ok: false, outcomeId: null, status: 'failed' };
    }
  }

  /** Fetch a verification job by its public job id, optionally tenant-scoped. */
  async getJob(
    jobId: string,
    companyId?: number | null,
    projectId?: number | null,
  ): Promise<HealingVerificationJobRecord | null> {
    try {
      return await getVerificationJob(jobId, companyId, projectId);
    } catch (err: any) {
      logger.warn(MOD, `getJob failed: ${err?.message || err}`);
      return null;
    }
  }
}

/** Process-wide singleton (mirrors `healingOutcomeService`). */
export const healingVerificationService = new HealingVerificationService();
