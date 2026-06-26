/**
 * Execution Record — the CANONICAL record of a single test execution.
 *
 * This is the single source of truth for an execution. It is NOT just an
 * artifact container: it accumulates, across the lifecycle —
 *   1. artifacts    — files captured (screenshot/DOM/trace/video/HAR/...)
 *   2. observations — observed facts gathered before diagnosis
 *   3. diagnosis    — the classifier's verdict (what failed, why)
 *   4. healing      — the decision taken and the fix applied
 *   5. validation   — whether the fix held up on rerun
 *   6. learning     — what was written back to the system's memory
 *
 * The dashboard and analytics read ONLY this record (not separate diagnosis /
 * healing / evidence / artifact tables).
 *
 * Persistence lives in src/db/postgres.ts (save/getExecutionRecord). This
 * module owns only the business model and the immutable accumulators.
 */
import type { ExecutionProfile } from './execution-profile';

/** Current schema version of the canonical execution record (bump on breaking shape changes). */
export const EXECUTION_RECORD_SCHEMA_VERSION = 3;

// ---------------------------------------------------------------------------
// Lifecycle vocabulary — STATUS (where the record is in its lifecycle) is kept
// strictly separate from RESULT (the test outcome) and STAGE (the fine-grained
// pipeline step). A record is created at test START as RUNNING, enriched with
// stage transitions, and finalized with a terminal status + result.
// ---------------------------------------------------------------------------

/**
 * Lifecycle status — WHERE the execution record is in its own lifecycle. This is
 * NOT the test outcome (see `ExecutionResult`). A record begins life as `running`
 * (or `queued`) and ends in a terminal state.
 */
export type ExecutionLifecycleStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

/**
 * Result — the OUTCOME of the test, independent of lifecycle status. A record can
 * be `completed` (status) with a `pass`, `fail`, or `healed` result. `result` is
 * null until the execution reaches a terminal outcome.
 */
export type ExecutionResult = 'pass' | 'fail' | 'healed' | 'skipped';

/**
 * Stage — the fine-grained pipeline step the execution is currently in (or last
 * reached). Progresses monotonically from `queued` to `completed`. Job-level
 * stages (cloning/installing/building) apply to whole-suite runs; per-test
 * records typically move through executing → diagnosing → healing → validating →
 * learning → completed.
 */
export type ExecutionStage =
  | 'queued'
  | 'cloning'
  | 'installing'
  | 'building'
  | 'executing'
  | 'diagnosing'
  | 'healing'
  | 'validating'
  | 'learning'
  | 'completed';

// ---------------------------------------------------------------------------
// Artifacts — storage-agnostic descriptors (IDs, not bare paths)
// ---------------------------------------------------------------------------

/**
 * Where an artifact's bytes live. Designed for cloud storage from day one so we
 * can move local → S3 → Azure Blob → GCS → BrowserStack without changing the
 * record schema.
 */
export type ArtifactStorage = 'local' | 's3' | 'azure_blob' | 'gcs' | 'browserstack';

/** What kind of artifact this is. */
export type ArtifactType =
  | 'screenshot'
  | 'dom'
  | 'html'
  | 'trace'
  | 'video'
  | 'har'
  | 'console'
  | 'network'
  | 'performance'
  | 'other';

/**
 * A single stored artifact. We reference artifacts by `id` + `storage` rather
 * than passing a bare filesystem path around, so consumers (Replay, Timeline,
 * download endpoints) resolve bytes through a storage abstraction.
 */
export interface ArtifactDescriptor {
  /** Stable identifier for this artifact (e.g. `art_<uuid>`), used by the UI/API. */
  id: string;
  /** Artifact kind. */
  type: ArtifactType;
  /** Storage backend the bytes live in. */
  storage: ArtifactStorage;
  /** Key/path within the storage backend (S3 key, blob name, or local fs path). */
  path: string;
  /** Size in bytes, when known. */
  size?: number;
  /** MIME type, when known (e.g. `image/png`, `application/zip`). */
  contentType?: string;
  /** ISO timestamp the artifact was captured. */
  createdAt?: string;
}

