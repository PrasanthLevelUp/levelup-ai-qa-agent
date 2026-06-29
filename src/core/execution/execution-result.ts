/**
 * ExecutionResult — the CANONICAL, source-agnostic product of running the test
 * suite ONCE. This is the single hand-off contract from an ExecutionProvider into
 * the healing pipeline.
 *
 * ── The inverted architecture this enables ─────────────────────────────────
 *
 *   ExecutionProvider  (owns the WHOLE execution lifecycle)
 *        │  clone → execute → download artifacts → parse artifacts
 *        │  → build ExecutionRecords → assemble ExecutionResult
 *        ▼
 *   ExecutionResult { records, artifacts, repoPath, exitCode, resultsFile,
 *                     metadata, providerInfo }
 *        ▼
 *   Healing pipeline  →  Diagnosis → Healing → Validation → Learning
 *
 * The worker no longer knows (or cares) WHERE a test ran. The execution source
 * disappears from the worker entirely: it receives a fully-formed
 * `ExecutionResult` and feeds it through the source-agnostic healing pipeline.
 * A provider materializes EVERYTHING — including the finalized pass/skip
 * ExecutionRecords (pure execution facts). The per-failure healing records remain
 * the healing pipeline's concern; the provider only owns the execution facts.
 *
 * ── Hybrid validation (unchanged) ──────────────────────────────────────────
 * `execute()` may run remotely (e.g. GitHub Actions) so diagnosis is grounded in
 * the real CI failure, while `validate()` reruns locally for speed. That contract
 * is on the provider and is untouched by this container.
 */
import {
  ArtifactCollector,
  enumerateAllTests,
  type ArtifactCollection,
  type EnumeratedTest,
} from '../artifact-collector';
import { logger } from '../../utils/logger';
import { buildNonFailureRecord } from './execution-record-builders';
import type { ExecutionRecord } from './execution-record';
import type { ExecutionProfile } from './execution-profile';
import type { ExecutionSource } from './execution-provider';

const MOD = 'execution-result';

/**
 * Provider-native references to the (possibly remote) execution. Lets the
 * dashboard deep-link to a CI run and lets debugging trace where bytes came from.
 * For the Local provider only `source` is meaningful; the CI fields are absent.
 */
export interface ProviderInfo {
  /** Where the execution physically ran. */
  source: ExecutionSource;
  /** CI run id (e.g. GitHub Actions workflow-run id), when remote. */
  runId?: number | string;
  /** Human-facing URL of the run (e.g. the Actions run page), when remote. */
  runUrl?: string;
  /** Conclusion reported by the provider (e.g. success | failure | cancelled). */
  conclusion?: string | null;
  /** Local directory the provider downloaded/extracted remote artifacts into. */
  artifactDir?: string;
}

/** Timing + process-level metadata of the underlying run, best-effort. */
export interface ExecutionRunMetadata {
  /** ISO start time of the run. */
  startTime: string;
  /** ISO end time of the run. */
  endTime: string;
  /** Wall-clock duration of the run in ms. */
  durationMs: number;
  /** Process exit semantics: 0 ⇒ all tests passed. */
  exitCode: number;
  /** Captured stdout (local runs populate this; remote providers may leave blank). */
  stdout?: string;
  /** Captured stderr / surfaced ingestion warnings. */
  stderr?: string;
}

/** The lifecycle stage a provider was in when a setup-level failure occurred. */
export type ExecutionSetupStage = 'clone' | 'install' | 'dispatch' | 'execute' | 'ingest';

/**
 * A setup-level failure raised by a provider BEFORE a usable run was produced
 * (clone/install/dispatch/etc.). Carries the stage + an exitCode the worker can
 * surface directly, so the worker can convert it into the SAME actionable job
 * result it produced inline before — without knowing which provider failed.
 */
export class ExecutionSetupError extends Error {
  readonly stage: ExecutionSetupStage;
  readonly exitCode: number;
  constructor(stage: ExecutionSetupStage, exitCode: number, message: string) {
    super(message);
    this.name = 'ExecutionSetupError';
    this.stage = stage;
    this.exitCode = exitCode;
  }
}

