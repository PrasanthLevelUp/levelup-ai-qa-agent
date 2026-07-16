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
 * The policy seam. Implementations map a requirement's coverage to the
 * generation decision. Kept as an interface so richer policies (business-rule,
 * confidence-aware, deprecation-aware) can be dropped in later WITHOUT changing
 * the RequirementIntelligenceService or any consumer.
 */
export interface GenerationPolicy {
  decide(coverage: RequirementCoverage): GenerationDecision;
}

/**
 * The default, coverage-based policy — the ONLY logic we ship today:
 *
 *     COVERED  → SKIP      (existing tests fully cover it, nothing to generate)
 *     PARTIAL  → EXTEND    (some behaviors covered, extend the rest)
 *     MISSING  → GENERATE  (no coverage, generate from scratch)
 *
 * Nothing else. When business rules arrive (requirement freshness, script
 * deprecation, confidence floors) they extend THIS class or replace it behind
 * the GenerationPolicy seam — Coverage stays untouched.
 */
export class CoverageBasedGenerationPolicy implements GenerationPolicy {
  decide(coverage: RequirementCoverage): GenerationDecision {
    switch (coverage.status) {
      case 'COVERED':
        return GenerationDecision.SKIP;
      case 'PARTIAL':
        return GenerationDecision.EXTEND;
      case 'MISSING':
      default:
        return GenerationDecision.GENERATE;
    }
  }
}

/** Shared default instance — stateless, safe to reuse. */
export const defaultGenerationPolicy: GenerationPolicy = new CoverageBasedGenerationPolicy();
