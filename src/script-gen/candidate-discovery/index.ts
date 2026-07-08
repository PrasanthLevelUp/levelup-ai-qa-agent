/**
 * Candidate Discovery — orchestrator (Sprint 2 · PR 1)
 * =====================================================
 * `discoverCandidates()` walks each business step, classifies its intent, and
 * collects every plausible implementation candidate (reuse assets + locator
 * families) into a read-only report.
 *
 * Guarantees:
 *   • Never ranks (report.ranked === false).
 *   • Never selects (report.selected === false).
 *   • Never throws — fails open to an empty report so it can never break a
 *     generation run (mirrors the Scenario Integrity Validator's fail-open rule).
 *   • Pure — does not mutate its inputs.
 */

import type { CandidateDiscoveryReport, DiscoveryContext, StepCandidates } from './types';
import { classifyIntent, discoverLocatorCandidates, discoverReuseCandidates } from './discover';

export * from './types';
export { classifyIntent, extractTarget, discoverReuseCandidates, discoverLocatorCandidates } from './discover';
export { rankReport, CANDIDATE_PRIORITY } from './rank';
// The public surface of Engineering Standards is intentionally small: the one
// decision (evaluateCandidate) and the read-only default table. Compatibility /
// quality / confidence are folded INTO evaluateCandidate — not separate public
// concepts — and the override API stays internal until a customer needs it.
export {
  evaluateCandidate,
  DEFAULT_CANDIDATE_PRIORITY,
  type CandidateEvaluation,
  type CandidatePriority,
  type QualityVerdict,
  type Confidence,
} from '../engineering-standards';

/** An empty, well-formed report (used on empty input and on any failure). */
function emptyReport(): CandidateDiscoveryReport {
  return {
    steps: [],
    totalCandidates: 0,
    stepsWithCandidates: 0,
    reuseCandidates: 0,
    ranked: false,
    selected: false,
  };
}

/**
 * Discover candidates for an ordered list of business steps.
 *
 * @param steps  Ordered business-step strings (as authored in the scenario).
 * @param ctx    Optional reusable-asset catalogue from the repo scan.
 */
export function discoverCandidates(
  steps: string[] | undefined | null,
  ctx: DiscoveryContext = {},
): CandidateDiscoveryReport {
  try {
    if (!Array.isArray(steps) || steps.length === 0) return emptyReport();

    const perStep: StepCandidates[] = [];
    let total = 0;
    let reuse = 0;
    let withCandidates = 0;

    for (const raw of steps) {
      const step = String(raw ?? '');
      const intent = classifyIntent(step);
      const candidates = [
        ...discoverReuseCandidates(step, ctx),
        ...discoverLocatorCandidates(step, intent),
      ];
      total += candidates.length;
      reuse += candidates.filter((c) => c.reuse).length;
      if (candidates.length > 0) withCandidates += 1;
      perStep.push({ step, intent, candidates });
    }

    return {
      steps: perStep,
      totalCandidates: total,
      stepsWithCandidates: withCandidates,
      reuseCandidates: reuse,
      ranked: false,
      selected: false,
    };
  } catch {
    // Fail open — discovery is a transparency report, never a gate.
    return emptyReport();
  }
}
