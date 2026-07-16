/**
 * Sprint "Trusted Intelligence" — Generation Policy.
 *
 * The Generation Policy maps a RequirementCoverage (a FACT) to a
 * GenerationDecisionResult (a ROUTING decision + the reasons behind it). The
 * default coverage-based policy ships:
 *
 *     COVERED · confidence ≥ threshold  → SKIP      (reasons: [])
 *     COVERED · confidence < threshold  → EXTEND    (reasons: ['Low confidence'])
 *     PARTIAL                           → EXTEND    (reasons: [])
 *     MISSING                           → GENERATE  (reasons: [])
 *
 * These tests pin that mapping, the confidence gate, the env-resolved threshold,
 * that it is deterministic, and that the seam is pluggable. Pure — NO LLM, NO
 * DB, NO UI.
 */

import {
  CoverageBasedGenerationPolicy,
  defaultGenerationPolicy,
  createDefaultGenerationPolicy,
  resolveSkipConfidenceThreshold,
  REQUIREMENT_SKIP_CONFIDENCE_THRESHOLD_ENV,
  DEFAULT_SKIP_CONFIDENCE_THRESHOLD,
  GENERATION_REASON,
  type GenerationPolicy,
} from '../../src/requirement-intelligence/generation-policy';
import { GenerationDecision } from '../../src/coverage-intelligence/types';
import type { RequirementCoverage } from '../../src/requirement-coverage/types';

function coverage(partial: Partial<RequirementCoverage> & { status: RequirementCoverage['status'] }): RequirementCoverage {
  return {
    requirementId: partial.requirementId ?? 'REQ-1',
    status: partial.status,
    coverage: partial.coverage ?? 0,
    coveredFlows: partial.coveredFlows ?? [],
    missingFlows: partial.missingFlows ?? [],
    coveredSlices: partial.coveredSlices ?? [],
    missingSlices: partial.missingSlices ?? [],
    confidence: partial.confidence ?? 100,
    matchedFeature: partial.matchedFeature ?? null,
    matches: partial.matches ?? [],
  };
}

describe('CoverageBasedGenerationPolicy — status mapping (Trusted Intelligence)', () => {
  const policy = new CoverageBasedGenerationPolicy();

  it('routes a confident COVERED → SKIP with no override reasons', () => {
    const r = policy.decide(coverage({ status: 'COVERED', coverage: 100, confidence: 100 }));
    expect(r.decision).toBe(GenerationDecision.SKIP);
    expect(r.reasons).toEqual([]);
  });

  it('routes PARTIAL → EXTEND with no override reasons', () => {
    const r = policy.decide(coverage({ status: 'PARTIAL', coverage: 50 }));
    expect(r.decision).toBe(GenerationDecision.EXTEND);
    expect(r.reasons).toEqual([]);
  });

  it('routes MISSING → GENERATE with no override reasons', () => {
    const r = policy.decide(coverage({ status: 'MISSING', coverage: 0 }));
    expect(r.decision).toBe(GenerationDecision.GENERATE);
    expect(r.reasons).toEqual([]);
  });

  it('is deterministic — the same coverage always yields the same result', () => {
    const cov = coverage({ status: 'PARTIAL', coverage: 40 });
    const first = policy.decide(cov);
    for (let i = 0; i < 5; i++) {
      expect(policy.decide(cov)).toEqual(first);
    }
  });

  it('does not depend on coverage % — only status (and confidence) drive it', () => {
    expect(policy.decide(coverage({ status: 'PARTIAL', coverage: 99 })).decision).toBe(GenerationDecision.EXTEND);
    expect(policy.decide(coverage({ status: 'COVERED', coverage: 100, confidence: 100 })).decision).toBe(GenerationDecision.SKIP);
  });

  it('exposes a shared default instance implementing the policy seam', () => {
    const asSeam: GenerationPolicy = defaultGenerationPolicy;
    expect(asSeam.decide(coverage({ status: 'MISSING' })).decision).toBe(GenerationDecision.GENERATE);
  });
});

