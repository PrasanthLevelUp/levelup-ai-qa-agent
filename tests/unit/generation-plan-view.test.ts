/**
 * Generation Plan view — the customer-facing presentation adapter.
 *
 * These tests pin the render-ready plan the "Generation Plan" screen consumes:
 * decision echo, covered vs missing flows, the repo assets already associated
 * with covered flows, the "Repository Assets Reused" section, the savings
 * comparison card, and the customer "Decision" narrative (which answers "what
 * is the plan?" — never "why"). Pure — no engine, no DB, no I/O.
 */

import { buildGenerationPlanView } from '../../src/requirement-intelligence/generation-plan-view';
import {
  ScriptGenerationConsumer,
  ESTIMATED_TOKENS_PER_FLOW,
} from '../../src/requirement-intelligence/script-generation-consumer';
import { GenerationDecision } from '../../src/coverage-intelligence/types';
import type { RequirementIntelligence } from '../../src/requirement-intelligence/types';
import type { RequirementCoverage, RequirementInput } from '../../src/requirement-coverage/types';
import type { CoverageModel } from '../../src/context/types';

function intel(
  generation: GenerationDecision,
  coverage: Partial<RequirementCoverage> & { status: RequirementCoverage['status'] },
  generationReasons: string[] = [],
): RequirementIntelligence {
  const requirement: RequirementInput = { id: coverage.requirementId ?? 'REQ-1', title: 'Login' };
  const fullCoverage: RequirementCoverage = {
    requirementId: coverage.requirementId ?? 'REQ-1',
    status: coverage.status,
    coverage: coverage.coverage ?? 0,
    coveredFlows: coverage.coveredFlows ?? (coverage.coveredSlices ?? []).map((s) => s.flow),
    missingFlows: coverage.missingFlows ?? (coverage.missingSlices ?? []).map((s) => s.flow),
    coveredSlices: coverage.coveredSlices ?? [],
    missingSlices: coverage.missingSlices ?? [],
    confidence: coverage.confidence ?? 100,
    matchedFeature: coverage.matchedFeature ?? null,
    matches: coverage.matches ?? [],
  };
  return { requirement, coverage: fullCoverage, generation, generationReasons };
}

const AUTH_MODEL: CoverageModel[] = [
  {
    feature: 'Authentication',
    flows: [
      { name: 'Login Success', testCount: 2, testFiles: ['login.spec.ts'], assertions: ['toBeVisible'] },
      { name: 'Login Failure', testCount: 1, testFiles: ['login-negative.spec.ts'], assertions: ['toHaveText'] },
    ],
    pageObjects: ['LoginPage.login()'],
    helpers: ['AuthHelper.login()'],
    assertions: ['toBeVisible', 'toHaveText'],
    testFiles: ['login.spec.ts', 'login-negative.spec.ts'],
    testCount: 3,
    browsers: [],
    apiCalls: [],
  },
];