/**
 * The canonical product of one suite execution. EVERYTHING the healing pipeline
 * needs is here — there is nothing left for the worker to "collect".
 */
export interface ExecutionResult {
  /**
   * Finalized ExecutionRecords for every NON-failing test (passes + skips) in the
   * run. Failing tests are intentionally absent — they become per-failure records
   * INSIDE the healing pipeline (diagnosis/healing/validation enrich them there).
   */
  records: ExecutionRecord[];
  /** Failure artifacts collected from the results file (the heal loop's input). */
  artifacts: ArtifactCollection[];
  /**
   * Absolute path to a LOCAL clone of the repo under test. Required even for
   * remote providers because diagnosis reads source and Hybrid validation reruns
   * here.
   */
  repoPath: string;
  /** Process exit semantics for the run: 0 ⇒ all tests passed. */
  exitCode: number;
  /** Absolute path to the Playwright `test-results.json` on the local disk. */
  resultsFile: string;
  /** Timing + process metadata of the run. */
  metadata: ExecutionRunMetadata;
  /** Provider-native references (source, CI run id/url, artifact dir). */
  providerInfo: ProviderInfo;
}

/**
 * Assemble a complete {@link ExecutionResult} from a finished run. This is the
 * shared tail every provider calls AFTER it has a local `resultsFile` + repo
 * clone: it parses artifacts, builds the finalized pass/skip records, and packs
 * the canonical container. Both providers funnel through here so the
 * record/artifact construction lives in exactly one place.
 *
 * Resilient by design: artifact collection and record building never throw out of
 * here — a parse hiccup degrades to empty arrays + a warning, exactly as the
 * worker's guarded collection did, so a provider never crashes a job.
 */
export function assembleExecutionResult(input: {
  resultsFile: string;
  repoPath: string;
  exitCode: number;
  jobId: string | number;
  profile: ExecutionProfile;
  metadata: ExecutionRunMetadata;
  providerInfo: ProviderInfo;
}): ExecutionResult {
  const { resultsFile, repoPath, exitCode, jobId, profile, metadata, providerInfo } = input;

  // 1. Parse failure artifacts (heal-loop input). Guarded — never throw.
  let artifacts: ArtifactCollection[] = [];
  logger.info(MOD, '▶ STAGE: ArtifactCollector.collect', {
    resultsFile,
    resultsFileExists: require('fs').existsSync(resultsFile),
    repoPath,
  });
  try {
    const startCollect = Date.now();
    artifacts = new ArtifactCollector().collect(resultsFile, repoPath);
    const durationCollect = Date.now() - startCollect;
    logger.info(MOD, '✓ STAGE: ArtifactCollector.collect COMPLETE', {
      artifactCount: artifacts.length,
      durationMs: durationCollect,
      artifacts: artifacts.map(a => ({ test_name: a.test_name, errorMessage: a.error_message?.slice(0, 100) })),
    });
  } catch (err) {
    logger.error(MOD, '✗ STAGE: ArtifactCollector.collect FAILED', {
      jobId, resultsFile,
      resultsFileExists: require('fs').existsSync(resultsFile),
      error: (err as Error).message,
      stack: (err as Error).stack,
    });
  }

  // 2. Build finalized records for every NON-failing test (passes + skips). A
  //    test is "failing" iff it produced a failure artifact; those are excluded
  //    here and recorded by the healing pipeline. Guarded — never throw.
  const records: ExecutionRecord[] = [];
  try {
    const failingNames = new Set(artifacts.map((a) => a.test_name));
    const universe: EnumeratedTest[] = enumerateAllTests(resultsFile);
    for (const t of universe) {
      if (failingNames.has(t.testName)) continue;
      records.push(buildNonFailureRecord(t, jobId, profile));
    }
  } catch (err) {
    logger.warn(MOD, 'Building non-failure records failed (continuing with none)', {
      jobId, resultsFile, error: (err as Error).message,
    });
  }

  return { records, artifacts, repoPath, exitCode, resultsFile, metadata, providerInfo };
}