describe('CoverageBasedGenerationPolicy — SKIP confidence gate (Trusted Intelligence)', () => {
  const policy = new CoverageBasedGenerationPolicy(60);

  it('SKIPs a COVERED verdict at or above the threshold', () => {
    expect(policy.decide(coverage({ status: 'COVERED', confidence: 60 })).decision).toBe(GenerationDecision.SKIP);
    expect(policy.decide(coverage({ status: 'COVERED', confidence: 85 })).decision).toBe(GenerationDecision.SKIP);
  });

  it('DOWNGRADES a low-confidence COVERED to EXTEND (never SKIP), citing Low confidence', () => {
    const r = policy.decide(coverage({ status: 'COVERED', confidence: 59 }));
    expect(r.decision).toBe(GenerationDecision.EXTEND);
    expect(r.reasons).toEqual([GENERATION_REASON.LOW_CONFIDENCE]);
  });

  it('downgrades to EXTEND, NOT GENERATE (something matched — do not regenerate all)', () => {
    const r = policy.decide(coverage({ status: 'COVERED', confidence: 10 }));
    expect(r.decision).toBe(GenerationDecision.EXTEND);
    expect(r.decision).not.toBe(GenerationDecision.GENERATE);
  });

  it('honors a custom threshold from the constructor', () => {
    const strict = new CoverageBasedGenerationPolicy(90);
    expect(strict.decide(coverage({ status: 'COVERED', confidence: 80 })).decision).toBe(GenerationDecision.EXTEND);
    const lax = new CoverageBasedGenerationPolicy(0);
    expect(lax.decide(coverage({ status: 'COVERED', confidence: 0 })).decision).toBe(GenerationDecision.SKIP);
  });

  it('the confidence gate never affects PARTIAL or MISSING', () => {
    const policyStrict = new CoverageBasedGenerationPolicy(100);
    expect(policyStrict.decide(coverage({ status: 'PARTIAL', confidence: 0 })).decision).toBe(GenerationDecision.EXTEND);
    expect(policyStrict.decide(coverage({ status: 'MISSING', confidence: 0 })).decision).toBe(GenerationDecision.GENERATE);
  });
});

describe('resolveSkipConfidenceThreshold (Trusted Intelligence)', () => {
  it('defaults when unset or empty', () => {
    expect(resolveSkipConfidenceThreshold({})).toBe(DEFAULT_SKIP_CONFIDENCE_THRESHOLD);
    expect(resolveSkipConfidenceThreshold({ [REQUIREMENT_SKIP_CONFIDENCE_THRESHOLD_ENV]: '   ' })).toBe(
      DEFAULT_SKIP_CONFIDENCE_THRESHOLD,
    );
  });

  it('parses a valid number', () => {
    expect(resolveSkipConfidenceThreshold({ [REQUIREMENT_SKIP_CONFIDENCE_THRESHOLD_ENV]: '75' })).toBe(75);
    expect(resolveSkipConfidenceThreshold({ [REQUIREMENT_SKIP_CONFIDENCE_THRESHOLD_ENV]: ' 0 ' })).toBe(0);
    expect(resolveSkipConfidenceThreshold({ [REQUIREMENT_SKIP_CONFIDENCE_THRESHOLD_ENV]: '100' })).toBe(100);
  });

  it('falls back (with a warning) on non-numeric or out-of-range values', () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(resolveSkipConfidenceThreshold({ [REQUIREMENT_SKIP_CONFIDENCE_THRESHOLD_ENV]: 'high' }, warn)).toBe(
      DEFAULT_SKIP_CONFIDENCE_THRESHOLD,
    );
    expect(resolveSkipConfidenceThreshold({ [REQUIREMENT_SKIP_CONFIDENCE_THRESHOLD_ENV]: '-5' }, warn)).toBe(
      DEFAULT_SKIP_CONFIDENCE_THRESHOLD,
    );
    expect(resolveSkipConfidenceThreshold({ [REQUIREMENT_SKIP_CONFIDENCE_THRESHOLD_ENV]: '150' }, warn)).toBe(
      DEFAULT_SKIP_CONFIDENCE_THRESHOLD,
    );
    expect(warnings).toHaveLength(3);
  });

  it('createDefaultGenerationPolicy applies the resolved threshold', () => {
    // Threshold 100 forces a below-100 COVERED to downgrade.
    const policy = createDefaultGenerationPolicy({ [REQUIREMENT_SKIP_CONFIDENCE_THRESHOLD_ENV]: '100' });
    expect(policy.decide(coverage({ status: 'COVERED', confidence: 99 })).decision).toBe(GenerationDecision.EXTEND);
  });
});

describe('GenerationPolicy seam is pluggable (Trusted Intelligence)', () => {
  it('a custom policy can override the default routing', () => {
    // A deprecation-aware policy that always regenerates, regardless of coverage.
    const alwaysGenerate: GenerationPolicy = {
      decide: () => ({ decision: GenerationDecision.GENERATE, reasons: ['Deprecated'] }),
    };
    const r = alwaysGenerate.decide(coverage({ status: 'COVERED', coverage: 100 }));
    expect(r.decision).toBe(GenerationDecision.GENERATE);
    expect(r.reasons).toEqual(['Deprecated']);
  });
});
