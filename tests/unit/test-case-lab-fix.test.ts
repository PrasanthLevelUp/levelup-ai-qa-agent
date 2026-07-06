/**
 * Unit tests for the "Test Case Lab fix" — the latency/cost reduction work.
 *
 * Verifies the behaviours introduced so a simple login requirement no longer
 * takes minutes / thousands of tokens:
 *   A (Priority 1) — respect the user's coverage selection. The engine only
 *     broadens the committed coverage types when `aiCoverageExpansion` is
 *     explicitly TRUE. Default → generate EXACTLY the selected types.
 *   D (Priority 3) — skip the extra gap-analysis LLM round-trip for simple
 *     requirements (composite complexity below GAP_ANALYSIS_MIN_COMPLEXITY).
 *   Mode derivation — a gated (skipped) gap analysis keeps mode = 'strict';
 *     a real gap analysis flips it to 'expanded'.
 *
 * All LLM / embedding round-trips are stubbed so this runs offline & instantly.
 */

// The engine constructor requires an API key; set a dummy before import-time use.
process.env['OPENAI_API_KEY'] = process.env['OPENAI_API_KEY'] || 'sk-test';

import {
  TestCoverageEngine,
  type RequirementInput,
  type CoverageType,
  type RequirementAnalysis,
} from '../../src/engines/test-coverage-engine';

const FAKE_ANALYSIS: RequirementAnalysis = {
  featureType: 'ui',
  riskLevel: 'medium',
  businessCriticality: 'medium',
  impactedModules: [],
  userRolesAffected: [],
  apiDependencies: [],
  dbImpact: 'none',
  workflowSteps: [],
  summary: 'stub analysis',
};

/** Replace every LLM / embedding round-trip with an offline stub. */
function stubEngine(engine: TestCoverageEngine): { gapCalls: number } {
  const spy = { gapCalls: 0 };

  (engine as any).callLLM = async () => ({
    content: JSON.stringify({
      scenarios: [],
      testCases: [],
      suggestedTestCases: [],
      missingRequirements: [],
      coverageTypeEvaluations: [],
    }),
    tokensUsed: 10,
  });

  // The real analyzeRequirement resolves to { analysis, tokensUsed }.
  (engine as any).analyzeRequirement = async () => ({ analysis: FAKE_ANALYSIS, tokensUsed: 5 });

  (engine as any).deduplicateTestCases = async (cases: any[]) => ({ kept: cases, removed: 0 });

  (engine as any).analyzeCoverageGaps = async () => {
    spy.gapCalls++;
    return { gaps: [], tokensUsed: 7 };
  };

  return spy;
}

const SIMPLE: RequirementInput = {
  title: 'User Login',
  description: 'User can log in with email and password.',
  acceptanceCriteria: 'Valid credentials log the user in.',
  module: 'Auth',
};

const COMPLEX: RequirementInput = {
  title: 'Multi-step insurance claim submission and adjudication workflow',
  description:
    'Policyholders submit a claim with supporting documents; the system validates ' +
    'coverage, runs fraud scoring, routes to an adjuster, supports partial approvals, ' +
    'appeals, and disbursement across multiple payment methods and jurisdictions.',
  acceptanceCriteria: [
    'Claim can be submitted with multiple documents',
    'Coverage is validated against the active policy',
    'Fraud score is computed and thresholded',
    'Claims above a limit require manual adjuster approval',
    'Partial approvals are supported',
    'Rejected claims can be appealed',
    'Approved claims are disbursed via the selected method',
    'All state transitions are audit-logged',
  ].join('\n'),
  businessFlow:
    'Submit → Validate coverage → Fraud score → Route to adjuster → Decision → Disburse → Audit',
  module: 'Claims',
};

const ALL_TYPES: CoverageType[] = ['positive', 'negative', 'edge_cases', 'boundary', 'integration'];

describe('Test Case Lab fix — gap-analysis gating (Priority 3 / "D")', () => {
  it('simple requirement below the gate → gap analysis is skipped and mode is strict', async () => {
    const engine = new TestCoverageEngine();
    const spy = stubEngine(engine);

    const complexity = engine.estimateComplexity(SIMPLE, ['positive', 'negative']);
    expect(complexity.signals.complexityScore).toBeLessThan(35); // precondition

    const result = await engine.generateFullCoverage(SIMPLE, ['positive', 'negative'], undefined, {
      includeCoverageGaps: true, // requested — but gated off by complexity
    });

    expect(spy.gapCalls).toBe(0);
    expect(result.mode).toBe('strict');
    expect(result.coverageGaps).toHaveLength(0);
  });

  it('complex requirement above the gate → gap analysis runs and mode is expanded', async () => {
    const engine = new TestCoverageEngine();
    const spy = stubEngine(engine);

    const complexity = engine.estimateComplexity(COMPLEX, ALL_TYPES);
    expect(complexity.signals.complexityScore).toBeGreaterThanOrEqual(35); // precondition

    const result = await engine.generateFullCoverage(COMPLEX, ALL_TYPES, undefined, {
      includeCoverageGaps: true,
    });

    expect(spy.gapCalls).toBe(1);
    expect(result.mode).toBe('expanded');
  });
});

describe('Test Case Lab fix — respect coverage selection (Priority 1 / "A")', () => {
  it('aiCoverageExpansion=false → committed coverage is EXACTLY the selected types', async () => {
    const engine = new TestCoverageEngine();
    stubEngine(engine);

    const selected: CoverageType[] = ['positive', 'negative'];
    const gen = await engine.generateTestCoverage(
      SIMPLE, FAKE_ANALYSIS, selected, undefined, 'strict', 2500, 60000, /* aiCoverageExpansion */ false,
    );

    const evaluatedTypes = gen.coverageTypeEvaluations.map(e => e.coverageType).sort();
    expect(evaluatedTypes).toEqual([...selected].sort());
  });

  it('aiCoverageExpansion=true → committed coverage is broadened to the baseline', async () => {
    const engine = new TestCoverageEngine();
    stubEngine(engine);

    const selected: CoverageType[] = ['positive', 'negative'];
    const gen = await engine.generateTestCoverage(
      SIMPLE, FAKE_ANALYSIS, selected, undefined, 'expanded', 2500, 60000, /* aiCoverageExpansion */ true,
    );

    const evaluatedTypes = new Set(gen.coverageTypeEvaluations.map(e => e.coverageType));
    for (const t of ALL_TYPES) {
      expect(evaluatedTypes.has(t)).toBe(true);
    }
  });
});
