/**
 * SCENARIO INTEGRITY VALIDATOR — types
 * =====================================
 * Sprint 1.5. See SCRIPT_COMPOSER_EVOLUTION.md §"Scenario Integrity Validator".
 *
 * This module is a READ-ONLY CERTIFIER. It answers exactly one question:
 *   "Is this scenario internally consistent enough to hand to the Script
 *    Composer?"
 *
 * HARD RULES (enforced by design, not convention):
 *   1. It NEVER rewrites a scenario. It only produces a report. All check
 *      functions are pure and take a readonly view of the scenario.
 *   2. Its readiness score NEVER blocks generation. `generationAllowed` is
 *      ALWAYS `true`. The score influences downstream *confidence* only.
 *   3. It is NOT a mini Script Composer. No selectors are invented, no steps
 *      are added, no logic is owned here — it certifies input, nothing more.
 *
 * Determinism: every check is keyword/lexicon/structure based. No LLM, no
 * network, no tokens. Same input → same report, always.
 */

/**
 * The minimal, structurally-compatible view of a scenario the validator reads.
 * Deliberately loose (all optional) so it accepts both `DraftTestCase` and
 * `FormatterTestCase` (and any future superset) without coupling. The validator
 * only READS these fields — it never mutates them.
 */
export interface ScenarioForIntegrity {
  title?: string;
  objective?: string;
  coverageType?: string;
  preconditions?: string;
  steps?: string[];
  grounding?: Array<{
    stepIndex: number;
    selector?: string;
    page?: string;
    control?: string;
  }>;
  expected?: {
    observable?: string;
    business?: string;
    technical?: { selector?: string; page?: string };
  };
  expectedResult?: string;
  testData?: string;
  /**
   * The real field labels that EXIST for this feature (resolved by the builder's
   * Field Resolver from the matched feature form). When present, the field-
   * validity check verifies every field a step references is in this set —
   * catching the "login fields leaked into an Add Employee flow" bug
   * deterministically. Absent/empty ⇒ the check is skipped (nothing to judge).
   */
  applicationFields?: string[];
}

/** Stable identifiers for the nine deterministic integrity checks. */
export type IntegrityCheckId =
  | 'persona_consistency'
  | 'coverage_polarity'
  | 'test_data_suitability'
  | 'expected_result_consistency'
  | 'step_completeness'
  | 'preconditions'
  | 'business_flow'
  | 'grounding_completeness'
  | 'field_validity';

/**
 * Result of a single deterministic check. `passed` is advisory only — it feeds
 * the readiness score and the flattened warnings list. It NEVER gates behavior.
 */
export interface IntegrityCheckResult {
  id: IntegrityCheckId;
  /** Human-readable check name (for the multi-dimensional Quality Gate report). */
  label: string;
  /** Whether the check found no inconsistency. Advisory, never a gate. */
  passed: boolean;
  /** Relative importance in the weighted readiness average (0..N). */
  weight: number;
  /** Normalized quality contribution, 0..1. */
  score: number;
  /** Zero or more human-readable observations (warnings when !passed). */
  messages: string[];
}

/** Coarse confidence band derived from the readiness score. */
export type IntegrityConfidence = 'high' | 'medium' | 'low';

/**
 * The full validator report. Persisted (best-effort) under
 * `ai_metadata.scenarioIntegrity`. Consumed by the Quality Gate as one
 * dimension of the multi-dimensional readiness report.
 */
export interface ScenarioIntegrityReport {
  /** Weighted readiness score, 0..100. Influences confidence ONLY. */
  readinessScore: number;
  /** Confidence band derived from readinessScore. */
  confidence: IntegrityConfidence;
  /**
   * ALWAYS `true`. The validator is a certifier, not a gate. Kept in the report
   * as an explicit, auditable contract so no downstream consumer can ever treat
   * a low score as a block.
   */
  generationAllowed: true;
  /** Per-check results (the multi-dimensional breakdown). */
  checks: IntegrityCheckResult[];
  /** Flattened, human-readable warnings across all non-passing checks. */
  warnings: string[];
}
