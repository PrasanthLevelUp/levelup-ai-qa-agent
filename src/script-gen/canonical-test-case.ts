/**
 * Canonical Test Case Model — the single data contract between the Test Case
 * Lab (planning) and the Script Generation engine (execution).
 *
 * WHY THIS EXISTS
 * ---------------
 * Historically the Script Generation parser (`parseTestCaseSteps`) tried to
 * guess the shape of every `steps` payload it was handed. Different producers
 * (manual entry, CSV import, requirement/RTM sync, AI generation, Jira, …)
 * persisted `steps` in incompatible shapes:
 *
 *   A  string[]                              → parsed ✅
 *   B  [{ action, expected }]                → parsed ✅
 *   C  [{ stepNumber, description }]         → parsed ✅
 *   D  [{ instruction, expectedResult }]     → parsed ❌  (0 steps → non-automatable)
 *   E  { "1": "…", "2": "…" }  (object)      → parsed ❌  (0 steps → non-automatable)
 *
 * Shapes D and E silently produced ZERO parsed actions, which made every test
 * case linked to a requirement non-automatable at Stage 1 of the pipeline —
 * the root cause of the `DeterministicGenerationEmptyError(11, [])` symptom.
 *
 * Rather than letting the parser grow an ever-expanding list of shape guesses
 * (Shape A…G, forever), this module normalizes ANY input shape into ONE
 * canonical model up front. Script Generation then consumes exactly one
 * contract and never has to guess again. New input sources (Jira, Azure
 * DevOps, Swagger, …) only need a mapping into this canonical model.
 *
 * The normalizer is a pure, side-effect-free function. It also returns rich
 * diagnostics so that when a case yields 0 steps the pipeline can report the
 * exact reason (empty / non-array / unknown object keys) instead of a bare
 * `null` — closing the observability gap that produced `caseErrors: []`.
 */

/** A single ordered, human-readable automation step (canonical form). */
export type CanonicalStep = string;

/** The one shape Script Generation consumes, regardless of source. */
export interface CanonicalTestCase {
  id?: number | string;
  title?: string;
  /** Ordered, cleaned step descriptions. Always a `string[]` (never nested). */
  steps: CanonicalStep[];
  expectedResult?: string;
  preconditions?: string;
  testData?: string;
  scenario?: string;
  requirementId?: string | number;
}

/** The detected raw shape of a `steps` payload, for diagnostics. */
export type StepsSourceShape =
  | 'string-array'        // ["Navigate…", "Enter email…"]
  | 'object-array'        // [{action|step|description|instruction|…}]
  | 'keyed-object'        // { "1": "…", "2": "…" } or { step1: "…" }
  | 'newline-string'      // "1. Navigate\n2. Enter email"
  | 'json-string'         // a JSON string that decoded into one of the above
  | 'empty'               // null / undefined / [] / ""
  | 'unknown';            // present but no extractable text

/** Rich reason a normalization produced (few or) zero steps. */
export interface NormalizationDiagnostics {
  /** Number of canonical steps produced. */
  stepCount: number;
  /** Detected shape of the raw `steps` payload. */
  sourceShape: StepsSourceShape;
  /**
   * When `steps` is (an array of) object(s), the union of keys observed on the
   * step objects — surfaced so an unknown-schema failure names the real keys
   * (e.g. `["instruction","expectedResult"]`).
   */
  observedKeys?: string[];
  /** Human-readable warnings (e.g. why 0 steps resulted). */
  warnings: string[];
}

/**
 * Keys, in priority order, from which we extract the human-readable text of a
 * single step object. This is the ONE place shape knowledge lives. Adding a new
 * producer's key here (or, preferably, mapping it upstream) is the only change
 * ever needed — the parser downstream stays contract-pure.
 */
const STEP_TEXT_KEYS = [
  'action',
  'step',
  'description',
  'instruction',
  'text',
  'stepText',
  'stepDescription',
  'step_description',
  'title',
  'name',
  'detail',
  'details',
  'value',
] as const;

/** Strip a leading "1." / "2)" ordinal prefix and trim. */
function stripOrdinalPrefix(s: string): string {
  return String(s).replace(/^\s*\d+[.)]\s*/, '').trim();
}