describe('buildGenerationPlanView — EXTEND (partial coverage)', () => {
  const intelligence = intel(GenerationDecision.EXTEND, {
    requirementId: 'REQ-1',
    status: 'PARTIAL',
    coverage: 67,
    confidence: 91,
    matchedFeature: 'Authentication',
    coveredSlices: [
      { flow: 'Login Success', testCaseIds: ['TC-1'] },
      { flow: 'Login Failure', testCaseIds: ['TC-2'] },
    ],
    missingSlices: [{ flow: 'Locked User', testCaseIds: ['TC-3'] }],
    matches: [
      { behavior: 'Login Success', level: 'FLOW', matchedFlow: 'Login Success', score: 1 },
      { behavior: 'Login Failure', level: 'FLOW', matchedFlow: 'Login Failure', score: 1 },
      { behavior: 'Locked User', level: 'NONE', matchedFlow: null, score: 0 },
    ],
  });
  const plan = new ScriptGenerationConsumer().plan(intelligence);
  const view = buildGenerationPlanView(plan, intelligence, AUTH_MODEL);

  it('echoes the frozen decision and coverage headline', () => {
    expect(view.decision).toBe(GenerationDecision.EXTEND);
    expect(view.repositoryCoverage).toBe(67);
    expect(view.confidence).toBe(91);
  });

  it('lists covered flows with their repository assets', () => {
    expect(view.existingAutomation).toEqual([
      { flow: 'Login Success', assets: ['login.spec.ts'] },
      { flow: 'Login Failure', assets: ['login-negative.spec.ts'] },
    ]);
  });

  it('lists the missing flows to generate (no assets yet)', () => {
    expect(view.toGenerate).toEqual([{ flow: 'Locked User', assets: [] }]);
  });

  it('surfaces reused page objects + helpers', () => {
    expect(view.assetsReused).toEqual(['LoginPage.login()', 'AuthHelper.login()']);
  });

  it('computes the savings comparison (generate 1 of 3 flows)', () => {
    expect(view.comparison.withoutIntelligence).toEqual({
      scripts: 3,
      estimatedTokens: 3 * ESTIMATED_TOKENS_PER_FLOW,
    });
    expect(view.comparison.withIntelligence).toEqual({
      scripts: 1,
      estimatedTokens: 1 * ESTIMATED_TOKENS_PER_FLOW,
    });
    expect(view.comparison.reductionPercent).toBe(67);
    expect(view.estimatedTokenSavings).toBe(2 * ESTIMATED_TOKENS_PER_FLOW);
  });

  it('narrates the plan (what), not the reason (why)', () => {
    expect(view.decisionNarrative).toContain('2 of 3');
    expect(view.decisionNarrative).not.toMatch(/why/i);
  });
});

describe('buildGenerationPlanView — SKIP (fully covered)', () => {
  const intelligence = intel(GenerationDecision.SKIP, {
    requirementId: 'REQ-2',
    status: 'COVERED',
    coverage: 100,
    confidence: 95,
    matchedFeature: 'Authentication',
    coveredSlices: [
      { flow: 'Login Success', testCaseIds: ['TC-1'] },
      { flow: 'Login Failure', testCaseIds: ['TC-2'] },
    ],
    missingSlices: [],
    matches: [
      { behavior: 'Login Success', level: 'FLOW', matchedFlow: 'Login Success', score: 1 },
      { behavior: 'Login Failure', level: 'FLOW', matchedFlow: 'Login Failure', score: 1 },
    ],
  });
  const plan = new ScriptGenerationConsumer().plan(intelligence);
  const view = buildGenerationPlanView(plan, intelligence, AUTH_MODEL);

  it('generates nothing and saves every flow', () => {
    expect(view.decision).toBe(GenerationDecision.SKIP);
    expect(view.toGenerate).toEqual([]);
    expect(view.comparison.withIntelligence.scripts).toBe(0);
    expect(view.savingsPercent).toBe(100);
  });
});

describe('buildGenerationPlanView — GENERATE (no coverage / no model)', () => {
  const intelligence = intel(GenerationDecision.GENERATE, {
    requirementId: 'REQ-3',
    status: 'MISSING',
    coverage: 0,
    confidence: 80,
    missingSlices: [
      { flow: 'Login Success', testCaseIds: ['TC-1'] },
      { flow: 'Locked User', testCaseIds: ['TC-2'] },
    ],
  });
  const plan = new ScriptGenerationConsumer().plan(intelligence);
  const view = buildGenerationPlanView(plan, intelligence, []);

  it('reports no reuse and generates everything', () => {
    expect(view.decision).toBe(GenerationDecision.GENERATE);
    expect(view.existingAutomation).toEqual([]);
    expect(view.assetsReused).toEqual([]);
    expect(view.toGenerate.map((f) => f.flow)).toEqual(['Login Success', 'Locked User']);
    expect(view.hasCoverageModel).toBe(false);
    expect(view.estimatedTokenSavings).toBe(0);
  });
});
