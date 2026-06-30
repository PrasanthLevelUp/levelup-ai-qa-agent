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

  it('stays FAST at the small boundary (3 AC, 2 types, 1 source)', () => {
    const input: RequirementInput = {
      title: 'Toggle',
      description: 'A small toggle.',
      acceptanceCriteria: 'AC1\nAC2\nAC3',
    };
    const knowledge: KnowledgeContext = { modules: [{ name: 'm', workflows: '', businessRules: '', apis: '' }] } as any;
    const est = engine.estimateComplexity(input, ['positive', 'negative'], knowledge);
    expect(est.tier).toBe('FAST');
    expect(est.signals.acceptanceCriteriaCount).toBe(3);
    expect(est.signals.coverageTypeCount).toBe(2);
    expect(est.signals.intelligenceSourceCount).toBe(1);
  });
});

describe('Adaptive Generation - STANDARD tier (medium)', () => {
  it('classifies a medium requirement (4 types) as STANDARD', () => {
    const input: RequirementInput = {
      title: 'Password reset flow',
      description: 'User requests a reset link by email and sets a new password. '.repeat(8),
      acceptanceCriteria: 'AC1\nAC2\nAC3\nAC4\nAC5',
    };
    const est = engine.estimateComplexity(input, ['positive', 'negative', 'edge_cases', 'boundary'], undefined);
    expect(est.tier).toBe('STANDARD');
  });

  it('escalates above FAST when 4 coverage types are requested', () => {
    const input: RequirementInput = {
      title: 'Small req',
      description: 'Short.',
    };
    const est = engine.estimateComplexity(
      input,
      ['positive', 'negative', 'edge_cases', 'boundary'],
      undefined,
    );
    // 4 types > FAST cap of 2, but < COMPREHENSIVE trigger of 6 → STANDARD
    expect(est.tier).toBe('STANDARD');
  });
});

describe('Adaptive Generation - COMPREHENSIVE tier (any heavy signal)', () => {
  it('classifies a long requirement (>1500 chars) as COMPREHENSIVE', () => {
    const input: RequirementInput = {
      title: 'Checkout epic',
      description: 'x'.repeat(1600),
    };
    const est = engine.estimateComplexity(input, ['positive'], undefined);
    expect(est.tier).toBe('COMPREHENSIVE');
  });

  it('escalates to COMPREHENSIVE on 9+ acceptance criteria', () => {
    const input: RequirementInput = {
      title: 'Auth',
      description: 'Login feature.',
      acceptanceCriteria: Array.from({ length: 9 }, (_, i) => `AC${i + 1}`).join('\n'),
    };
    const est = engine.estimateComplexity(input, ['positive'], undefined);
    expect(est.tier).toBe('COMPREHENSIVE');
    expect(est.signals.acceptanceCriteriaCount).toBeGreaterThanOrEqual(9);
  });

  it('escalates to COMPREHENSIVE on 6+ coverage types', () => {
    const input: RequirementInput = {
      title: 'Auth',
      description: 'Login feature.',
    };
    const types: CoverageType[] = ['positive', 'negative', 'edge_cases', 'boundary', 'security', 'api'];
    const est = engine.estimateComplexity(input, types, undefined);
    expect(est.tier).toBe('COMPREHENSIVE');
  });

  it('escalates to COMPREHENSIVE on 3+ intelligence sources', () => {
    const input: RequirementInput = {
      title: 'Auth',
      description: 'Login feature.',
    };
    const knowledge: KnowledgeContext = {
      modules: [{ name: 'm', workflows: '', businessRules: '', apis: '' }],
      enterpriseKnowledge: [{ title: 't', content: 'c' }],
      applicationProfile: { summary: 's' },
    } as any;
    const est = engine.estimateComplexity(input, ['positive'], knowledge);
    expect(est.tier).toBe('COMPREHENSIVE');
    expect(est.signals.intelligenceSourceCount).toBeGreaterThanOrEqual(3);
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
});

// ============================================================================
// Summary
// ============================================================================
console.log(`\n${'='.repeat(60)}`);
console.log(`Tests: ${testCount} | Passed: ${passedCount} | Failed: ${failedCount}`);
console.log('='.repeat(60));
if (failedCount > 0) process.exit(1);