/** Pull the best step text out of a single step object. */
function extractStepText(obj: Record<string, any>): string {
  for (const k of STEP_TEXT_KEYS) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  // Last resort: the first non-empty string value on the object. This keeps
  // genuinely-foreign shapes automatable instead of silently dropping them.
  for (const v of Object.values(obj)) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** Sort keyed-object entries by natural/numeric order before taking values. */
function orderedObjectValues(obj: Record<string, any>): any[] {
  return Object.keys(obj)
    .sort((a, b) => {
      const na = Number(String(a).replace(/[^\d]/g, ''));
      const nb = Number(String(b).replace(/[^\d]/g, ''));
      if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
      return String(a).localeCompare(String(b), undefined, { numeric: true });
    })
    .map((k) => obj[k]);
}

/**
 * Normalize ANY `steps` payload into an ordered `string[]` plus diagnostics.
 * This is the heart of the canonical model — the single, shape-tolerant entry
 * point every consumer should use.
 */
export function normalizeSteps(rawSteps: any): { steps: string[]; diagnostics: NormalizationDiagnostics } {
  const warnings: string[] = [];
  const observedKeys = new Set<string>();

  if (rawSteps == null || rawSteps === '') {
    return { steps: [], diagnostics: { stepCount: 0, sourceShape: 'empty', warnings: ['steps payload is empty/null'] } };
  }

  let value: any = rawSteps;
  let decodedFromJson = false;

  // A JSON string may encode any of the array/object shapes.
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        value = JSON.parse(trimmed);
        decodedFromJson = true;
      } catch {
        /* not JSON — treat as newline-delimited prose below */
      }
    }
  }

  // ── Newline-delimited prose string ──────────────────────────────
  if (typeof value === 'string') {
    const steps = value
      .split(/\r?\n/)
      .map(stripOrdinalPrefix)
      .filter(Boolean);
    return {
      steps,
      diagnostics: {
        stepCount: steps.length,
        sourceShape: 'newline-string',
        warnings: steps.length ? [] : ['string steps payload had no non-empty lines'],
      },
    };
  }

  // ── Array shapes (string[] or object[]) ─────────────────────────
  if (Array.isArray(value)) {
    let sawObject = false;
    const steps = value
      .map((s: any) => {
        if (typeof s === 'string') return stripOrdinalPrefix(s);
        if (typeof s === 'number') return String(s);
        if (s && typeof s === 'object') {
          sawObject = true;
          Object.keys(s).forEach((k) => observedKeys.add(k));
          return stripOrdinalPrefix(extractStepText(s));
        }
        return '';
      })
      .filter(Boolean);

    const sourceShape: StepsSourceShape = decodedFromJson
      ? 'json-string'
      : sawObject
        ? 'object-array'
        : 'string-array';

    if (!steps.length) {
      warnings.push(
        sawObject
          ? `array of step objects yielded no extractable text (observed keys: [${[...observedKeys].join(', ')}])`
          : 'array steps payload had no non-empty entries',
      );
    }
    return {
      steps,
      diagnostics: {
        stepCount: steps.length,
        sourceShape,
        ...(observedKeys.size ? { observedKeys: [...observedKeys] } : {}),
        warnings,
      },
    };
  }

  // ── Keyed object shape: { "1": "…", step1: "…" } ────────────────
  if (value && typeof value === 'object') {
    const values = orderedObjectValues(value);
    const steps = values
      .map((v: any) => {
        if (typeof v === 'string') return stripOrdinalPrefix(v);
        if (typeof v === 'number') return String(v);
        if (v && typeof v === 'object') {
          Object.keys(v).forEach((k) => observedKeys.add(k));
          return stripOrdinalPrefix(extractStepText(v));
        }
        return '';
      })
      .filter(Boolean);

    if (!steps.length) {
      warnings.push(
        `object steps payload had no extractable values (keys: [${Object.keys(value).join(', ')}])`,
      );
    }
    return {
      steps,
      diagnostics: {
        stepCount: steps.length,
        sourceShape: 'keyed-object',
        ...(observedKeys.size ? { observedKeys: [...observedKeys] } : {}),
        warnings,
      },
    };
  }

  return {
    steps: [],
    diagnostics: { stepCount: 0, sourceShape: 'unknown', warnings: [`unrecognized steps payload type: ${typeof value}`] },
  };
}

/** Raw test-case row shape as stored/loaded (loose by design). */
export interface RawTestCaseLike {
  id?: number | string;
  title?: string;
  steps?: any;
  expected_result?: string;
  expectedResult?: string;
  preconditions?: string;
  test_data?: string;
  testData?: string;
  scenario?: string;
  requirement_id?: string | number;
  requirementId?: string | number;
  [k: string]: any;
}

/**
 * Normalize a full raw test case (any producer shape) into the canonical model
 * plus diagnostics. This is the function Script Generation should call — it
 * guarantees `steps` is always a clean `string[]`.
 */
export function normalizeTestCase(
  raw: RawTestCaseLike | null | undefined,
): { canonical: CanonicalTestCase; diagnostics: NormalizationDiagnostics } {
  if (!raw) {
    return {
      canonical: { steps: [] },
      diagnostics: { stepCount: 0, sourceShape: 'empty', warnings: ['test case is null/undefined'] },
    };
  }
  const { steps, diagnostics } = normalizeSteps(raw.steps);
  const canonical: CanonicalTestCase = {
    ...(raw.id != null ? { id: raw.id } : {}),
    ...(raw.title != null ? { title: raw.title } : {}),
    steps,
    ...(raw.expected_result ?? raw.expectedResult ? { expectedResult: String(raw.expected_result ?? raw.expectedResult) } : {}),
    ...(raw.preconditions != null ? { preconditions: String(raw.preconditions) } : {}),
    ...(raw.test_data ?? raw.testData ? { testData: String(raw.test_data ?? raw.testData) } : {}),
    ...(raw.scenario != null ? { scenario: String(raw.scenario) } : {}),
    ...(raw.requirement_id ?? raw.requirementId ? { requirementId: raw.requirement_id ?? raw.requirementId } : {}),
  };
  return { canonical, diagnostics };
}

/**
 * Build a concise, human-readable Stage-1 diagnostic line for a case that
 * produced 0 automatable steps. Surfaced in the 422 `caseErrors` so users see
 * WHY a case was rejected (which stage, which shape, which keys).
 */
export function describeStageOneFailure(
  label: string,
  diagnostics: NormalizationDiagnostics,
): string {
  const parts = [`${label}: STAGE 1 (step parsing) produced 0 automatable steps`];
  parts.push(`shape=${diagnostics.sourceShape}`);
  if (diagnostics.observedKeys?.length) parts.push(`keys=[${diagnostics.observedKeys.join(', ')}]`);
  if (diagnostics.warnings.length) parts.push(diagnostics.warnings[0]!);
  return parts.join(' · ');
}
