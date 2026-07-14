/**
 * Coverage Intelligence · Shared Types
 * ============================================================================
 *
 * Platform-wide enums and contracts for Coverage Intelligence decisions.
 * These types are reusable across Script Generation, Healing, Migration,
 * Chat, and Release Readiness — they form the platform's shared language
 * for describing whether a scenario should be reused, extended, or generated.
 */

/**
 * The coverage decision — the fundamental output of Coverage Intelligence.
 * This is the stable contract between the intelligence layer and all consuming
 * systems (planner, generator, UI, reports).
 */
export enum CoverageDecision {
  /** An existing test fully covers the scenario → skip generation, reuse it. */
  REUSE = 'reuse',
  /** A partial match exists → extend the existing test rather than duplicate. */
  EXTEND = 'extend',
  /** No matching test exists → this is new coverage, generate it. */
  GENERATE = 'generate',
}

/**
 * Human-readable label for each decision (for UI / logs / reports).
 */
export const COVERAGE_DECISION_LABEL: Record<CoverageDecision, string> = {
  [CoverageDecision.REUSE]: 'Reuse',
  [CoverageDecision.EXTEND]: 'Extend',
  [CoverageDecision.GENERATE]: 'Generate',
};
