/**
 * Sprint 4.1 + 4.2 · Healing Explainability & Candidate Ranking — HealingResult
 * ============================================================================
 *
 * WHAT THIS COVERS:
 * `HealingResult` is the canonical, explainable output of a healing operation.
 * These tests pin the DETERMINISTIC behaviour of its pure builder so future
 * sprints (4.3 risk, 4.4 history) can extend it without silently changing the
 * contract downstream UI/analytics depend on.
 *
 * DESIGN INVARIANTS UNDER TEST:
 * 1. Reason codes are derived by comparing original vs. healed selectors — never
 *    generated text. Every code has a stable trigger.
 * 2. Confidence is PASSED THROUGH from the engine (finalScore preferred), never
 *    recomputed.
 * 3. Evidence only reflects dimensions that were actually present.
 * 4. (4.2) rankedCandidates is a PURE VIEW of the engine's already-ranked
 *    ScoredCandidate output — engine order preserved (never re-sorted), 1-based
 *    rank, exactly one `chosen`, existing breakdown relabelled as evidence.
 * 5. Risk is derived by the deterministic HealingRiskClassifier (Sprint 4.3);
 *    its own rules are unit-tested in healing-risk-classifier.test.ts. Here we
 *    only assert the builder wires the classifier through end-to-end.
 * 6. A null suggestion yields a well-formed "no heal" result (never throws).
 */

import {
  buildHealingResult,
  buildEvidence,
  buildRankedCandidates,
  inferHealingReason,
  reasonText,
  type BuildHealingResultInput,
  type HealingReasonCode,
} from '../../src/core/healing-result';

