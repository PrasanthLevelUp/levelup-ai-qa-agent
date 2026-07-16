/**
 * Sprint RCI-2 — Requirement Coverage Engine.
 *
 * Pure unit tests over hand-built Coverage Models. The engine compares a single
 * requirement against the models and reports COVERED / PARTIAL / MISSING with
 * covered/missing behaviors and a confidence. Fully deterministic — NO LLM, NO
 * embeddings, NO DB, NO UI.
 */

import { assessRequirementCoverage } from '../../src/requirement-coverage/requirement-coverage-engine';
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

const CHECKOUT = model({
  feature: 'Checkout',
  flows: [
    { name: 'complete purchase', testCount: 1, testFiles: ['tests/checkout.spec.ts'], assertions: ['toHaveURL'] },
  ],
  pageObjects: ['Cart'],
  assertions: ['toHaveURL'],
  testFiles: ['tests/checkout.spec.ts'],
  testCount: 1,
});

const MODELS = [AUTH, CHECKOUT];

describe('Requirement Coverage Engine (RCI-2)', () => {
  it('reports COVERED when every expected behavior matches a covered flow', () => {
    const req: RequirementInput = {
      id: 'REQ-1',
      title: 'User authentication',
      feature: 'Authentication',
      expectedFlows: ['valid user can sign in', 'locked out user sees error'],
    };
    const res = assessRequirementCoverage(req, MODELS);
    expect(res.status).toBe('COVERED');
    expect(res.coverage).toBe(100);
    expect(res.missingFlows).toEqual([]);
    expect(res.coveredFlows).toHaveLength(2);
    expect(res.matchedFeature).toBe('Authentication');
    expect(res.matches.every(m => m.level === 'FLOW')).toBe(true);
    expect(res.confidence).toBeGreaterThanOrEqual(90);
  });

  it('reports PARTIAL when only some expected behaviors are covered', () => {
    const req: RequirementInput = {
      id: 'REQ-2',
      title: 'Authentication',
      feature: 'Authentication',
      expectedFlows: ['valid user can sign in', 'password reset via email'],
    };
    const res = assessRequirementCoverage(req, MODELS);
    expect(res.status).toBe('PARTIAL');
    expect(res.coverage).toBe(50);
    expect(res.coveredFlows).toEqual(['valid user can sign in']);
    expect(res.missingFlows).toEqual(['password reset via email']);
  });

  it('reports MISSING for a requirement unrelated to anything covered', () => {
    const req: RequirementInput = {
      id: 'REQ-3',
      title: 'Refund a completed order to the original payment method',
      feature: 'Refunds',
      expectedFlows: ['issue refund to card'],
    };
    const res = assessRequirementCoverage(req, MODELS);
    expect(res.status).toBe('MISSING');
    expect(res.coverage).toBe(0);
    expect(res.coveredFlows).toEqual([]);
    expect(res.missingFlows).toEqual(['issue refund to card']);
    // no candidate model → high-confidence missing
    expect(res.matchedFeature).toBeNull();
    expect(res.confidence).toBeGreaterThanOrEqual(80);
  });

  it('matches via business-action synonyms ("sign in" ~ "login")', () => {
    const req: RequirementInput = {
      id: 'REQ-4',
      title: 'Login',
      feature: 'Authentication',
      // phrased differently from the flow name; should resolve via action synonyms
      expectedFlows: ['user can log in with valid credentials'],
    };
    const res = assessRequirementCoverage(req, MODELS);
    expect(res.status).toBe('COVERED');
    // either a direct flow match or a business-action match is acceptable,
    // but it must NOT fall all the way down to keyword-only.
    expect(['FLOW', 'BUSINESS_ACTION']).toContain(res.matches[0].level);
    expect(res.confidence).toBeGreaterThanOrEqual(90);
  });

  it('falls back to keyword overlap only as a last resort', () => {
    const req: RequirementInput = {
      id: 'REQ-5',
      title: 'purchase',
      feature: 'Checkout',
      expectedFlows: ['complete the purchase journey'],
    };
    const res = assessRequirementCoverage(req, MODELS);
    expect(res.status).toBe('COVERED');
    expect(res.matchedFeature).toBe('Checkout');
    // matched somewhere on the ladder, not NONE
    expect(res.matches[0].level).not.toBe('NONE');
  });

  it('uses the title as the single behavior when no expectedFlows given', () => {
    const req: RequirementInput = {
      id: 'REQ-6',
      title: 'valid user can sign in',
      feature: 'Authentication',
    };
    const res = assessRequirementCoverage(req, MODELS);
    expect(res.matches).toHaveLength(1);
    expect(res.status).toBe('COVERED');
  });

  it('returns MISSING with no crash when there are no models at all', () => {
    const req: RequirementInput = {
      id: 'REQ-7',
      title: 'anything',
      expectedFlows: ['do a thing'],
    };
    const res = assessRequirementCoverage(req, []);
    expect(res.status).toBe('MISSING');
    expect(res.coverage).toBe(0);
    expect(res.matchedFeature).toBeNull();
  });

  it('is deterministic — same input yields identical output', () => {
    const req: RequirementInput = {
      id: 'REQ-8',
      title: 'Authentication',
      feature: 'Authentication',
      expectedFlows: ['valid user can sign in', 'password reset via email'],
    };
    const a = JSON.stringify(assessRequirementCoverage(req, MODELS));
    const b = JSON.stringify(assessRequirementCoverage(req, MODELS));
    expect(a).toBe(b);
  });
});