/** Tier-1 inline metadata — cheap, always available, not a stored file. */
export interface ExecutionMetadata {
  url?: string;
  locator?: string;
  failedLine?: number;
  stackTrace?: string;
  browserInfo?: string;
}

/**
 * The set of artifacts attached to an execution. File-backed artifacts are
 * `ArtifactDescriptor`s; `metadata` stays inline because it is cheap structured
 * data, not a stored file. Extra/unknown files go in `others`.
 */
export interface ExecutionArtifacts {
  /** Tier 1 — always collected, inline (not a file). */
  metadata?: ExecutionMetadata;
  /** Tier 2 — on failure. */
  screenshot?: ArtifactDescriptor;
  dom?: ArtifactDescriptor;
  html?: ArtifactDescriptor;
  /** Tier 3 — on healing (when collectHealingArtifacts=true). */
  trace?: ArtifactDescriptor;
  video?: ArtifactDescriptor;
  har?: ArtifactDescriptor;
  /** Any additional captured files. */
  others?: ArtifactDescriptor[];
}

// ---------------------------------------------------------------------------
// Lifecycle sections
// ---------------------------------------------------------------------------

/**
 * Observations — the OBSERVED FACTS gathered before any diagnosis is attempted
 * (mirror of core/evidence-collector EvidenceBundle). The "what we saw" section.
 */
export interface ObservationRecord {
  locatorState?: {
    exists: boolean;
    visible: boolean;
    enabled: boolean;
    receivesPointerEvents: boolean | null;
    clickable: boolean;
    interceptedBy: string | null;
    source: 'dom_snapshot' | 'live_probe' | 'unknown';
  } | null;
  consoleErrors?: string[];
  networkErrors?: Array<{ url?: string; status?: number; detail: string }>;
  /** Compact, human-readable evidence lines. */
  summary?: string[];
}

/**
 * Diagnosis — the classifier's verdict (mirror of core FailureDiagnosis).
 * The "what failed and why" section.
 */
export interface DiagnosisRecord {
  category: string;
  confidence: number;
  recommendedStrategy: string;
  rootCause?: string;
  recommendedAction?: string;
  locator?: string | null;
  locatorResolvedFromPageObject?: boolean;
  healableByLocatorSwap?: boolean;
  evidenceBased?: boolean;
}

/**
 * Healing decisions — what the engine decided to DO about the failure and the
 * outcome of applying it. The "what we changed" section.
 */
export interface HealingDecisionRecord {
  /** Coarse remedy class chosen (locator_swap | inject_wait | report_only). */
  remedy?: string;
  /** Fine-grained strategies attempted in order. */
  attemptedStrategies?: string[];
  /** The strategy that was actually applied, if any. */
  appliedStrategy?: string | null;
  /** Which advisor/source produced the applied fix (rule | pattern | ai | wait | ...). */
  source?: string | null;
  brokenLocator?: string | null;
  newLocator?: string | null;
  candidatesConsidered?: number;
  /** True when the failure was surfaced to humans rather than auto-fixed. */
  reportOnly?: boolean;
  rationale?: string;
  /** Confidence (0..1) the engine had in the applied fix, when known. */
  confidence?: number;
  /** LLM token cost attributed to producing this healing decision, when known. */
  costTokens?: number;
  /** Monetary cost (USD) attributed to this healing decision, when known. */
  costUsd?: number;
}

/**
 * Validation — did the fix actually hold up on rerun? The "did it work" section
 * that gates whether a healing is trustworthy.
 */
export interface ValidationRecord {
  reran: boolean;
  passedAfterHealing?: boolean | null;
  confirmationRuns?: number;
  durationMs?: number;
  notes?: string[];
}

/**
 * Learning — what this execution contributed back to the system's memory.
 * The "what we remembered" section that closes the loop.
 */
export interface LearningRecord {
  recorded: boolean;
  patternId?: string | null;
  domMemoryUpdated?: boolean;
  notes?: string[];
}

// ---------------------------------------------------------------------------
// The canonical record
// ---------------------------------------------------------------------------

