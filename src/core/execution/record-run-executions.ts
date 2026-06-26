/**
 * record-run-executions — turn a COMPLETED GitHub Actions run into canonical
 * {@link ExecutionRecord}s WITHOUT healing and WITHOUT re-running anything.
 *
 * Why this exists
 * ───────────────
 * The healing pipeline already records executions as a side-effect of healing.
 * But a customer wants EVERY CI run — pass AND fail — to show up on the
 * Execution / Healing / Jobs screens the moment it finishes, so the run is
 * visible whether or not they choose to heal it. "Heal Failures" stays an opt-in
 * action layered on top of an already-recorded run.
 *
 * What it does
 * ────────────
 *   1. Download + ingest THAT run's uploaded Playwright artifacts (no clone).
 *   2. Parse the canonical `test-results.json`:
 *        • passes / skips  → finalized non-failure records (shared builder)
 *        • failures        → finalized fail records (built here)
 *   3. Persist every record (upsert) scoped to company + project.
 *
 * Records are keyed deterministically by run id, so re-recording the same run is
 * idempotent (upserts in place — never duplicates). The records are pure
 * execution FACTS: terminal status + result, no diagnosis/healing sections. The
 * later "Heal Failures" action produces its own healed records via the pipeline.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../../utils/logger';
import type { GitHubService } from '../../integrations/github-service';
import { ingestRunArtifacts, type RemoteArtifact } from './providers/artifact-ingestion';
import { assembleExecutionResult } from './execution-result';
import { createExecutionRecord, appendEvent, type ExecutionRecord } from './execution-record';
import { slugTestName } from './execution-record-builders';
import { saveExecutionRecord } from '../../db/postgres';
import type { ExecutionProfile } from './execution-profile';

const MOD = 'record-run-executions';

/** Stable jobId that groups every test record from a single CI run. */
export function runJobId(runId: number | string): string {
  return `gha-run-${runId}`;
}

export interface RecordRunResult {
  runId: number;
  jobId: string;
  conclusion: string | null;
  runUrl: string;
  /** True when we found + parsed a Playwright results file. */
  hasResults: boolean;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  /** Execution ids persisted (for deep-linking / debugging). */
  executionIds: string[];
  /** Non-fatal ingestion warnings. */
  warnings: string[];
}

/**
 * Record a completed GitHub Actions run as execution records. Idempotent per run.
 *
 * @param github     authenticated GitHubService (carries the per-company PAT)
 * @param owner/repo target repository
 * @param runId      the EXACT workflow run to record
 * @param opts       company/project scope + capture profile
 */
export async function recordRunAsExecutions(
  github: GitHubService,
  owner: string,
  repo: string,
  runId: number,
  opts: { companyId?: number; userId?: number; projectId?: number; profile?: ExecutionProfile },
): Promise<RecordRunResult> {
  const { companyId, userId, projectId } = opts;
  const profile: ExecutionProfile = opts.profile ?? 'standard';
  const jobId = runJobId(runId);

  // ── 1. Resolve the run (conclusion + url) ────────────────────────────────
  const { run, error: runErr } = await github.getWorkflowRun(owner, repo, runId, companyId, userId);
  if (runErr || !run) {
    throw new Error(runErr || `Workflow run ${runId} could not be found.`);
  }
  const conclusion = run.conclusion;
  const runUrl = run.htmlUrl;

  // ── 2. Download + ingest the run's artifacts (no clone needed) ────────────
  const extractDir = path.join(os.tmpdir(), 'levelup-gha-record', String(runId));
  fs.mkdirSync(extractDir, { recursive: true });

  const { artifacts: listed, error: listErr } = await github.listRunArtifacts(owner, repo, runId, companyId, userId);
  if (listErr) logger.warn(MOD, 'Failed to list run artifacts', { runId, error: listErr });
  const remote: RemoteArtifact[] = (listed || []).map((a) => ({
    id: a.id, name: a.name, archiveDownloadUrl: a.archiveDownloadUrl, expired: a.expired,
  }));
  const ingested = await ingestRunArtifacts(
    remote,
    (art) => github.downloadArtifactZip(
      { id: art.id, archiveDownloadUrl: art.archiveDownloadUrl }, owner, repo, companyId, userId,
    ),
    extractDir,
  );
  for (const w of ingested.warnings) logger.warn(MOD, 'Artifact ingestion warning', { runId, warning: w });

  const hasResults = !!ingested.resultsFile && fs.existsSync(ingested.resultsFile);

  // ── 3. Assemble pass/skip records + failure artifacts from the results ────
  const records: ExecutionRecord[] = [];
  if (hasResults) {
    const now = Date.now();
    const assembled = assembleExecutionResult({
      resultsFile: ingested.resultsFile!,
      // The extract dir doubles as the "repo path" for artifact collection — we
      // do not need source here (no diagnosis), only the results parsing.
      repoPath: extractDir,
      exitCode: conclusion === 'success' ? 0 : 1,
      jobId,
      profile,
      metadata: {
        startTime: new Date(now).toISOString(),
        endTime: new Date(now).toISOString(),
        durationMs: 0,
        exitCode: conclusion === 'success' ? 0 : 1,
      },
      providerInfo: { source: 'github_actions', runId, runUrl, conclusion, artifactDir: ingested.extractDir },
    });

    // Non-failure records (passes + skips) come finalized from the shared builder.
    records.push(...assembled.records);

    // Failure records are built here: terminal completed/fail, no healing.
    for (const a of assembled.artifacts) {
      records.push(buildFailureRecord(a.test_name, a.error_message, jobId, profile, a.url));
    }
  }

  // ── 4. Persist every record (idempotent upsert by execution id) ───────────
  const executionIds: string[] = [];
  for (const rec of records) {
    try {
      await saveExecutionRecord(rec, companyId, projectId);
      executionIds.push(rec.executionId);
    } catch (err) {
      logger.warn(MOD, 'Failed to persist run execution record (non-blocking)', {
        runId, executionId: rec.executionId, error: (err as Error).message,
      });
    }
  }

  const passed = records.filter((r) => r.result === 'pass').length;
  const failed = records.filter((r) => r.result === 'fail').length;
  const skipped = records.filter((r) => r.result === 'skipped').length;

  logger.info(MOD, 'Recorded run as executions', {
    runId, jobId, conclusion, total: records.length, passed, failed, skipped, hasResults,
  });

  return {
    runId, jobId, conclusion, runUrl, hasResults,
    total: records.length, passed, failed, skipped,
    executionIds, warnings: ingested.warnings,
  };
}

/**
 * Build a finalized failure ExecutionRecord (no healing sections). Keyed by run
 * job + test name so re-recording the run upserts in place. The error message is
 * stored in the inline metadata stack trace for at-a-glance context on screens.
 */
function buildFailureRecord(
  testName: string,
  errorMessage: string,
  jobId: string,
  profile: ExecutionProfile,
  url: string | null,
): ExecutionRecord {
  const endIso = new Date().toISOString();
  const rec = createExecutionRecord({
    executionId: `${jobId}:${slugTestName(testName)}`,
    testName,
    status: 'completed',
    result: 'fail',
    stage: 'completed',
    jobId,
    durationMs: 0,
    startTime: endIso,
    endTime: endIso,
    profile,
    artifacts: {
      metadata: {
        ...(url ? { url } : {}),
        ...(errorMessage ? { stackTrace: errorMessage } : {}),
      },
    },
  });
  return appendEvent(rec, {
    type: 'execution_finalized',
    stage: 'completed',
    note: 'completed/fail',
    timestamp: endIso,
  });
}
