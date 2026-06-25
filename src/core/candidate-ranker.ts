/**
 * Candidate Ranker — score and order healing candidates BEFORE any browser run.
 *
 * Roadmap context (Healing Performance, post-PR #161):
 *   The old worker launched Playwright after *every* candidate locator. For a
 *   handful of failing tests this meant ~18 browser reruns per test (~40 min for
 *   7 tests). The fix is to COLLECT candidates from every intelligence layer
 *   (Learned Pattern, App Profile, DOM Memory, DOM/Similarity, Rule, AI), RANK
 *   them with cheap heuristics that need no browser, REJECT the obviously-bad
 *   ones, and only then run the browser on the best candidate(s) — ideally once.
 *
 * This module is deliberately PURE (no I/O, no engines, no DB) so the ordering
 * logic is deterministic and fully unit-testable. The orchestrator feeds it
 * already-collected candidates plus the cheap signals it gathered for each.
 *
 * Signals used (all browser-free):
 *   - Selector syntax valid?      → hard reject gate (invalid ⇒ never ranked).
 *   - Source/strategy trust         → grounded sources outrank raw AI guesses.
 *   - Producing-engine confidence   → base weight.
 *   - Element exists in App Profile → boost (real, crawled DOM evidence).
 *   - Seen/stable in DOM Memory     → boost proportional to stability score.
 *   - Matches a repo Page Object    → small boost (structural grounding).
 *   - Similarity to failed locator  → small tie-breaker boost.
 */

import type { HealingStrategy } from './healing-orchestrator';

/** Where a candidate locator came from (used for source-trust weighting). */
export type CandidateSource =
  | 'learned_pattern'
  | 'app_profile'
  | 'dom_memory'
  | 'dom_candidate'
  | 'rule'
  | 'pattern'
  | 'ai';

/** Browser-free signals collected for a single candidate. */
export interface CandidateSignals {
  /** Producing engine's own confidence, 0..1. */
  baseConfidence: number;
  /** Passes cheap static/syntax validation. Invalid candidates are excluded. */
  syntaxValid: boolean;
  /** The element/selector exists in the crawled Application Profile. */
  inAppProfile: boolean;
  /** Stability score from DOM Memory (0..1); undefined when unknown. */
  domMemoryStability?: number;
  /** The failing file / selector is tied to a shared repo Page Object. */
  matchesPageObject: boolean;
  /** Semantic similarity to the failed locator's intent (0..1); optional. */
  similarityToFailed?: number;
}

/** A candidate ready to be scored. */
export interface RankableCandidate {
  newLocator: string;
  strategy: HealingStrategy;
  source: CandidateSource;
  confidence: number;
  tokensUsed: number;
  reasoning: string;
  addExplicitWait: boolean;
  stabilityScore?: number;
  signals: CandidateSignals;
}

/** A scored candidate (sorted output of {@link rankCandidates}). */
export interface ScoredCandidate extends RankableCandidate {
  /** Composite score; higher is better. -Infinity ⇒ rejected (never returned). */
  score: number;
  /** Per-signal contribution breakdown, surfaced for observability. */
  scoreBreakdown: Record<string, number>;
}

/** Tunable weights — overridable via env so ops can retune without a deploy. */
export interface RankerWeights {
  /** Weight applied to the producing engine's confidence. */
  confidence: number;
  /** Weight applied to the source-trust value. */
  source: number;
  /** Boost when the candidate exists in the App Profile. */
  appProfile: number;
  /** Max boost from DOM Memory stability (scaled by the stability score). */
  domMemory: number;
  /** Boost when the candidate is tied to a repo Page Object. */
  pageObject: number;
  /** Max boost from similarity to the failed locator (scaled by similarity). */
  similarity: number;
}

/** Per-source trust (0..1). Grounded evidence beats ungrounded AI guesses. */
export const SOURCE_TRUST: Record<CandidateSource, number> = {
  learned_pattern: 1.0, // our own previously-proven heal
  app_profile: 0.95, // real selectors from the crawl
  dom_memory: 0.9, // historical stability data
  dom_candidate: 0.85, // extracted from a live DOM snapshot
  pattern: 0.8, // database pattern match
  rule: 0.75, // deterministic rule engine
  ai: 0.6, // last-resort generative guess
};

function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Resolve weights from env (HEALING_RANK_W_*) falling back to sane defaults. */
export function resolveWeights(overrides?: Partial<RankerWeights>): RankerWeights {
  return {
    confidence: overrides?.confidence ?? envNum('HEALING_RANK_W_CONFIDENCE', 0.4),
    source: overrides?.source ?? envNum('HEALING_RANK_W_SOURCE', 0.3),
    appProfile: overrides?.appProfile ?? envNum('HEALING_RANK_W_APP_PROFILE', 0.1),
    domMemory: overrides?.domMemory ?? envNum('HEALING_RANK_W_DOM_MEMORY', 0.1),
    pageObject: overrides?.pageObject ?? envNum('HEALING_RANK_W_PAGE_OBJECT', 0.05),
    similarity: overrides?.similarity ?? envNum('HEALING_RANK_W_SIMILARITY', 0.05),
  };
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Score a single candidate (pure). Returns -Infinity for a hard reject so the
 * candidate is dropped entirely by {@link rankCandidates}.
 */
export function scoreCandidate(
  candidate: RankableCandidate,
  weights: RankerWeights = resolveWeights(),
): ScoredCandidate {
  const s = candidate.signals;

  // Hard gate: a selector that does not even parse must never reach the browser.
  if (!s.syntaxValid) {
    return { ...candidate, score: -Infinity, scoreBreakdown: { rejected_syntax: 1 } };
  }

  const breakdown: Record<string, number> = {};
  breakdown.confidence = weights.confidence * clamp01(s.baseConfidence);
  breakdown.source = weights.source * clamp01(SOURCE_TRUST[candidate.source] ?? 0.5);
  breakdown.appProfile = s.inAppProfile ? weights.appProfile : 0;
  breakdown.domMemory =
    s.domMemoryStability !== undefined ? weights.domMemory * clamp01(s.domMemoryStability) : 0;
  breakdown.pageObject = s.matchesPageObject ? weights.pageObject : 0;
  breakdown.similarity =
    s.similarityToFailed !== undefined ? weights.similarity * clamp01(s.similarityToFailed) : 0;

  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);
  return { ...candidate, score, scoreBreakdown: breakdown };
}

/**
 * Rank candidates best-first. Invalid candidates (score === -Infinity) are
 * dropped. Ties are broken by base confidence, then source trust, so ordering
 * is fully deterministic.
 */
export function rankCandidates(
  candidates: RankableCandidate[],
  weights: RankerWeights = resolveWeights(),
): ScoredCandidate[] {
  return candidates
    .map((c) => scoreCandidate(c, weights))
    .filter((c) => c.score > -Infinity)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.signals.baseConfidence !== a.signals.baseConfidence) {
        return b.signals.baseConfidence - a.signals.baseConfidence;
      }
      return (SOURCE_TRUST[b.source] ?? 0) - (SOURCE_TRUST[a.source] ?? 0);
    });
}
