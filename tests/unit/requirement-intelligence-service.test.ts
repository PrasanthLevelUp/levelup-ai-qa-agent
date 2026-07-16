/**
 * Sprint RIF — Requirement Intelligence Service.
 *
 * The service composes the Coverage Engine (the FACT) and the Generation Policy
 * (the DECISION) into ONE RequirementIntelligence object so consumers never
 * orchestrate the engines themselves. These tests exercise it end-to-end over
 * hand-built Coverage Models:
 *
 *     COVERED requirement  → generation SKIP
 *     PARTIAL requirement  → generation EXTEND
 *     MISSING requirement  → generation GENERATE
 *
 * plus: the returned object echoes the requirement and carries the coverage;
 * an injected custom policy is honored; results are deterministic. Fully pure —
 * NO LLM, NO DB, NO UI.
 */

import { RequirementIntelligenceService } from '../../src/requirement-intelligence/requirement-intelligence-service';
import type { GenerationPolicy } from '../../src/requirement-intelligence/generation-policy';
import { GenerationDecision } from '../../src/coverage-intelligence/types';
import type { RequirementInput } from '../../src/requirement-coverage/types';
import type { CoverageModel } from '../../src/context/types';

function model(partial: Partial<CoverageModel> & { feature: string }): CoverageModel {
  return {
    feature: partial.feature,
    flows: partial.flows || [],
    pageObjects: partial.pageObjects || [],
    helpers: partial.helpers || [],
    assertions: partial.assertions || [],
    testFiles: partial.testFiles || [],
    testCount: partial.testCount ?? (partial.flows ? partial.flows.length : 0),
    browsers: partial.browsers || [],
    apiCalls: partial.apiCalls || [],
  };
}

const AUTH = model({
  feature: 'Authentication',
  flows: [
    { name: 'valid user can sign in', testCount: 1, testFiles: ['tests/auth.spec.ts'], assertions: ['toHaveURL'] },
    { name: 'locked out user sees error', testCount: 1, testFiles: ['tests/auth.spec.ts'], assertions: ['toBeVisible'] },
  ],
  pageObjects: ['Login'],
  helpers: ['LoginPage.login'],
  assertions: ['toHaveURL', 'toBeVisible'],
  testFiles: ['tests/auth.spec.ts'],
  testCount: 2,
});

const MODELS: CoverageModel[] = [AUTH];

describe('RequirementIntelligenceService (RIF)', () => {
  const service = new RequirementIntelligenceService();

  it('composes a COVERED requirement into generation SKIP', () => {
    const req: RequirementInput = {
      id: 'REQ-1',
      title: 'User authentication',
      feature: 'Authentication',
      expectedFlows: ['valid user can sign in', 'locked out user sees error'],
    };
    const intel = service.analyze(req, MODELS);
    expect(intel.coverage.status).toBe('COVERED');
    expect(intel.generation).toBe(GenerationDecision.SKIP);
    // A confident, fully-covered requirement is skipped with no override reasons.
    expect(intel.generationReasons).toEqual([]);
  });

  it('composes a PARTIAL requirement into generation EXTEND', () => {
    const req: RequirementInput = {
      id: 'REQ-2',
      title: 'User authentication',
      feature: 'Authentication',
      expectedFlows: ['valid user can sign in', 'reset password via email'],
    };
    const intel = service.analyze(req, MODELS);
    expect(intel.coverage.status).toBe('PARTIAL');
    expect(intel.generation).toBe(GenerationDecision.EXTEND);
  });

  it('composes a MISSING requirement into generation GENERATE', () => {
    const req: RequirementInput = {
      id: 'REQ-3',
      title: 'Payment refund processing',
      feature: 'Payments',
      expectedFlows: ['refund a completed payment'],
    };
    const intel = service.analyze(req, MODELS);
    expect(intel.coverage.status).toBe('MISSING');
    expect(intel.generation).toBe(GenerationDecision.GENERATE);
  });

  it('returns the requirement and the full coverage alongside the decision', () => {
    const req: RequirementInput = {
      id: 'REQ-1',
      title: 'User authentication',
      feature: 'Authentication',
      expectedFlows: ['valid user can sign in', 'locked out user sees error'],
    };
    const intel = service.analyze(req, MODELS);
    expect(intel.requirement).toBe(req);
    expect(intel.coverage.requirementId).toBe('REQ-1');
    expect(intel.coverage).toHaveProperty('coveredFlows');
    expect(intel.coverage).toHaveProperty('matches');
    // reuse/risk are reserved for future brains — not populated today.
    expect(intel.reuse).toBeUndefined();
    expect(intel.risk).toBeUndefined();
  });

  it('honors an injected custom policy over the default', () => {
    // A policy that always SKIPs, regardless of the (MISSING) coverage.
    const alwaysSkip: GenerationPolicy = { decide: () => ({ decision: GenerationDecision.SKIP, reasons: [] }) };
    const custom = new RequirementIntelligenceService(alwaysSkip);
    const req: RequirementInput = {
      id: 'REQ-3',
      title: 'Payment refund processing',
      feature: 'Payments',
      expectedFlows: ['refund a completed payment'],
    };
    const intel = custom.analyze(req, MODELS);
    expect(intel.coverage.status).toBe('MISSING'); // coverage is unchanged (a fact)
    expect(intel.generation).toBe(GenerationDecision.SKIP); // policy overrode the routing
  });

  it('forwards the policy\'s override reasons as generationReasons', () => {
    // A low-confidence downgrade: the policy returns EXTEND + ['Low confidence'];
    // the service must forward those reasons untouched (it never re-derives them).
    const downgrade: GenerationPolicy = {
      decide: () => ({ decision: GenerationDecision.EXTEND, reasons: ['Low confidence'] }),
    };
    const custom = new RequirementIntelligenceService(downgrade);
    const req: RequirementInput = {
      id: 'REQ-1',
      title: 'User authentication',
      feature: 'Authentication',
      expectedFlows: ['valid user can sign in', 'locked out user sees error'],
    };
    const intel = custom.analyze(req, MODELS);
    expect(intel.coverage.status).toBe('COVERED'); // coverage is unchanged (a fact)
    expect(intel.generation).toBe(GenerationDecision.EXTEND); // policy downgraded it
    expect(intel.generationReasons).toEqual(['Low confidence']);
  });

  it('is deterministic — the same inputs always yield the same intelligence', () => {
    const req: RequirementInput = {
      id: 'REQ-1',
      title: 'User authentication',
      feature: 'Authentication',
      expectedFlows: ['valid user can sign in', 'locked out user sees error'],
    };
    const a = service.analyze(req, MODELS);
    const b = service.analyze(req, MODELS);
    expect(a.generation).toBe(b.generation);
    expect(a.coverage.status).toBe(b.coverage.status);
    expect(a.coverage.coverage).toBe(b.coverage.coverage);
  });
});
