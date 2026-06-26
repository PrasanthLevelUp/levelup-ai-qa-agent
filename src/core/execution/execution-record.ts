/**
 * Execution Record — the CANONICAL record of a single test execution.
 *
 * This is the single source of truth for an execution. It is NOT just an
 * artifact container: it accumulates, across the lifecycle, a fixed set of
 * SECTIONS that are persisted as-is:
 *
 *   ExecutionRecord
 *   ├── Metadata    — identity: executionId, testName, jobId, profile, schemaVersion
 *   ├── Execution   — lifecycle: status, result, stage, start/end/duration
 *   ├── Events      — append-only log of WHAT HAPPENED, in order, with timestamps
 *   ├── Evidence    — what we SAW (screenshot/DOM/trace/console/network/locator…)
 *   ├── Diagnosis   — the classifier's verdict (what failed, why)
 *   ├── Healing     — the decision taken and the fix applied
 *   ├── Validation  — whether the fix held up on rerun
 *   └── Learning    — what was written back to the system's memory
 *
 * ── STATE vs HISTORY ───────────────────────────────────────────────────────
 * `stage` is the record's CURRENT state (the latest pipeline step). `events` is
 * its HISTORY — an append-only log of stage transitions and section milestones,
 * each with an ISO timestamp. The two are deliberately separate: `stage`
 * answers "where is it now?", `events` answers "how did it get here, and when?".
 * Because the full ordered history is stored, the Timeline, Replay, bottleneck
 * analysis, audit log and learning analytics are all TRIVIAL derivations — they
 * never have to be reconstructed/inferred after the fact.
 *
 * ── PROJECTIONS — DERIVED ON DEMAND, NEVER STORED ──────────────────────────
 * The following are PURE FUNCTIONS of the record above. They must NOT be added
 * as persisted fields — storing them would bloat the record and let it drift
 * out of sync with its own source data:
 *
 *   Timeline · Replay · Confidence · Root-Cause Graph · Dashboard cards ·
 *   AI explanations · per-section Metrics rollups · display stage labels ·
 *   stage history (derived from `events`) · bottleneck analysis
 *
 * Keeping projections out of the record is what lets the record stay small and
 * STABLE forever: new visualizations are new derivations, not new columns. The
 * `events` log is the raw substrate those derivations read from.
 *
 * ── VERSIONING ─────────────────────────────────────────────────────────────
 * `schemaVersion` IS the record's version (currently 3). It is stamped on every
 * record so the UI/readers can render older records correctly and migrations
 * can coerce legacy shapes forward (see `coerceLegacyRecord`). Bump it on any
 * breaking shape change.
 *
 * The dashboard and analytics read ONLY this record (not separate diagnosis /
 * healing / evidence / artifact tables).
 *
 * Persistence lives in src/db/postgres.ts (save/getExecutionRecord). This
 * module owns only the business model and the immutable accumulators.
 */
import type { ExecutionProfile } from './execution-profile';

/**
 * Current schema version of the canonical execution record. This IS the
 * record's `version` — stamped on every record so older records can still be
 * rendered/migrated. Bump on breaking shape changes.
 */
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
  | 'collecting_evidence'
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
//
// Every major section carries an optional `timing` (startedAt / completedAt /
// durationMs) so the dashboard can show a per-phase breakdown — e.g.
//   Evidence 0.4s · Diagnosis 1.2s · Healing 2.8s · Learning 140ms —
// without inventing a separate analytics store. (Per-phase Metrics rollups are
// a PROJECTION derived from these timings, never persisted separately.)
// ---------------------------------------------------------------------------

/**
 * Wall-clock timing for a single lifecycle section. All fields optional because
 * a section may be recorded without precise timing; populate best-effort.
 */
export interface SectionTiming {
  /** ISO timestamp the section began. */
  startedAt?: string;
  /** ISO timestamp the section completed. */
  completedAt?: string;
  /** Duration in milliseconds (completedAt − startedAt). */
  durationMs?: number;
}

