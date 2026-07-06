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
    toBeLessThan(expected: number) {
      if (value >= expected) {
        throw new Error(`Expected ${value} to be less than ${expected}`);
      }
    },
    not: {
      toBe(expected: any) {
        if (value === expected) {
          throw new Error(`Expected value NOT to be ${JSON.stringify(expected)}`);
        }
      },
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

describe('Adaptive Generation - intent vs. complexity (KEY philosophy)', () => {
  it('does NOT escalate a tiny requirement to COMPREHENSIVE just because many coverage types are selected', () => {
    // The review scenario: "Generate test cases for Login" with 9 coverage types.
    // Coverage-type count expresses USER INTENT, not intrinsic complexity. A one-line
    // requirement must stay cheap regardless of how many types are ticked — coverage
    // only carries a 0.10 weight, so it can nudge but never dominate the tier.
    const input: RequirementInput = {
      title: 'Generate test cases for Login',
      description: '',
    };
    const types: CoverageType[] = ['positive', 'negative', 'boundary', 'security', 'accessibility', 'performance', 'api', 'localization', 'cross_browser'];
    const est = engine.estimateComplexity(input, types, undefined);
    expect(est.tier).not.toBe('COMPREHENSIVE');
    expect(est.tier).toBe('FAST');
    expect(est.signals.coverageTypeCount).toBe(9);
    // Even at the cap, coverage contributes only 0.10 * 100 = 10 points.
    expect(est.signals.complexityScore).toBeLessThan(25);
  });

  it('classifies a simple "User Login" (default 3 types) as FAST', () => {
    const input: RequirementInput = {
      title: 'User Login',
      description: 'User logs in with email and password.',
    };
    const est = engine.estimateComplexity(input, ['positive', 'negative', 'edge_cases'], undefined);
    expect(est.tier).toBe('FAST');
    expect(est.signals.complexityScore).toBeLessThan(25);
  });
});

describe('Adaptive Generation - STANDARD tier (medium, size-driven)', () => {
  it('classifies a realistic single-feature login (fuller prose + 3 AC + grounding) as STANDARD', () => {
    // ~287 chars of real prose, 3 acceptance criteria, three intelligence sources.
    // Size + AC density carry the score into the STANDARD band (25-45).
    const input: RequirementInput = {
      title: 'User Login',
      description:
        'As a registered user, I can log in with my email and password so that I can access my account. Invalid credentials show an error. After 5 failed attempts the account is locked for 15 minutes.',
      acceptanceCriteria: 'Valid credentials log in\nInvalid credentials show error\nAccount locks after 5 attempts',
    };
    const knowledge: KnowledgeContext = {
      applicationProfile: {} as any,
      testData: [{}] as any,
      modules: [{}] as any,
    };
    const est = engine.estimateComplexity(input, ['positive', 'negative', 'edge_cases'], knowledge);
    expect(est.tier).toBe('STANDARD');
    expect(est.signals.complexityScore).toBeGreaterThanOrEqual(25);
    expect(est.signals.complexityScore).toBeLessThan(45);
  });

  it('classifies a medium password-reset requirement (fuller prose + 4 AC) as STANDARD', () => {
    const input: RequirementInput = {
      title: 'Password reset flow',
      description:
        'User requests a password reset link via email, clicks the emailed link, and sets a new password. The link expires after 24 hours and can only be used once. Password must meet complexity rules.',
      acceptanceCriteria: 'AC1\nAC2\nAC3\nAC4',
    };
    const est = engine.estimateComplexity(input, ['positive', 'negative', 'edge_cases'], undefined);
    expect(est.tier).toBe('STANDARD');
    expect(est.signals.complexityScore).toBeGreaterThanOrEqual(25);
    expect(est.signals.complexityScore).toBeLessThan(45);
  });
});

describe('Adaptive Generation - COMPREHENSIVE tier (genuinely large requirements)', () => {
  it('escalates a detailed multi-step checkout flow (long prose + 6 AC + 6 flow steps)', () => {
    // COMPREHENSIVE now requires real testable surface: lots of prose, many AC,
    // and a multi-step business flow — NOT just many coverage types.
    const input: RequirementInput = {
      title: 'Checkout flow',
      description:
        'Multi-step checkout: cart review, shipping address entry, shipping method selection, payment via card or wallet, tax calculation, order confirmation, and email receipt. Handles out-of-stock, expired cards, and promo codes.'.repeat(3),
      acceptanceCriteria: Array.from({ length: 6 }, (_, i) => `AC${i + 1} detailed criteria text here`).join('\n'),
      businessFlow: 'Review cart. Enter shipping. Choose method. Enter payment. Confirm order. Receive receipt.',
    };
    const est = engine.estimateComplexity(input, ['positive', 'negative', 'edge_cases', 'boundary'], undefined);
    expect(est.tier).toBe('COMPREHENSIVE');
    expect(est.signals.complexityScore).toBeGreaterThanOrEqual(45);
  });

  it('escalates an epic requirement (1500+ chars, 8 AC, 6 flow steps)', () => {
    const input: RequirementInput = {
      title: 'Insurance claim processing epic',
      description: 'x'.repeat(1500),
      acceptanceCriteria: Array.from({ length: 8 }, (_, i) => `AC${i + 1}`).join('\n'),
      businessFlow: Array.from({ length: 6 }, (_, i) => `Step ${i + 1}`).join('\n'),
    };
    const est = engine.estimateComplexity(input, ['positive', 'negative', 'edge_cases', 'boundary', 'security'], undefined);
    expect(est.tier).toBe('COMPREHENSIVE');
    expect(est.signals.acceptanceCriteriaCount).toBe(8);
    expect(est.signals.complexityScore).toBeGreaterThanOrEqual(45);
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
