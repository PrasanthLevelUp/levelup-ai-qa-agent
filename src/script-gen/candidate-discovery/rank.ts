/**
 * Candidate Ranking — deterministic priorities (Sprint 2 · PR 2B / 2B.1)
 * =======================================================================
 * Scores and orders the candidates that Discovery (PR 2A) found. NO AI, NO
 * LLM, NO prompts, NO embeddings — fixed heuristics, applied purely.
 *
 * The pipeline is now:  Reuse Candidate → Quality Check → Ranking.
 *
 * Three dimensions per candidate (all from EngineeringHeuristics):
 *   • engineeringValue — PRIMARY. Reuse beats generation. A fixture (100)
 *     outranks a brand-new locator (92) even when the locator's quality is
 *     higher. This is how a senior automation engineer thinks.
 *   • locatorQuality  — SECONDARY. Breaks ties between equal engineering value.
 *   • compatibility   — GATE. "Is this reuse compatible with the CURRENT
 *     project?" A deprecated / obsolete / wrong-framework / archived asset
 *     scores low and CANNOT win on engineering value alone.
 *
 * And a quality gate: existing code full of `sleep(5000)` is NOT reused just
 * because it exists — it is out-ranked by a freshly generated implementation.
 *
 * Boundaries (enforced by tests):
 *   • Ranking ORDERS candidates and sets rank/scores/confidence. It does NOT
 *     select a winner and does NOT change generated code (selected stays false).
 *   • Pure: returns a new report; never mutates its input.
 *   • Never throws — fails open by returning the input unranked.
 */

import type {
  CandidateDiscoveryReport,
  ImplementationCandidate,
  StepCandidates,
} from './types';
import {
  getCandidatePriority,
  assessCompatibility,
  assessQuality,
  deriveConfidence,
  passesGate,
  DEFAULT_CANDIDATE_PRIORITY,
} from '../engineering-heuristics';

/**
 * Score a single candidate across all three dimensions plus the quality gate
 * (pure; returns a new object). A candidate that fails the gate keeps its
 * scores but is flagged so the comparator can demote it below eligible ones.
 */
function scoreCandidate(c: ImplementationCandidate): ImplementationCandidate & { _gatePass: boolean } {
  const p = getCandidatePriority(c.type);
  const compatibility = assessCompatibility(c);
  const quality = assessQuality(c);
  const gatePass = c.reuse ? passesGate(compatibility, quality) : true;
  const confidence = deriveConfidence({
    engineeringValue: p.engineering,
    compatibility,
    quality,
    gatePass,
  });
  return {
    ...c,
    engineeringValue: p.engineering,
    locatorQuality: p.locator,
    compatibility,
    quality,
    confidence,
    _gatePass: gatePass,
  };
}

/**
 * Rank one step's candidates. Sort strongest-first by:
 *   1. gate (eligible before demoted — a stale/low-quality reuse candidate
 *      cannot beat a compatible generated locator),
 *   2. engineeringValue desc (reuse beats generation among eligibles),
 *   3. locatorQuality desc (tie-break),
 *   4. original order (stable, deterministic).
 */
function rankStep(step: StepCandidates): StepCandidates {
  const scored = step.candidates.map(scoreCandidate);
  const ordered = scored
    .map((c, i) => ({ c, i })) // capture original index for a stable tie-break
    .sort((a, b) => {
      const gate = Number(b.c._gatePass) - Number(a.c._gatePass);
      if (gate !== 0) return gate;
      const ev = (b.c.engineeringValue ?? 0) - (a.c.engineeringValue ?? 0);
      if (ev !== 0) return ev;
      const lq = (b.c.locatorQuality ?? 0) - (a.c.locatorQuality ?? 0);
      if (lq !== 0) return lq;
      return a.i - b.i;
    })
    .map(({ c }, idx) => {
      const { _gatePass, ...clean } = c; // drop the internal helper flag
      return { ...clean, rank: idx + 1 };
    });
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

/**
 * The default priority table (read-only). Kept exported for backward
 * compatibility; the live, override-aware table lives in EngineeringHeuristics.
 */
export const CANDIDATE_PRIORITY = DEFAULT_CANDIDATE_PRIORITY;