describe('Sprint 4.1 — HealingResult explainability contract', () => {
  /* ---------------------------------------------------------------------- */
  /*  inferHealingReason — deterministic reason vocabulary                  */
  /* ---------------------------------------------------------------------- */
  describe('inferHealingReason', () => {
    it('returns NO_HEAL when nothing was healed', () => {
      expect(inferHealingReason('#login', null)).toBe('NO_HEAL');
      expect(inferHealingReason('#login', '')).toBe('NO_HEAL');
    });

    it('returns LOCATOR_UNSTABLE when DOM Memory flagged the original as unstable', () => {
      // stabilityScore <= 0.3 is the strongest, most specific attributable reason.
      const code = inferHealingReason('#login', '#login-v2', { stabilityScore: 0.2 });
      expect(code).toBe('LOCATOR_UNSTABLE');
    });

    it('returns DATA_TESTID_REMOVED when a data-test attribute the selector relied on is gone', () => {
      const code = inferHealingReason(
        '[data-testid="submit-btn"]',
        'button.submit',
      );
      expect(code).toBe('DATA_TESTID_REMOVED');
    });

    it('returns ID_CHANGED when an #id the selector relied on disappears', () => {
      const code = inferHealingReason('#submit-btn', 'button.submit');
      expect(code).toBe('ID_CHANGED');
    });

    it('returns TEXT_CHANGED when a text-based match changes', () => {
      const dropped = inferHealingReason('getByText("Sign In")', 'button.login');
      expect(dropped).toBe('TEXT_CHANGED');
      const reworded = inferHealingReason('getByText("Sign In")', 'getByText("Log In")');
      expect(reworded).toBe('TEXT_CHANGED');
    });

    it('returns ROLE_CHANGED when a role/aria match is dropped', () => {
      const code = inferHealingReason('getByRole("button")', 'button.primary');
      expect(code).toBe('ROLE_CHANGED');
    });

    it('returns ELEMENT_MOVED when the structural path signal differs', () => {
      const code = inferHealingReason('div > form input.email', 'input.email');
      expect(code).toBe('ELEMENT_MOVED');
    });

    it('returns ATTRIBUTE_CHANGED when both are attribute selectors but the payload differs', () => {
      const code = inferHealingReason('[name="user"]', '[name="username"]');
      expect(code).toBe('ATTRIBUTE_CHANGED');
    });

    it('falls back to SELECTOR_UPDATED when no more specific difference is attributable', () => {
      const code = inferHealingReason('button.login', 'button.signin');
      expect(code).toBe('SELECTOR_UPDATED');
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  reasonText — deterministic lookup                                      */
  /* ---------------------------------------------------------------------- */
  describe('reasonText', () => {
    it('renders a stable human sentence for every reason code', () => {
      const codes: HealingReasonCode[] = [
        'DATA_TESTID_REMOVED',
        'ID_CHANGED',
        'ATTRIBUTE_CHANGED',
        'TEXT_CHANGED',
        'ROLE_CHANGED',
        'ELEMENT_MOVED',
        'LOCATOR_UNSTABLE',
        'SELECTOR_UPDATED',
        'NO_HEAL',
      ];
      for (const code of codes) {
        const text = reasonText(code);
        expect(typeof text).toBe('string');
        expect(text.length).toBeGreaterThan(0);
      }
    });
  });

  /* Risk classification moved to healing-risk-classifier.test.ts (Sprint 4.3). */

  /* ---------------------------------------------------------------------- */
  /*  buildEvidence — honest reflection of present signals                   */
  /* ---------------------------------------------------------------------- */
  describe('buildEvidence', () => {
    it('emits only the breakdown dimensions that are present', () => {
      const input: BuildHealingResultInput = {
        originalSelector: '#a',
        confidenceResult: {
          finalScore: 0.9,
          breakdown: {
            selectorQuality: 0.8,
            similarityScore: 0.7,
            // strategyReliability intentionally omitted
            validationBonus: 1,
          },
        },
      };
      const ev = buildEvidence(input);
      const dims = ev.map((e) => e.dimension);
      expect(dims).toContain('selector_quality');
      expect(dims).toContain('similarity');
      expect(dims).toContain('validation');
      expect(dims).not.toContain('strategy_reliability');
      expect(dims).not.toContain('historical');
    });

    it('includes dom_stability when DOM Memory provided a stability score', () => {
      const input: BuildHealingResultInput = {
        originalSelector: '#a',
        domMemoryInsight: {
          selectorHistory: { stabilityScore: 0.42, assessment: 'flaky historically' },
        },
      };
      const ev = buildEvidence(input);
      const stability = ev.find((e) => e.dimension === 'dom_stability');
      expect(stability).toBeDefined();
      expect(stability!.score).toBeCloseTo(0.42);
      expect(stability!.detail).toBe('flaky historically');
    });

    it('clamps scores into 0..1', () => {
      const input: BuildHealingResultInput = {
        originalSelector: '#a',
        confidenceResult: { finalScore: 1, breakdown: { selectorQuality: 1.5, similarityScore: -0.2 } },
      };
      const ev = buildEvidence(input);
      const q = ev.find((e) => e.dimension === 'selector_quality')!;
      const s = ev.find((e) => e.dimension === 'similarity')!;
      expect(q.score).toBe(1);
      expect(s.score).toBe(0);
    });

    it('returns an empty list when no signals are present', () => {
      expect(buildEvidence({ originalSelector: '#a' })).toEqual([]);
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  buildRankedCandidates — Sprint 4.2 pure view of the ranked decision    */
  /* ---------------------------------------------------------------------- */
  describe('buildRankedCandidates (Sprint 4.2)', () => {
    it('preserves the engine order, assigns 1-based rank, and marks the chosen', () => {
      const input: BuildHealingResultInput = {
        originalSelector: 'button.old',
        scoredCandidates: [
          { newLocator: 'button[type=submit]', score: 0.98, source: 'app_profile' },
          { newLocator: 'button.primary', score: 0.94, source: 'dom_memory' },
          { newLocator: 'text=Login', score: 0.89, source: 'ai' },
        ],
      };
      const ranked = buildRankedCandidates(input, 'button[type=submit]');
      // Order is NOT re-sorted — it mirrors the engine's already-ranked output.
      expect(ranked.map((c) => c.selector)).toEqual([
        'button[type=submit]',
        'button.primary',
        'text=Login',
      ]);
      expect(ranked.map((c) => c.rank)).toEqual([1, 2, 3]);
      expect(ranked.map((c) => c.chosen)).toEqual([true, false, false]);
      // Scores are passed through verbatim (never recomputed).
      expect(ranked[0].score).toBe(0.98);
    });

    it('preserves the engine ordering on tied scores (does not re-sort)', () => {
      const input: BuildHealingResultInput = {
        originalSelector: '#a',
        scoredCandidates: [
          { newLocator: '#first', score: 0.95, source: 'rule' },
          { newLocator: '#second', score: 0.95, source: 'dom_memory' },
          { newLocator: '#third', score: 0.9, source: 'ai' },
        ],
      };
      const ranked = buildRankedCandidates(input, '#first');
      expect(ranked.map((c) => c.selector)).toEqual(['#first', '#second', '#third']);
      expect(ranked.map((c) => c.rank)).toEqual([1, 2, 3]);
    });

    it('handles a single candidate → rank 1, chosen true', () => {
      const input: BuildHealingResultInput = {
        originalSelector: '#a',
        scoredCandidates: [{ newLocator: '#only', score: 0.9, source: 'rule' }],
      };
      const ranked = buildRankedCandidates(input, '#only');
      expect(ranked).toHaveLength(1);
      expect(ranked[0].rank).toBe(1);
      expect(ranked[0].chosen).toBe(true);
    });

    it('returns an empty list when there are zero candidates', () => {
      expect(buildRankedCandidates({ originalSelector: '#a' }, '#b')).toEqual([]);
      expect(
        buildRankedCandidates({ originalSelector: '#a', scoredCandidates: [] }, '#b'),
      ).toEqual([]);
    });

    it('falls back to marking rank 1 chosen when no selector matches the healed selector', () => {
      const input: BuildHealingResultInput = {
        originalSelector: '#a',
        scoredCandidates: [
          { newLocator: '#top', score: 0.9, source: 'rule' },
          { newLocator: '#next', score: 0.8, source: 'ai' },
        ],
      };
      // Healed selector was rewritten post-ranking and matches neither candidate.
      const ranked = buildRankedCandidates(input, '#rewritten');
      expect(ranked.filter((c) => c.chosen).map((c) => c.selector)).toEqual(['#top']);
    });

    it('relabels the ranker’s existing scoreBreakdown as per-candidate evidence (no recompute)', () => {
      const input: BuildHealingResultInput = {
        originalSelector: '#a',
        scoredCandidates: [
          {
            newLocator: '#x',
            score: 0.9,
            source: 'app_profile',
            scoreBreakdown: { confidence: 0.4, source: 0.3, rejected_syntax: 1 },
          },
        ],
      };
      const [cand] = buildRankedCandidates(input, '#x');
      const dims = cand.evidence.map((e) => e.dimension);
      expect(dims).toContain('confidence');
      expect(dims).toContain('source');
      // Hard-reject markers are not surfaced as evidence.
      expect(dims).not.toContain('rejected_syntax');
    });
  });

  /* ---------------------------------------------------------------------- */
  /*  buildHealingResult — end-to-end assembly                               */
  /* ---------------------------------------------------------------------- */
  describe('buildHealingResult', () => {
    it('passes confidence through from the engine (finalScore preferred, never recomputed)', () => {
      const result = buildHealingResult({
        originalSelector: '[data-testid="x"]',
        suggestion: { newLocator: 'button.x', confidence: 0.42, strategy: 'rule_based' },
        confidenceResult: { finalScore: 0.91, grade: 'A', autoApply: true },
      });
      // Engine's finalScore wins over the suggestion's own confidence.
      expect(result.confidence).toBeCloseTo(0.91);
      expect(result.grade).toBe('A');
      expect(result.autoApply).toBe(true);
    });

    it('falls back to the suggestion confidence when no confidenceResult is present', () => {
      const result = buildHealingResult({
        originalSelector: '#a',
        suggestion: { newLocator: '#b', confidence: 0.55 },
      });
      expect(result.confidence).toBeCloseTo(0.55);
      // Auto-apply derived from the 0.85 threshold when the engine gave no flag.
      expect(result.autoApply).toBe(false);
    });

    it('produces a well-formed NO_HEAL result when there is no suggestion', () => {
      const result = buildHealingResult({
        originalSelector: '#a',
        suggestion: null,
      });
      expect(result.healed).toBe(false);
      expect(result.healedSelector).toBeNull();
      expect(result.strategy).toBeNull();
      expect(result.reasonCode).toBe('NO_HEAL');
      expect(result.confidence).toBe(0);
      expect(result.risk).toBe('high');
      expect(result.evidence).toEqual([]);
      expect(result.chosenCandidate).toBeNull();
      expect(result.rankedCandidates).toEqual([]);
      expect(result.alternatives).toEqual([]);
    });

    it('assembles a full explainable result for a data-testid removal, including the ranked set', () => {
      const result = buildHealingResult({
        originalSelector: '[data-testid="submit-btn"]',
        suggestion: { newLocator: 'button.submit', strategy: 'rule_based', confidence: 0.96 },
        confidenceResult: {
          finalScore: 0.96,
          grade: 'A',
          autoApply: true,
          breakdown: { selectorQuality: 0.8, similarityScore: 0.9, validationBonus: 1 },
        },
        domMemoryInsight: {
          selectorHistory: { stabilityScore: 0.7, assessment: 'stable' },
        },
        scoredCandidates: [
          { newLocator: 'button.submit', score: 0.9, source: 'rule' },
          { newLocator: '#submit', score: 0.6, source: 'dom_memory' },
        ],
        domValidated: true,
      });
      expect(result.healed).toBe(true);
      expect(result.healedSelector).toBe('button.submit');
      expect(result.reasonCode).toBe('DATA_TESTID_REMOVED');
      expect(result.reason).toBe(reasonText('DATA_TESTID_REMOVED'));
      expect(result.evidence.length).toBeGreaterThan(0);
      // Sprint 4.2 — the chosen selector and the full ranked set are exposed.
      expect(result.chosenCandidate).toBe('button.submit');
      expect(result.rankedCandidates.map((c) => c.selector)).toEqual(['button.submit', '#submit']);
      expect(result.rankedCandidates.find((c) => c.chosen)!.selector).toBe('button.submit');
      // alternatives is populated from rankedCandidates (1:1 today; can diverge later).
      expect(result.alternatives.map((a) => a.selector)).toEqual(['button.submit', '#submit']);
      expect(result.alternatives[0].confidence).toBeCloseTo(0.9);
      expect(result.risk).toBe('low');
    });

    it('trims whitespace from selectors', () => {
      const result = buildHealingResult({
        originalSelector: '  #a  ',
        suggestion: { newLocator: '  #b  ' },
      });
      expect(result.originalSelector).toBe('#a');
      expect(result.healedSelector).toBe('#b');
    });
  });
});
