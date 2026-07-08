/**
 * Candidate Ranking — deterministic ordering (Sprint 2 · PR 2B)
 * ==============================================================
 * Ranking does almost nothing on purpose. Every engineering decision already
 * happened in EngineeringStandards.evaluateCandidate() — compatibility and
 * quality are folded into a single `candidateScore`. So ranking is literally:
 *
 *     sort by candidateScore desc, locatorQuality desc, original order.
 *
 * A clean, compatible reuse candidate keeps its high base value and wins. A
 * stale or low-quality reuse candidate has already been driven below the
 * generated-locator floor by its adjustments, so it sorts to the bottom — no
 * branching here, no gate, no special cases.
 *
 * Boundaries (enforced by tests):
 *   • Ranking ORDERS candidates and records rank/scores/confidence. It does NOT
 *     select a winner and does NOT change generated code (selected stays false).
 *   • Pure: returns a new report; never mutates its input.
 *   • Never throws — fails open by returning the input unranked.
 */

import type {
  CandidateDiscoveryReport,
  ImplementationCandidate,
  StepCandidates,
} from './types';
import { evaluateCandidate, DEFAULT_CANDIDATE_PRIORITY } from '../engineering-standards';

/** Attach the full engineering evaluation to a candidate (pure; new object). */
function scoreCandidate(c: ImplementationCandidate): ImplementationCandidate {
  const e = evaluateCandidate(c);
  return {
    ...c,
    candidateScore: e.candidateScore,
    locatorQuality: e.locatorQuality,
    compatibility: e.compatibility,
    quality: e.quality,
    confidence: e.confidence,
  };
}

/**
 * Rank one step's candidates: evaluate each, then sort strongest-first by
 * (candidateScore desc, locatorQuality desc, original order). The stable
 * original-order tie-break keeps ranking deterministic.
 */
function rankStep(step: StepCandidates): StepCandidates {
  const ordered = step.candidates
    .map((c, i) => ({ c: scoreCandidate(c), i }))
    .sort((a, b) => {
      const ev = (b.c.candidateScore ?? 0) - (a.c.candidateScore ?? 0);
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
 * candidates evaluated and ordered, and `ranked: true`. Never selects a winner
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

/** The base priority table (read-only), re-exported for tests / debugging. */
export const CANDIDATE_PRIORITY = DEFAULT_CANDIDATE_PRIORITY;