export interface ExecutionRecord {
  /** Schema version for forward/backward compatibility of persisted records. */
  schemaVersion: number;
  executionId: string;
  testName: string;
  /**
   * Lifecycle status — WHERE this record is in its lifecycle (running → terminal).
   * Kept strictly separate from `result` (the test outcome).
   */
  status: ExecutionLifecycleStatus;
  /**
   * Result — the test OUTCOME. Null while the execution is still in flight
   * (status `queued`/`running`); set when a terminal status is reached.
   */
  result?: ExecutionResult | null;
  /** Fine-grained pipeline stage currently reached. */
  stage?: ExecutionStage;
  /**
   * The HealingJob this execution belongs to. Repository/branch/commit metadata is
   * resolved THROUGH the job rather than duplicated onto every record.
   */
  jobId?: string | null;
  durationMs: number;
  startTime: string;
  endTime: string;
  /** Which profile was used for this execution. */
  profile: ExecutionProfile;
  /** Files + inline metadata captured for this execution. */
  artifacts: ExecutionArtifacts;

  // ---- Lifecycle sections (accumulated stage by stage) ----
  /** Observed facts gathered before diagnosis. */
  observations?: ObservationRecord;
  /** The classifier's verdict for this execution. */
  diagnosis?: DiagnosisRecord;
  /** The healing decision taken and the fix applied. */
  healing?: HealingDecisionRecord;
  /** Whether the applied fix held up on rerun. */
  validation?: ValidationRecord;
  /** What this execution contributed back to system memory. */
  learning?: LearningRecord;
}

/**
 * Back-compat alias. The record began life as an "Evidence Manifest"; existing
 * code/types may still refer to it by that name.
 * @deprecated Prefer `ExecutionRecord`.
 */
export type EvidenceManifest = ExecutionRecord;

// ---------------------------------------------------------------------------
// Construction + immutable accumulators
// ---------------------------------------------------------------------------

/**
 * Create a fresh canonical execution record. Lifecycle sections start empty and
 * are filled in by the `record*()` accumulators as the execution progresses.
 */
export function createExecutionRecord(init: {
  executionId: string;
  testName: string;
  /** Lifecycle status; defaults to `running` (a record is born at test start). */
  status?: ExecutionLifecycleStatus;
  /** Test outcome; null/undefined while still in flight. */
  result?: ExecutionResult | null;
  /** Pipeline stage; defaults to `executing`. */
  stage?: ExecutionStage;
  /** Owning HealingJob id (repository metadata resolved through the job). */
  jobId?: string | null;
  durationMs: number;
  startTime: string;
  endTime: string;
  profile: ExecutionProfile;
  artifacts?: ExecutionArtifacts;
}): ExecutionRecord {
  return {
    schemaVersion: EXECUTION_RECORD_SCHEMA_VERSION,
    executionId: init.executionId,
    testName: init.testName,
    status: init.status ?? 'running',
    result: init.result ?? null,
    stage: init.stage ?? 'executing',
    jobId: init.jobId ?? null,
    durationMs: init.durationMs,
    startTime: init.startTime,
    endTime: init.endTime,
    profile: init.profile,
    artifacts: init.artifacts ?? {},
  };
}

/**
 * Accumulators take Partial section data because a record is built up across the
 * lifecycle — a later stage may set only the fields it just learned. Each returns
 * a NEW record (immutable merge) so callers thread the record through stages.
 */

/** Attach/merge artifacts onto the record (immutable merge). */
export function recordArtifacts(rec: ExecutionRecord, artifacts: Partial<ExecutionArtifacts>): ExecutionRecord {
  return { ...rec, artifacts: { ...(rec.artifacts ?? {}), ...artifacts } };
}

/** Accumulate observed facts onto the record (immutable merge). */
export function recordObservations(rec: ExecutionRecord, observations: Partial<ObservationRecord>): ExecutionRecord {
  return { ...rec, observations: { ...(rec.observations ?? {}), ...observations } };
}

/** Accumulate the diagnosis verdict onto the record (immutable merge). */
export function recordDiagnosis(rec: ExecutionRecord, diagnosis: Partial<DiagnosisRecord>): ExecutionRecord {
  return { ...rec, diagnosis: { ...(rec.diagnosis ?? {} as DiagnosisRecord), ...diagnosis } };
}

