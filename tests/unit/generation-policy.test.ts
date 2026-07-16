/**
 * Sprint RIF — Generation Policy.
 *
 * The Generation Policy maps a RequirementCoverage (a FACT) to a
 * GenerationDecision (a ROUTING decision). The default coverage-based policy
 * ships exactly one rule set:
 *
 *     COVERED  → SKIP
 *     PARTIAL  → EXTEND
 *     MISSING  → GENERATE
 *
 * These tests pin that mapping, prove it is deterministic, and prove the seam
 * is pluggable (a custom policy can override the decision without any other
 * layer changing). Pure — NO LLM, NO DB, NO UI.
 */

import {
  CoverageBasedGenerationPolicy,
  defaultGenerationPolicy,
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
    confidence: partial.confidence ?? 100,
    matchedFeature: partial.matchedFeature ?? null,
    matches: partial.matches ?? [],
  };
}

describe('CoverageBasedGenerationPolicy (RIF)', () => {
  const policy = new CoverageBasedGenerationPolicy();

  it('routes COVERED → SKIP (existing tests cover it, nothing to generate)', () => {
    expect(policy.decide(coverage({ status: 'COVERED', coverage: 100 }))).toBe(GenerationDecision.SKIP);
  });

  it('routes PARTIAL → EXTEND (some behaviors covered, extend the rest)', () => {
    expect(policy.decide(coverage({ status: 'PARTIAL', coverage: 50 }))).toBe(GenerationDecision.EXTEND);
  });

  it('routes MISSING → GENERATE (no coverage, generate from scratch)', () => {
    expect(policy.decide(coverage({ status: 'MISSING', coverage: 0 }))).toBe(GenerationDecision.GENERATE);
  });

  it('is deterministic — the same coverage always yields the same decision', () => {
    const cov = coverage({ status: 'PARTIAL', coverage: 40 });
    const first = policy.decide(cov);
    for (let i = 0; i < 5; i++) {
      expect(policy.decide(cov)).toBe(first);
    }
  });

  it('does not depend on coverage % — only status drives the decision', () => {
    // A PARTIAL at 99% still EXTENDs; a COVERED at any % still SKIPs.
    expect(policy.decide(coverage({ status: 'PARTIAL', coverage: 99 }))).toBe(GenerationDecision.EXTEND);
    expect(policy.decide(coverage({ status: 'COVERED', coverage: 100 }))).toBe(GenerationDecision.SKIP);
  });

  it('exposes a shared default instance implementing the policy seam', () => {
    const asSeam: GenerationPolicy = defaultGenerationPolicy;
    expect(asSeam.decide(coverage({ status: 'MISSING' }))).toBe(GenerationDecision.GENERATE);
  });
});

describe('GenerationPolicy seam is pluggable (RIF)', () => {
  it('a custom policy can override the default routing', () => {
    // A deprecation-aware policy that always regenerates, regardless of coverage.
    const alwaysGenerate: GenerationPolicy = {
      decide: () => GenerationDecision.GENERATE,
    };
    expect(alwaysGenerate.decide(coverage({ status: 'COVERED', coverage: 100 }))).toBe(GenerationDecision.GENERATE);
  });
});
