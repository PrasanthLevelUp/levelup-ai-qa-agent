/**
 * Execution Record builders — PURE constructors for the canonical
 * {@link ExecutionRecord}s of NON-failing tests (passes/skips) enumerated from a
 * Playwright run.
 *
 * These were historically defined inline in the API worker, but they are pure
 * execution facts (no diagnosis/healing) that belong to the execution domain.
 * Extracting them into this leaf module lets BOTH the worker AND an
 * ExecutionProvider build the same finalized records, so a provider can return a
 * complete {@link ExecutionResult} (records included) without depending on the
 * worker. This module imports only from the execution domain + artifact-collector
 * — it has no dependency on the API layer, so it can never create a cycle.
 */
import type { EnumeratedTest } from '../artifact-collector';
import { deriveResult } from './execution-lifecycle';
import {
  createExecutionRecord,
  appendEvent,
  type ExecutionRecord,
} from './execution-record';

/** URL/id-safe slug of a test name, for synthetic execution ids of non-failing tests. */
export function slugTestName(name: string): string {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'test';
}

/**
 * Synthetic, deterministic execution id for a test that did NOT go through the
 * failure pipeline (passes/skips). Keyed by job so reruns of the same job upsert
 * in place (never duplicated). Failing tests keep their numeric logExecution id.
 */
export function syntheticExecutionId(jobId: string | number, testName: string): string {
  return `${jobId}:${slugTestName(testName)}`;
}

/**
 * Build a canonical ExecutionRecord for a NON-failing test (pass/skip) enumerated
 * from the Playwright results. These tests never enter the healing pipeline, so we
 * create them already finalized: a terminal lifecycle status + result, stage
 * `completed`, no diagnosis/healing sections. The owning job carries the
 * repository metadata (we only store `jobId`).
 */
export function buildNonFailureRecord(
  test: EnumeratedTest,
  jobId: string | number,
  profile: ExecutionRecord['profile'],
): ExecutionRecord {
  const { status, result } = deriveResult(test.status);
  const endMs = Date.now();
  const durationMs = Number.isFinite(test.durationMs) ? Math.max(0, test.durationMs) : 0;
  const startIso = new Date(endMs - durationMs).toISOString();
  const endIso = new Date(endMs).toISOString();
  const rec = createExecutionRecord({
    executionId: syntheticExecutionId(jobId, test.testName),
    testName: test.testName,
    status,
    result,
    stage: 'completed',
    jobId: String(jobId),
    durationMs,
    startTime: startIso,
    endTime: endIso,
    profile,
  });
  // Pass/skip records are born already terminal — close the history with a
  // finalize event (timestamped at end) so derived views see a created→finalized
  // pair just like a healed record's history.
  return appendEvent(rec, {
    type: 'execution_finalized',
    stage: 'completed',
    note: `${status}/${result ?? 'null'}`,
    timestamp: endIso,
  });
}