/** Accumulate the healing decision/outcome onto the record (immutable merge). */
export function recordHealingDecision(rec: ExecutionRecord, healing: Partial<HealingDecisionRecord>): ExecutionRecord {
  return { ...rec, healing: { ...(rec.healing ?? {}), ...healing } };
}

/** Accumulate the validation outcome onto the record (immutable merge). */
export function recordValidation(rec: ExecutionRecord, validation: Partial<ValidationRecord>): ExecutionRecord {
  return { ...rec, validation: { ...(rec.validation ?? { reran: false }), ...validation } };
}

/** Accumulate the learning contribution onto the record (immutable merge). */
export function recordLearning(rec: ExecutionRecord, learning: Partial<LearningRecord>): ExecutionRecord {
  return { ...rec, learning: { ...(rec.learning ?? { recorded: false }), ...learning } };
}

// ---------------------------------------------------------------------------
// Lifecycle accumulators — move the record forward through its lifecycle.
// ---------------------------------------------------------------------------

/** Advance the record to a new pipeline stage (immutable). */
export function setStage(rec: ExecutionRecord, stage: ExecutionStage): ExecutionRecord {
  return { ...rec, stage };
}

/**
 * Set the lifecycle status and/or terminal result (immutable). Used to finalize a
 * record (e.g. `{ status: 'completed', result: 'healed' }`) without touching the
 * accumulated lifecycle sections.
 */
export function setLifecycle(
  rec: ExecutionRecord,
  next: { status?: ExecutionLifecycleStatus; result?: ExecutionResult | null; stage?: ExecutionStage },
): ExecutionRecord {
  return {
    ...rec,
    status: next.status ?? rec.status,
    result: next.result !== undefined ? next.result : rec.result,
    stage: next.stage ?? rec.stage,
  };
}

// ---------------------------------------------------------------------------
// Back-compat coercion — v2 records persisted `status` as the OUTCOME
// ('passed'|'failed'|'timedout'|'skipped') with no `result`/`stage`/`jobId`.
// On read, normalize them into the v3 split so downstream consumers (timeline,
// dashboard) can rely on `status` (lifecycle) + `result` (outcome) uniformly.
// ---------------------------------------------------------------------------

/** Legacy v2 outcome values that used to live in `status`. */
type LegacyStatus = 'passed' | 'failed' | 'timedout' | 'skipped';

const LEGACY_STATUS_MAP: Record<LegacyStatus, { status: ExecutionLifecycleStatus; result: ExecutionResult }> = {
  passed: { status: 'completed', result: 'pass' },
  failed: { status: 'completed', result: 'fail' },
  timedout: { status: 'timed_out', result: 'fail' },
  skipped: { status: 'completed', result: 'skipped' },
};

/**
 * Normalize a persisted record into the current v3 lifecycle shape. v3+ records
 * pass through unchanged; legacy v2 records (where `status` held the outcome) are
 * mapped into `{ status, result, stage }`. Safe to call on any record.
 */
export function coerceLegacyRecord(rec: ExecutionRecord): ExecutionRecord {
  if (!rec) return rec;
  const legacy = LEGACY_STATUS_MAP[rec.status as unknown as LegacyStatus];
  if (!legacy) {
    // Already a v3 lifecycle status — only fill in defaults for missing fields.
    return {
      ...rec,
      result: rec.result ?? null,
      stage: rec.stage ?? (isTerminalStatus(rec.status) ? 'completed' : 'executing'),
      jobId: rec.jobId ?? null,
    };
  }
  return {
    ...rec,
    status: legacy.status,
    // Prefer an explicit healed result if the record already carried healing that held up.
    result:
      rec.result ??
      (rec.healing && rec.validation?.passedAfterHealing ? 'healed' : legacy.result),
    stage: rec.stage ?? 'completed',
    jobId: rec.jobId ?? null,
  };
}

/** True when a lifecycle status is terminal (no further transitions expected). */
export function isTerminalStatus(status: ExecutionLifecycleStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'timed_out';
}
