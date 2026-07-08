/**
 * Candidate Ranking — deterministic priorities (Sprint 2 · PR 2B)
 * ================================================================
 * Scores and orders the candidates that Discovery (PR 2A) found. NO AI, NO
 * LLM, NO prompts, NO embeddings — a fixed priority table, applied purely.
 *
 * The decisive rule: rank by **engineering value**, not locator quality.
 * Reusing an existing abstraction (fixture > page object > helper > component)
 * outranks generating a brand-new locator — even a perfect `data-testid` one —
 * because that is the better engineering decision. Locator quality only breaks
 * ties between candidates of equal engineering value. This is exactly how a
 * senior automation engineer thinks, and it is the deterministic backbone of
 * "Existing Code First".
 *
 * Boundaries (enforced by tests):
 *   • Ranking ORDERS candidates and sets rank/scores. It does NOT select a
 *     winner and does NOT change generated code (report.selected stays false).
 *   • Pure: returns a new report; never mutates its input.
 *   • Never throws — fails open by returning the input unranked.
 */

import type {
  CandidateDiscoveryReport,
  CandidateType,
  ImplementationCandidate,
  StepCandidates,
} from './types';

/**
 * The fixed priority table. `engineering` is the primary key (reuse-first);
 * `locator` is the tie-breaker. Values are intentionally spread so the ordering
 * is unambiguous and easy to reason about.
 *
 * Note the deliberate inversion for the top locator family: an app-profile
 * (grounded, `data-testid`-class) locator has a HIGHER locator quality (96)
 * than a reused fixture (85) — yet the fixture still wins, because engineering
 * value (100 vs 92) decides first. That inversion is the whole point.
 */
const PRIORITY: Record<CandidateType, { engineering: number; locator: number }> = {
  'existing-fixture':       { engineering: 100, locator: 85 },
  'existing-page-object':   { engineering: 98,  locator: 90 },
  'existing-helper':        { engineering: 96,  locator: 88 },
  'existing-component':     { engineering: 94,  locator: 86 },
  'app-profile-locator':    { engineering: 92,  locator: 96 },
  'accessibility-locator':  { engineering: 90,  locator: 93 },
  'dom-locator':            { engineering: 75,  locator: 70 },
};

/** Score a single candidate against the priority table (pure; new object). */
function scoreCandidate(c: ImplementationCandidate): ImplementationCandidate {
  const p = PRIORITY[c.type];
  return { ...c, engineeringValue: p.engineering, locatorQuality: p.locator };
}

/**
 * Rank one step's candidates: score each, then sort strongest-first by
 * (engineeringValue desc, locatorQuality desc, original order). The stable
 * original-order tie-break keeps ranking deterministic.
 */
function rankStep(step: StepCandidates): StepCandidates {
  const scored = step.candidates.map(scoreCandidate);
  const ordered = scored
    .map((c, i) => ({ c, i })) // capture original index for a stable tie-break
    .sort((a, b) => {
      const ev = (b.c.engineeringValue ?? 0) - (a.c.engineeringValue ?? 0);
      if (ev !== 0) return ev;
      const lq = (b.c.locatorQuality ?? 0) - (a.c.locatorQuality ?? 0);
      if (lq !== 0) return lq;
      return a.i - b.i;
    })
    .map(({ c }, idx) => ({ ...c, rank: idx + 1 }));
  return { ...step, candidates: ordered };
}

/**
 * Rank an entire discovery report. Returns a NEW report with each step's
 * candidates scored and ordered, and `ranked: true`. Never selects a winner
 * (`selected` stays false) and never mutates the input. Fails open.
 */
export function rankReport(report: CandidateDiscoveryReport): CandidateDiscoveryReport {
  try {
    return {
      ...report,
      steps: report.steps.map(rankStep),
      ranked: true,
      selected: false,
    };
  } catch {
    // Fail open — ranking is a transparency layer, never a gate.
    return report;
  }
}

/** Exposed for tests / debugging. The fixed priority table (read-only). */
export const CANDIDATE_PRIORITY: Readonly<typeof PRIORITY> = PRIORITY;