/**
 * Build a SectionTiming from two epoch-millis markers. Clamps negative spans to
 * zero so clock skew can never produce a nonsensical negative duration.
 */
export function makeSectionTiming(startMs: number, endMs: number): SectionTiming {
  return {
    startedAt: new Date(startMs).toISOString(),
    completedAt: new Date(endMs).toISOString(),
    durationMs: Math.max(0, endMs - startMs),
  };
}

// ---------------------------------------------------------------------------
// Event log — the record's HISTORY (append-only), kept separate from `stage`
// (its current STATE). Every meaningful transition appends a timestamped event:
// the record is created, the stage changes, an advisor section completes, and
// finally the execution is finalized. Storing the ordered log means Timeline,
// Replay, bottleneck analysis and audit views are read straight off `events`
// rather than reconstructed. New event types can be added freely — readers that
// don't recognise a type simply ignore it (forward-compatible).
// ---------------------------------------------------------------------------

/** What kind of thing happened. Open-ended; readers ignore unknown types. */
export type ExecutionEventType =
  | 'execution_created'
  | 'stage_changed'
  | 'evidence_collected'
  | 'diagnosis_completed'
  | 'healing_completed'
  | 'validation_completed'
  | 'learning_completed'
  | 'execution_finalized';

/**
 * A single entry in the execution's append-only history. `stage` is set for
 * stage-related events (created / stage_changed / finalized) so the stage
 * history can be derived directly. `note` carries an optional short detail
 * (e.g. the terminal `status/result` on finalize).
 */
export interface ExecutionEvent {
  /** What happened. */
  type: ExecutionEventType;
  /** ISO timestamp the event occurred. */
  timestamp: string;
  /** The pipeline stage in effect, for stage-related events. */
  stage?: ExecutionStage;
  /** Optional one-line human-readable detail. */
  note?: string;
}

/**
 * Evidence — the OBSERVED FACTS captured for this execution (mirror of
 * core/evidence-collector EvidenceBundle). The "what we saw" section:
 * screenshot/DOM/trace/console/network signals + locator state. (File-backed
 * evidence such as the screenshot/trace/video itself lives in `artifacts`; this
 * section holds the structured, queryable facts derived from them.)
 */
export interface EvidenceRecord {
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
  /** When this evidence was collected. */
  timing?: SectionTiming;
}

/**
 * Back-compat alias. The section was originally named "Observation"; it reads
 * better to users as "Evidence".
 * @deprecated Prefer `EvidenceRecord`.
 */
