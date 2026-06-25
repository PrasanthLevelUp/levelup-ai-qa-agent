/**
 * Unit tests for the Candidate Ranker (src/core/candidate-ranker.ts).
 *
 * The ranker is the heart of the "rank candidates before browser execution"
 * performance work: it must (a) hard-reject syntactically invalid candidates so
 * they never reach the browser, (b) prefer grounded sources over raw AI guesses,
 * and (c) order deterministically. These are pure-function tests — no I/O.
 *
 * Run with: npx jest tests/unit/candidate-ranker.test.ts
 */

import {
  scoreCandidate,
  rankCandidates,
  resolveWeights,
  SOURCE_TRUST,
  type RankableCandidate,
  type CandidateSource,
} from '../../src/core/candidate-ranker';

function makeCandidate(
  overrides: Partial<RankableCandidate> & { source: CandidateSource },
): RankableCandidate {
  const source = overrides.source;
  return {
    newLocator: overrides.newLocator ?? `page.getByTestId('x')`,
    strategy: overrides.strategy ?? 'rule_based',
    source,
    confidence: overrides.confidence ?? 0.8,
    tokensUsed: overrides.tokensUsed ?? 0,
    reasoning: overrides.reasoning ?? 'test',
    addExplicitWait: overrides.addExplicitWait ?? false,
    stabilityScore: overrides.stabilityScore,
    signals: {
      baseConfidence: overrides.confidence ?? 0.8,
      syntaxValid: true,
      inAppProfile: false,
      matchesPageObject: false,
      ...(overrides.signals ?? {}),
    },
  };
}

describe('scoreCandidate', () => {
  it('hard-rejects syntactically invalid candidates with -Infinity', () => {
    const c = makeCandidate({ source: 'app_profile', signals: { syntaxValid: false } as any });
    const scored = scoreCandidate(c);
    expect(scored.score).toBe(-Infinity);
    expect(scored.scoreBreakdown.rejected_syntax).toBe(1);
  });

  it('gives a higher score to a grounded source than a raw AI guess at equal confidence', () => {
    const appProfile = makeCandidate({ source: 'app_profile', confidence: 0.8, signals: { inAppProfile: true } as any });
    const ai = makeCandidate({ source: 'ai', confidence: 0.8 });
    expect(scoreCandidate(appProfile).score).toBeGreaterThan(scoreCandidate(ai).score);
  });

  it('rewards DOM Memory stability', () => {
    const stable = makeCandidate({ source: 'dom_memory', confidence: 0.7, signals: { domMemoryStability: 0.95 } as any });
    const unknown = makeCandidate({ source: 'dom_memory', confidence: 0.7 });
    expect(scoreCandidate(stable).score).toBeGreaterThan(scoreCandidate(unknown).score);
  });

  it('rewards App Profile membership and Page Object grounding', () => {
    const grounded = makeCandidate({ source: 'rule', confidence: 0.7, signals: { inAppProfile: true, matchesPageObject: true } as any });
    const plain = makeCandidate({ source: 'rule', confidence: 0.7 });
    expect(scoreCandidate(grounded).score).toBeGreaterThan(scoreCandidate(plain).score);
  });

  it('clamps out-of-range signal values', () => {
    const c = makeCandidate({ source: 'ai', confidence: 5, signals: { baseConfidence: 5, domMemoryStability: 9, similarityToFailed: -3 } as any });
    const scored = scoreCandidate(c);
    // confidence weight (0.4) * clamp(5→1) + source weight (0.3)*0.6 ⇒ finite, bounded
    expect(Number.isFinite(scored.score)).toBe(true);
    expect(scored.score).toBeLessThanOrEqual(1.001);
  });
});

describe('rankCandidates', () => {
  it('drops invalid candidates and returns valid ones best-first', () => {
    const invalid = makeCandidate({ source: 'ai', newLocator: 'broken', signals: { syntaxValid: false } as any });
    const weakAi = makeCandidate({ source: 'ai', confidence: 0.5 });
    const strongGrounded = makeCandidate({ source: 'app_profile', confidence: 0.9, signals: { inAppProfile: true } as any });

    const ranked = rankCandidates([invalid, weakAi, strongGrounded]);
    expect(ranked).toHaveLength(2); // invalid dropped
    expect(ranked[0].source).toBe('app_profile'); // strongest grounded first
    expect(ranked[1].source).toBe('ai');
  });

  it('breaks score ties by base confidence then source trust deterministically', () => {
    // Two candidates engineered to the same composite score band: tie-break must
    // favour the higher base confidence, then the more trusted source.
    const a = makeCandidate({ source: 'rule', confidence: 0.7 });
    const b = makeCandidate({ source: 'rule', confidence: 0.9 });
    const ranked = rankCandidates([a, b]);
    expect(ranked[0].confidence).toBe(0.9);
  });

  it('is stable across repeated runs (deterministic ordering)', () => {
    const cands = [
      makeCandidate({ source: 'dom_memory', confidence: 0.8, newLocator: 'a', signals: { domMemoryStability: 0.6 } as any }),
      makeCandidate({ source: 'rule', confidence: 0.8, newLocator: 'b' }),
      makeCandidate({ source: 'ai', confidence: 0.8, newLocator: 'c' }),
    ];
    const first = rankCandidates(cands).map((c) => c.newLocator);
    const second = rankCandidates([...cands].reverse()).map((c) => c.newLocator);
    expect(first).toEqual(second);
  });

  it('returns an empty array when every candidate is invalid', () => {
    const ranked = rankCandidates([
      makeCandidate({ source: 'ai', signals: { syntaxValid: false } as any }),
    ]);
    expect(ranked).toEqual([]);
  });
});

describe('weights & source trust', () => {
  it('orders source trust grounded > ai', () => {
    expect(SOURCE_TRUST.learned_pattern).toBeGreaterThan(SOURCE_TRUST.ai);
    expect(SOURCE_TRUST.app_profile).toBeGreaterThan(SOURCE_TRUST.rule);
  });

  it('resolveWeights honours env overrides', () => {
    const prev = process.env.HEALING_RANK_W_CONFIDENCE;
    process.env.HEALING_RANK_W_CONFIDENCE = '0.9';
    expect(resolveWeights().confidence).toBe(0.9);
    if (prev === undefined) delete process.env.HEALING_RANK_W_CONFIDENCE;
    else process.env.HEALING_RANK_W_CONFIDENCE = prev;
  });
});
