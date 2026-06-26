/**
 * Execution Record mappers — translate the healing pipeline's core outputs
 * (EvidenceBundle, FailureDiagnosis, ReportHealing) into the canonical
 * {@link ExecutionRecord} sub-types.
 *
 * This mapping lives in the execution domain (NOT in the API worker) so the
 * worker stays thin: it just calls `record* (record, mapX(coreOutput))`. Keeping
 * the translation here means the shape contract between core outputs and the
 * canonical record is owned in one place and unit-testable in isolation.
 */
import { randomUUID } from 'crypto';
import type { EvidenceBundle } from '../evidence-collector';
import type { FailureDiagnosis } from '../failure-classifier';
import type {
  ObservationRecord,
  DiagnosisRecord,
  HealingDecisionRecord,
  ArtifactDescriptor,
  ArtifactType,
  ArtifactStorage,
  ExecutionArtifacts,
} from './execution-record';

/**
 * Build a storage-agnostic artifact descriptor from a local filesystem path.
 * `storage` defaults to `'local'` — the bytes live on the worker's disk today,
 * but consumers resolve them through `id` + `storage`, so moving to S3/GCS later
 * is a storage-layer change, not a record-schema change.
 */
export function artifactDescriptor(
  type: ArtifactType,
  filePath: string,
  opts: { storage?: ArtifactStorage; size?: number; contentType?: string } = {},
): ArtifactDescriptor {
  return {
    id: `art_${randomUUID()}`,
    type,
    storage: opts.storage ?? 'local',
    path: filePath,
    ...(opts.size !== undefined ? { size: opts.size } : {}),
    ...(opts.contentType ? { contentType: opts.contentType } : {}),
    createdAt: new Date().toISOString(),
  };
}

const ARTIFACT_CONTENT_TYPE: Partial<Record<ArtifactType, string>> = {
  screenshot: 'image/png',
  trace: 'application/zip',
  video: 'video/webm',
  dom: 'text/html',
  html: 'text/html',
};

/**
 * Map the file paths the Playwright run produced (and that the Evidence
 * Collector surfaced) into `ArtifactDescriptor`s on the record. Only paths that
 * are actually present produce a descriptor.
 */
export function artifactsFromPaths(paths: {
  screenshotPath?: string | null;
  tracePath?: string | null;
  videoPath?: string | null;
  storage?: ArtifactStorage;
}): Partial<ExecutionArtifacts> {
  const out: Partial<ExecutionArtifacts> = {};
  const storage = paths.storage ?? 'local';
  if (paths.screenshotPath) {
    out.screenshot = artifactDescriptor('screenshot', paths.screenshotPath, {
      storage, contentType: ARTIFACT_CONTENT_TYPE.screenshot,
    });
  }
  if (paths.tracePath) {
    out.trace = artifactDescriptor('trace', paths.tracePath, {
      storage, contentType: ARTIFACT_CONTENT_TYPE.trace,
    });
  }
  if (paths.videoPath) {
    out.video = artifactDescriptor('video', paths.videoPath, {
      storage, contentType: ARTIFACT_CONTENT_TYPE.video,
    });
  }
  return out;
}

/**
 * Map an {@link EvidenceBundle} (the OBSERVED facts the Evidence Collector
 * aggregated) into the record's {@link ObservationRecord} section.
 */
export function mapEvidenceToObservations(evidence: EvidenceBundle): ObservationRecord {
  const ls = evidence.locatorState;
  return {
    locatorState: ls
      ? {
          exists: ls.exists,
          visible: ls.visible,
          enabled: ls.enabled,
          receivesPointerEvents: ls.receivesPointerEvents,
          clickable: ls.clickable,
          interceptedBy: ls.interceptedBy,
          source: ls.source,
        }
      : null,
    consoleErrors: evidence.consoleErrors ?? [],
    networkErrors: (evidence.networkErrors ?? []).map((n) => ({
      ...(n.url !== undefined ? { url: n.url } : {}),
      ...(n.status !== undefined ? { status: n.status } : {}),
      detail: n.detail,
    })),
    summary: evidence.summary ?? [],
  };
}

/**
 * Map a {@link FailureDiagnosis} (the classifier's verdict) into the record's
 * {@link DiagnosisRecord} section.
 */
export function mapDiagnosisToRecord(d: FailureDiagnosis): DiagnosisRecord {
  return {
    category: d.category,
    confidence: d.confidence,
    recommendedStrategy: d.recommendedStrategy,
    rootCause: d.rootCause,
    recommendedAction: d.recommendedAction,
    locator: d.locator,
    locatorResolvedFromPageObject: d.locatorResolvedFromPageObject,
    healableByLocatorSwap: d.healableByLocatorSwap,
    evidenceBased: d.evidenceBased,
  };
}

/**
 * Build a {@link HealingDecisionRecord} from the aggregated outcome of a test's
 * healing attempt. `attempted`/`applied` come from the worker's per-test
 * aggregates (it loops over strategies/iterations, so the canonical decision is
 * the final applied one).
 */
export function buildHealingDecision(input: {
  remedy?: string;
  attemptedStrategies?: string[];
  appliedStrategy?: string | null;
  source?: string | null;
  brokenLocator?: string | null;
  newLocator?: string | null;
  candidatesConsidered?: number;
  reportOnly?: boolean;
  rationale?: string;
}): HealingDecisionRecord {
  return {
    ...(input.remedy !== undefined ? { remedy: input.remedy } : {}),
    ...(input.attemptedStrategies ? { attemptedStrategies: input.attemptedStrategies } : {}),
    appliedStrategy: input.appliedStrategy ?? null,
    source: input.source ?? null,
    brokenLocator: input.brokenLocator ?? null,
    newLocator: input.newLocator ?? null,
    ...(input.candidatesConsidered !== undefined ? { candidatesConsidered: input.candidatesConsidered } : {}),
    ...(input.reportOnly !== undefined ? { reportOnly: input.reportOnly } : {}),
    ...(input.rationale ? { rationale: input.rationale } : {}),
  };
}
