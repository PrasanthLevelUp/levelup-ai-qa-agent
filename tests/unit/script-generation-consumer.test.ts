/**
 * Sprint RIF — Script Generation Consumer.
 *
 * The consumer turns a RequirementIntelligence into a deterministic plan the
 * route acts on: SKIP (don't call the engine), EXTEND (call with only the
 * missing test cases, sliced by id), or GENERATE (call with everything). It
 * also emits decision telemetry. These tests pin all three paths, the EXTEND
 * slicing, the unbound-EXTEND fallback, token-savings estimates, and
 * determinism. Pure — no engine, no DB, no I/O.
 */

import {
  ScriptGenerationConsumer,
  ESTIMATED_TOKENS_PER_FLOW,
} from '../../src/requirement-intelligence/script-generation-consumer';
import { GenerationDecision } from '../../src/coverage-intelligence/types';
import type { RequirementIntelligence } from '../../src/requirement-intelligence/types';
import type { RequirementCoverage, RequirementInput } from '../../src/requirement-coverage/types';

function intel(
  generation: GenerationDecision,
  coverage: Partial<RequirementCoverage> & { status: RequirementCoverage['status'] },
): RequirementIntelligence {
  const requirement: RequirementInput = { id: coverage.requirementId ?? 'REQ-1', title: 'A requirement' };
  const fullCoverage: RequirementCoverage = {
    requirementId: coverage.requirementId ?? 'REQ-1',
    status: coverage.status,
    coverage: coverage.coverage ?? 0,
    coveredFlows: coverage.coveredFlows ?? (coverage.coveredSlices ?? []).map(s => s.flow),
    missingFlows: coverage.missingFlows ?? (coverage.missingSlices ?? []).map(s => s.flow),
    coveredSlices: coverage.coveredSlices ?? [],
    missingSlices: coverage.missingSlices ?? [],
    confidence: coverage.confidence ?? 100,
    matchedFeature: coverage.matchedFeature ?? null,
    matches: coverage.matches ?? [],
  };
  return { requirement, coverage: fullCoverage, generation };
}

const consumer = new ScriptGenerationConsumer();

describe('ScriptGenerationConsumer — SKIP (RIF)', () => {
  const plan = consumer.plan(
    intel(GenerationDecision.SKIP, {
      requirementId: 'REQ-1',
      status: 'COVERED',
      coverage: 100,
      coveredSlices: [
        { flow: 'login success', testCaseIds: ['TC-1'] },
        { flow: 'login failure', testCaseIds: ['TC-2'] },
      ],
      missingSlices: [],
    }),
  );

  it('does not call the engine and generates nothing', () => {
    expect(plan.decision).toBe(GenerationDecision.SKIP);
    expect(plan.shouldGenerate).toBe(false);
    expect(plan.testCaseIdsToGenerate).toEqual([]);
  });

  it('counts every flow as skipped and estimates savings for all of them', () => {
    expect(plan.telemetry.flowsTotal).toBe(2);
    expect(plan.telemetry.flowsSkipped).toBe(2);
    expect(plan.telemetry.flowsGenerated).toBe(0);
    expect(plan.telemetry.estimatedTokenSavings).toBe(2 * ESTIMATED_TOKENS_PER_FLOW);
    expect(plan.telemetry.coverageStatus).toBe('COVERED');
    expect(plan.telemetry.repositoryCoverage).toBe(100);
  });
});

