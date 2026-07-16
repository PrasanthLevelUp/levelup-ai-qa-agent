/**
 * Generation Policy.
 *
 * A tiny, deliberately-separate layer that answers ONE question:
 *   "Given a requirement's coverage, what should Script Generation DO?"
 *   → SKIP · EXTEND · GENERATE.
 *
 * WHY THIS IS ITS OWN LAYER (architecture):
 *   The obvious shortcut is to derive the generation decision straight from
 *   `coverage.status` inside the RequirementIntelligenceService. We deliberately
 *   do NOT. Coverage answers "what does the repo cover?" — a factual question.
 *   The routing decision is a POLICY question that will diverge from coverage as
 *   the product grows, e.g.:
 *     • coverage = COVERED, but the requirement changed yesterday   → GENERATE
 *     • coverage = COVERED, but the covering script is deprecated    → GENERATE
 *     • coverage = PARTIAL, but repository confidence is very low    → GENERATE
 *   Those are policy rules. The Coverage Engine must never learn them. Isolating
 *   them here keeps Coverage pure and gives business rules a home to grow in
 *   without contaminating the measurement layer.
 *
 * This is NOT Generation Intelligence (the reuse/extend/generate ROUTER over
 * scenarios in src/coverage-intelligence). It is a small policy that maps a
 * RequirementCoverage to a GenerationDecision. Deterministic — no LLM, no DB.
 */

import { GenerationDecision } from '../coverage-intelligence/types';
import type { RequirementCoverage } from '../requirement-coverage/types';

/**
 * Machine-readable reasons a decision OVERRODE the raw coverage-status mapping.
 * Kept as named constants (not free strings) so every surface renders the same
 * words and new rules land here, not scattered across the codebase.
 */
export const GENERATION_REASON = {
  /** A COVERED verdict the engine wasn't confident enough about → downgraded to EXTEND. */
  LOW_CONFIDENCE: 'Low confidence',
} as const;

/**
 * The result of a policy decision: the decision itself, plus WHY — the override
 * reasons that made it diverge from the plain coverage-status mapping. `reasons`
 * is empty when the decision follows coverage status directly. This is a richer
 * return than a bare enum precisely so a consumer never has to re-derive "why
 * did we generate?" — the policy, which owns the WHY, states it.
 */
export interface GenerationDecisionResult {
  decision: GenerationDecision;
  reasons: string[];
}

/**
 * The policy seam. Implementations map a requirement's coverage to a generation
 * decision (and the reasons behind it). Kept as an interface so richer policies
 * (deprecation-aware, freshness-aware) can be dropped in later WITHOUT changing
 * the RequirementIntelligenceService or any consumer.
 */
export interface GenerationPolicy {
  decide(coverage: RequirementCoverage): GenerationDecisionResult;
}

/** The env var that tunes the SKIP confidence gate. */
export const REQUIREMENT_SKIP_CONFIDENCE_THRESHOLD_ENV = 'REQUIREMENT_SKIP_CONFIDENCE_THRESHOLD';

/**
 * Default SKIP confidence floor (0-100). A COVERED verdict below this is NOT
 * trusted enough to skip generation; we downgrade to EXTEND instead.
 */
export const DEFAULT_SKIP_CONFIDENCE_THRESHOLD = 60;

/**
 * Resolve the SKIP confidence threshold from the environment. Invalid, empty,
 * or out-of-range (<0 or >100) values fall back to the default with an optional
 * warning — a typo can never silently disable or over-tighten the gate.
 */
export function resolveSkipConfidenceThreshold(
  env: NodeJS.ProcessEnv = process.env,
  onInvalid?: (message: string) => void,
): number {
  const raw = env[REQUIREMENT_SKIP_CONFIDENCE_THRESHOLD_ENV];
  if (raw == null || raw.trim() === '') return DEFAULT_SKIP_CONFIDENCE_THRESHOLD;
  const n = Number(raw.trim());
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    onInvalid?.(
      `Invalid ${REQUIREMENT_SKIP_CONFIDENCE_THRESHOLD_ENV}="${raw}" — expected a ` +
        `number 0-100; falling back to ${DEFAULT_SKIP_CONFIDENCE_THRESHOLD}.`,
    );
    return DEFAULT_SKIP_CONFIDENCE_THRESHOLD;
  }
  return n;
}

/**
 * The default, coverage-based policy with a confidence gate:
 *
 *     COVERED · confidence ≥ threshold  → SKIP      (trusted full coverage)
 *     COVERED · confidence < threshold  → EXTEND    (something matches, but we
 *                                                     don't trust the verdict —
 *                                                     extend, don't regenerate all)
 *     PARTIAL                           → EXTEND    (extend the uncovered rest)
 *     MISSING                           → GENERATE  (no coverage, generate all)
 *
 * The confidence gate exists because a wrong SKIP is the most expensive mistake
 * the pipeline can make (a genuinely-untested requirement silently shipped as
 * "covered"). When a COVERED verdict is weak we DON'T jump straight to GENERATE
 * — the engine already found *something* that matches, so regenerating
 * everything wastes tokens. EXTEND is the safer, cheaper fallback. Threshold is
 * injected (not read from env here) to keep the policy pure and testable.
 */
export class CoverageBasedGenerationPolicy implements GenerationPolicy {
  constructor(
    private readonly skipConfidenceThreshold: number = DEFAULT_SKIP_CONFIDENCE_THRESHOLD,
  ) {}

  decide(coverage: RequirementCoverage): GenerationDecisionResult {
    switch (coverage.status) {
      case 'COVERED':
        if (coverage.confidence >= this.skipConfidenceThreshold) {
          return { decision: GenerationDecision.SKIP, reasons: [] };
        }
        // Covered, but not confidently — extend rather than trust the skip.
        return {
          decision: GenerationDecision.EXTEND,
          reasons: [GENERATION_REASON.LOW_CONFIDENCE],
        };
      case 'PARTIAL':
        return { decision: GenerationDecision.EXTEND, reasons: [] };
      case 'MISSING':
      default:
        return { decision: GenerationDecision.GENERATE, reasons: [] };
    }
  }
}

/**
 * Build the default policy, resolving the confidence threshold from the
 * environment. Use this where env config matters (the service/route); tests
 * construct `CoverageBasedGenerationPolicy` with an explicit threshold.
 */
export function createDefaultGenerationPolicy(
  env: NodeJS.ProcessEnv = process.env,
  onInvalid?: (message: string) => void,
): GenerationPolicy {
  return new CoverageBasedGenerationPolicy(resolveSkipConfidenceThreshold(env, onInvalid));
}

/**
 * Shared default instance — stateless, safe to reuse. Uses the built-in default
 * threshold; env-driven construction goes through `createDefaultGenerationPolicy`.
 */
export const defaultGenerationPolicy: GenerationPolicy = new CoverageBasedGenerationPolicy();
