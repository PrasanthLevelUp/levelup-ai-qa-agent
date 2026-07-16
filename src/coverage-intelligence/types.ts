/**
 * Generation Intelligence · Shared Types
 * ============================================================================
 *
 * NAMING NOTE (architecture): despite living under `coverage-intelligence/`,
 * this module is actually **Generation Intelligence**. It answers
 * "what should Script Generation DO with a scenario — skip / extend /
 * generate?", NOT "what does the repository cover?". Coverage is a separate
 * layer (RequirementCoverageEngine → RequirementCoverage). The public decision
 * type was renamed CoverageDecision → GenerationDecision to make that explicit;
 * the folder should eventually move under a generation-focused namespace.
 *
 * NOTE on SKIP (was REUSE): a "fully covered" scenario means Script Generation
 * has nothing to do → SKIP. The word "reuse" is deliberately NOT used here — it
 * belongs to the future Reuse Engine (finding reusable CODE to call), which is
 * a different concept from skipping generation. Naming is architecture.
 *
 * These types are shared across Script Generation, Healing, Migration, Chat,
 * and Release Readiness — they form the platform's shared language for
 * describing whether a scenario should be skipped, extended, or generated.
 */

/**
 * The generation decision — the fundamental output of Generation Intelligence.
 * This is the stable contract between the generation-routing layer and all
 * consuming systems (planner, generator, UI, reports).
 */
export enum GenerationDecision {
  /** An existing test fully covers the scenario → nothing to generate, SKIP. */
  SKIP = 'skip',
  /** A partial match exists → extend the existing test rather than duplicate. */
  EXTEND = 'extend',
  /** No matching test exists → this is new coverage, generate it. */
  GENERATE = 'generate',
}

/**
 * Human-readable label for each decision (for UI / logs / reports).
 */
export const GENERATION_DECISION_LABEL: Record<GenerationDecision, string> = {
  [GenerationDecision.SKIP]: 'Skip Generation',
  [GenerationDecision.EXTEND]: 'Extend',
  [GenerationDecision.GENERATE]: 'Generate',
};