describe('ScriptGenerationConsumer — EXTEND (RIF)', () => {
  const plan = consumer.plan(
    intel(GenerationDecision.EXTEND, {
      requirementId: 'REQ-2',
      status: 'PARTIAL',
      coverage: 67,
      coveredSlices: [
        { flow: 'login success', testCaseIds: ['TC-1'] },
        { flow: 'login failure', testCaseIds: ['TC-2'] },
      ],
      missingSlices: [{ flow: 'locked user', testCaseIds: ['TC-3'] }],
    }),
  );

  it('calls the engine with ONLY the missing flows\' test case ids (sliced by id)', () => {
    expect(plan.decision).toBe(GenerationDecision.EXTEND);
    expect(plan.shouldGenerate).toBe(true);
    expect(plan.testCaseIdsToGenerate).toEqual(['TC-3']);
    expect(plan.warnings).toEqual([]);
  });

  it('reports covered flows as skipped and estimates savings for them', () => {
    expect(plan.telemetry.flowsTotal).toBe(3);
    expect(plan.telemetry.flowsSkipped).toBe(2);
    expect(plan.telemetry.flowsGenerated).toBe(1);
    expect(plan.telemetry.estimatedTokenSavings).toBe(2 * ESTIMATED_TOKENS_PER_FLOW);
  });

  it('de-dupes ids across multiple missing slices, preserving order', () => {
    const p = consumer.plan(
      intel(GenerationDecision.EXTEND, {
        status: 'PARTIAL',
        coverage: 40,
        coveredSlices: [{ flow: 'a', testCaseIds: ['TC-1'] }],
        missingSlices: [
          { flow: 'b', testCaseIds: ['TC-2', 'TC-3'] },
          { flow: 'c', testCaseIds: ['TC-3', 'TC-4'] },
        ],
      }),
    );
    expect(p.testCaseIdsToGenerate).toEqual(['TC-2', 'TC-3', 'TC-4']);
  });

  it('falls back to generating ALL (with a warning, no savings claimed) when missing slices carry no ids', () => {
    const p = consumer.plan(
      intel(GenerationDecision.EXTEND, {
        status: 'PARTIAL',
        coverage: 50,
        coveredSlices: [{ flow: 'a', testCaseIds: [] }],
        missingSlices: [{ flow: 'b', testCaseIds: [] }],
      }),
    );
    expect(p.shouldGenerate).toBe(true);
    expect(p.testCaseIdsToGenerate).toBeNull(); // null = generate all
    expect(p.warnings).toHaveLength(1);
    expect(p.warnings[0]).toMatch(/cannot slice/i);
    expect(p.telemetry.estimatedTokenSavings).toBe(0);
  });
});

describe('ScriptGenerationConsumer — GENERATE (RIF)', () => {
  const plan = consumer.plan(
    intel(GenerationDecision.GENERATE, {
      requirementId: 'REQ-3',
      status: 'MISSING',
      coverage: 0,
      coveredSlices: [],
      missingSlices: [
        { flow: 'checkout', testCaseIds: ['TC-9'] },
        { flow: 'refund', testCaseIds: ['TC-10'] },
      ],
    }),
  );

  it('generates everything (null = all) and claims no savings', () => {
    expect(plan.decision).toBe(GenerationDecision.GENERATE);
    expect(plan.shouldGenerate).toBe(true);
    expect(plan.testCaseIdsToGenerate).toBeNull();
    expect(plan.telemetry.flowsTotal).toBe(2);
    expect(plan.telemetry.flowsSkipped).toBe(0);
    expect(plan.telemetry.flowsGenerated).toBe(2);
    expect(plan.telemetry.estimatedTokenSavings).toBe(0);
  });
});

describe('ScriptGenerationConsumer — configuration & determinism (RIF)', () => {
  it('honors a custom per-flow token estimate', () => {
    const c = new ScriptGenerationConsumer(500);
    const p = c.plan(
      intel(GenerationDecision.SKIP, {
        status: 'COVERED',
        coverage: 100,
        coveredSlices: [{ flow: 'x', testCaseIds: ['TC-1'] }],
        missingSlices: [],
      }),
    );
    expect(p.telemetry.estimatedTokenSavings).toBe(500);
  });

  it('is deterministic — the same intelligence yields an identical plan', () => {
    const input = intel(GenerationDecision.EXTEND, {
      status: 'PARTIAL',
      coverage: 67,
      coveredSlices: [{ flow: 'a', testCaseIds: ['TC-1'] }],
      missingSlices: [{ flow: 'b', testCaseIds: ['TC-2'] }],
    });
    expect(JSON.stringify(consumer.plan(input))).toBe(JSON.stringify(consumer.plan(input)));
  });
});
