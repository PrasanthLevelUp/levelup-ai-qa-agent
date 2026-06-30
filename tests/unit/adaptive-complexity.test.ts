/**
 * Unit tests for Adaptive Generation — the heuristic complexity classifier.
 *
 * Verifies that `estimateComplexity` routes requirements to the correct tier
 * (FAST / STANDARD / COMPREHENSIVE) and that the computed signals are accurate.
 * The classifier is pure + synchronous and spends ZERO LLM tokens, so these
 * tests run fully offline (no network, no API key needed beyond construction).
 *
 * Run with: npx tsx tests/unit/adaptive-complexity.test.ts
 */

import {
  TestCoverageEngine,
  type RequirementInput,
  type CoverageType,
  type KnowledgeContext,
} from '../../src/engines/test-coverage-engine';

// ---- Minimal test framework (matches test-coverage-engine.test.ts) ----
let testCount = 0;
let passedCount = 0;
let failedCount = 0;

function describe(name: string, fn: () => void) {
  console.log(`\n${name}`);
  fn();
}

function it(name: string, fn: () => void) {
  testCount++;
  try {
    fn();
    passedCount++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failedCount++;
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
  }
}

function expect(value: any) {
  return {
    toBe(expected: any) {
      if (value !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(value)}`);
      }
    },
    toBeGreaterThan(expected: number) {
      if (value <= expected) {
        throw new Error(`Expected ${value} to be greater than ${expected}`);
      }
    },
    toBeGreaterThanOrEqual(expected: number) {
      if (value < expected) {
        throw new Error(`Expected ${value} to be >= ${expected}`);
      }
    },
  };
}

// estimateComplexity is pure; the engine just needs to construct.
process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';
const engine = new TestCoverageEngine();

// ============================================================================
// Tiers
// ============================================================================

describe('Adaptive Generation - FAST tier (small on every axis)', () => {
  it('classifies a tiny single-line requirement as FAST', () => {
    const input: RequirementInput = {
      title: 'Logout button',
      description: 'Clicking logout ends the session.',
    };
    const est = engine.estimateComplexity(input, ['positive'], undefined);
    expect(est.tier).toBe('FAST');
  });

  it('stays FAST for truly minimal requirements (1 type, 1 AC)', () => {
    const input: RequirementInput = {
      title: 'Logout button',
      description: 'User clicks logout and session ends.',
      acceptanceCriteria: 'Session is terminated',
    };
    const est = engine.estimateComplexity(input, ['positive'], undefined);
    expect(est.tier).toBe('FAST');
    expect(est.signals.acceptanceCriteriaCount).toBe(1);
    expect(est.signals.coverageTypeCount).toBe(1);
  });
});

describe('Adaptive Generation - STANDARD tier (medium)', () => {
  it('classifies a medium requirement (3 types + 3 AC) as STANDARD', () => {
    const input: RequirementInput = {
      title: 'Password reset flow',
      description: 'User requests a reset link by email and sets a new password.',
      acceptanceCriteria: 'AC1\nAC2\nAC3',
    };
    const est = engine.estimateComplexity(input, ['positive', 'negative', 'edge_cases'], undefined);
    expect(est.tier).toBe('STANDARD');
  });

  it('stays STANDARD when score is in the middle range (25-40)', () => {
    const input: RequirementInput = {
      title: 'Small req',
      description: 'Short.',
      acceptanceCriteria: 'AC1\nAC2', // 2 AC = 33% of cap (6) → 33 * 0.40 = 13.2
    };
    const est = engine.estimateComplexity(
      input,
      ['positive', 'negative'], // 2 types = 50% of cap (4) → 50 * 0.40 = 20
      undefined,
    );
    // Total ≈ 13.2 + 20 + minimal chars ≈ 33-35 → STANDARD
    expect(est.tier).toBe('STANDARD');
  });
});

describe('Adaptive Generation - COMPREHENSIVE tier (high score)', () => {
  it('escalates to COMPREHENSIVE on 9 coverage types (even small requirement)', () => {
    // This is the KEY scenario from the review: "Generate test cases for Login"
    // with 9 coverage types is objectively harder than a 1500-char req with 1 type.
    // The weighted scoring reflects the ACTUAL WORK requested (coverage types + AC),
    // not just verbose prose.
    const input: RequirementInput = {
      title: 'Generate test cases for Login',
      description: '',
    };
    const types: CoverageType[] = ['positive', 'negative', 'boundary', 'security', 'accessibility', 'performance', 'api', 'localization', 'cross_browser'];
    const est = engine.estimateComplexity(input, types, undefined);
    expect(est.tier).toBe('COMPREHENSIVE');
    expect(est.signals.coverageTypeCount).toBe(9);
    // With coverage weight = 0.40, 9 types (normalized to 100) → 40 points, hits threshold
    expect(est.signals.complexityScore).toBeGreaterThanOrEqual(40);
  });

  it('escalates to COMPREHENSIVE on high AC count (7+ criteria)', () => {
    const input: RequirementInput = {
      title: 'Auth',
      description: 'Login feature.',
      acceptanceCriteria: Array.from({ length: 7 }, (_, i) => `AC${i + 1}`).join('\n'),
    };
    const est = engine.estimateComplexity(input, ['positive'], undefined);
    expect(est.tier).toBe('COMPREHENSIVE');
    expect(est.signals.acceptanceCriteriaCount).toBe(7);
  });

  it('escalates to COMPREHENSIVE on combined signals (4 types + 4 AC)', () => {
    // This validates that the weighted composite works: neither signal alone
    // would hit COMPREHENSIVE, but together they do.
    const input: RequirementInput = {
      title: 'Checkout epic',
      description: 'Multi-step checkout flow with payment, shipping, tax.',
      acceptanceCriteria: Array.from({ length: 4 }, (_, i) => `AC${i + 1}`).join('\n'),
    };
    const est = engine.estimateComplexity(input, ['positive', 'negative', 'edge_cases', 'boundary'], undefined);
    expect(est.tier).toBe('COMPREHENSIVE');
    // 4 types (100%) * 0.40 = 40, 4 AC (67%) * 0.40 = 26.8, chars ~5 → 40+26.8+5 ≈ 72
  });
});

describe('Adaptive Generation - signal computation', () => {
  it('counts requirement chars across all text fields', () => {
    const input: RequirementInput = {
      title: 'abcde',          // 5
      description: 'fghij',    // 5
      acceptanceCriteria: 'k', // 1
      businessFlow: 'lm',      // 2
    };
    const est = engine.estimateComplexity(input, ['positive'], undefined);
    expect(est.signals.requirementChars).toBe(13);
  });

  it('counts business-flow steps split on newlines and sentence boundaries', () => {
    const input: RequirementInput = {
      title: 'Flow',
      description: 'A flow.',
      businessFlow: 'Step one. Step two. Step three.',
    };
    const est = engine.estimateComplexity(input, ['positive'], undefined);
    expect(est.signals.businessFlowSteps).toBe(3);
  });

  it('always returns a non-empty human-readable reason', () => {
    const input: RequirementInput = { title: 'x', description: 'y' };
    const est = engine.estimateComplexity(input, ['positive'], undefined);
    expect(est.reason.length).toBeGreaterThan(0);
  });

  it('records complexityScore in signals for telemetry', () => {
    const input: RequirementInput = { title: 'x', description: 'y' };
    const est = engine.estimateComplexity(input, ['positive'], undefined);
    expect(est.signals.complexityScore).toBeGreaterThanOrEqual(0);
  });
});

// ============================================================================
// Summary
// ============================================================================
console.log(`\n${'='.repeat(60)}`);
console.log(`Tests: ${testCount} | Passed: ${passedCount} | Failed: ${failedCount}`);
console.log('='.repeat(60));
if (failedCount > 0) process.exit(1);