export type ObservationRecord = EvidenceRecord;

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
  /** When diagnosis ran. */
  timing?: SectionTiming;
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
  /** When the healing phase ran (includes validation reruns interleaved with it). */
  timing?: SectionTiming;
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
  /** When validation ran. */
  timing?: SectionTiming;
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
  /** When the learning write-back ran. */
  timing?: SectionTiming;
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

  /**
   * Append-only history of what happened, in order, with timestamps. This is the
   * record's HISTORY (distinct from `stage`, its current STATE). Stage history,
   * Timeline, Replay and bottleneck analysis are all derived from this log.
   */
  events: ExecutionEvent[];

  // ---- Lifecycle sections (accumulated stage by stage) ----
  /** Evidence collected for this execution (the "what we saw" section). */
  evidence?: EvidenceRecord;
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
  const stage = init.stage ?? 'executing';
  // Seed the history with the birth event. Its timestamp is the record's start
  // so the stage history's first span begins exactly when the execution did.
  const createdAt = init.startTime ?? new Date().toISOString();
  return {
    schemaVersion: EXECUTION_RECORD_SCHEMA_VERSION,
    executionId: init.executionId,
    testName: init.testName,
    status: init.status ?? 'running',
    result: init.result ?? null,
    stage,
    jobId: init.jobId ?? null,
    durationMs: init.durationMs,
    startTime: init.startTime,
    endTime: init.endTime,
    profile: init.profile,
    artifacts: init.artifacts ?? {},
    events: [{ type: 'execution_created', timestamp: createdAt, stage }],
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

/** Accumulate collected evidence onto the record (immutable merge). */
export function recordEvidence(rec: ExecutionRecord, evidence: Partial<EvidenceRecord>): ExecutionRecord {
  return { ...rec, evidence: { ...(rec.evidence ?? {}), ...evidence } };
}

/**
 * Back-compat alias for {@link recordEvidence}.
 * @deprecated The "Observation" section was renamed to "Evidence".
 */
export const recordObservations = recordEvidence;

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

/**
 * Append an event to the record's history (immutable). The timestamp defaults to
 * now if not supplied. This is the single writer for the append-only `events`
 * log — every other lifecycle helper routes through it.
 */
export function appendEvent(
  rec: ExecutionRecord,
  event: { type: ExecutionEventType; stage?: ExecutionStage; note?: string; timestamp?: string },
): ExecutionRecord {
  const entry: ExecutionEvent = {
    type: event.type,
    timestamp: event.timestamp ?? new Date().toISOString(),
    ...(event.stage !== undefined ? { stage: event.stage } : {}),
    ...(event.note !== undefined ? { note: event.note } : {}),
  };
  return { ...rec, events: [...(rec.events ?? []), entry] };
}

/** The stage carried by the most recent stage-bearing event, if any. */
function lastEventStage(rec: ExecutionRecord): ExecutionStage | undefined {
  const evs = rec.events ?? [];
  for (let i = evs.length - 1; i >= 0; i--) {
    if (evs[i].stage !== undefined) return evs[i].stage;
  }
  return undefined;
}

/**
 * Advance the record to a new pipeline stage (immutable) and log the transition
 * to the history. A no-op repeat of the current stage is NOT logged again, so
 * the stage history stays clean even if `setStage` is called defensively.
 */
export function setStage(rec: ExecutionRecord, stage: ExecutionStage): ExecutionRecord {
  const advanced = { ...rec, stage };
  if (lastEventStage(rec) === stage) return advanced;
  return appendEvent(advanced, { type: 'stage_changed', stage });
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
  const updated: ExecutionRecord = {
    ...rec,
    status: next.status ?? rec.status,
    result: next.result !== undefined ? next.result : rec.result,
    stage: next.stage ?? rec.stage,
  };
  // Log a single finalize event when the record first reaches a terminal status.
  const alreadyFinalized = (rec.events ?? []).some((e) => e.type === 'execution_finalized');
  if (isTerminalStatus(updated.status) && !alreadyFinalized) {
    return appendEvent(updated, {
      type: 'execution_finalized',
      stage: updated.stage,
      note: `${updated.status}/${updated.result ?? 'null'}`,
    });
  }
  return updated;
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
  // Migrate the legacy `observations` section to its new name `evidence`. Older
  // persisted records (and their JSONB) used `observations`; surface them as
  // `evidence` without losing the original data.
  const legacyObservations = (rec as unknown as { observations?: EvidenceRecord }).observations;
  if (rec.evidence === undefined && legacyObservations !== undefined) {
    rec = { ...rec, evidence: legacyObservations };
  }
  // Records persisted before the event log existed have no `events`; default to
  // an empty history. We do NOT fabricate past events we never observed — an
  // empty log honestly says "history wasn't captured for this older record".
  const events = rec.events ?? [];
  const legacy = LEGACY_STATUS_MAP[rec.status as unknown as LegacyStatus];
  if (!legacy) {
    // Already a v3 lifecycle status — only fill in defaults for missing fields.
    return {
      ...rec,
      result: rec.result ?? null,
      stage: rec.stage ?? (isTerminalStatus(rec.status) ? 'completed' : 'executing'),
      jobId: rec.jobId ?? null,
      events,
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
    events,
  };
}

/** True when a lifecycle status is terminal (no further transitions expected). */
export function isTerminalStatus(status: ExecutionLifecycleStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'timed_out';
}
