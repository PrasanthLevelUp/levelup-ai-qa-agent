/**
 * Sprint 6.x — Standard Coverage (planner Phase 3b): balanced-by-default.
 *
 * The founder's bug: selecting Positive + Negative + Edge for a CRUD requirement
 * with Deep Coverage OFF produced an all-positive suite (11 pos / 1 neg / 0 edge)
 * because the planner only emitted the negative/edge KB obligations when
 * deep === true. The LLM then faithfully expanded a positive-only plan.
 *
 * Phase 3b fixes this at DISCOVERY time: when the user EXPLICITLY selects a
 * coverage family (Negative, Edge), the planner emits that family's KB-curated
 * obligations as 'Standard Coverage' (assumption-tagged) even with Deep OFF — so
 * a balanced plan is the DEFAULT the LLM expands. Deep only ENRICHES further.
 *
 * These tests pin: (1) Deep OFF now yields negative + edge-family scenarios for a
 * CRUD requirement; (2) they are KB-sourced 'Standard Coverage', assumption-true;
 * (3) a family the user did NOT select is never emitted this way; (4) Deep is a
 * superset (never removes Standard Coverage). Pure — NO LLM, NO DB.
 */
import { planScenarios } from '../../src/engines/scenario-planner';
import { coverageFamily } from '../../src/engines/generation-quality-engine';
import type { CoverageType } from '../../src/engines/test-coverage-engine';

const ADD_EMPLOYEE = {
  title: 'Add New Employee',
  description: 'HR admin adds a new employee record with name, email, department and role, then saves it.',
  module: 'HR',
  businessFlow: 'Navigate to Employees, click Add, fill the form, save.',
  acceptanceCriteria: 'Given valid details, when saved, the employee is created and appears in the list.',
};

function plan(types: CoverageType[], deep: boolean) {
  return planScenarios(ADD_EMPLOYEE as any, types, 'crud', undefined, deep);
}

/** Families present across a plan's scenarios. */
function familiesOf(p: ReturnType<typeof plan>): Set<string> {
  return new Set(p.scenarios.map(s => coverageFamily(s.coverageType)));
}

describe('Standard Coverage — Deep OFF still produces a balanced plan', () => {
  it('emits negative AND edge-family scenarios for a CRUD requirement with Deep OFF', () => {
    const fams = familiesOf(plan(['positive', 'negative', 'edge_cases'] as CoverageType[], false));
    expect(fams.has('positive')).toBe(true);
    expect(fams.has('negative')).toBe(true);
    // The CRUD KB's edge obligation is typed `boundary`; family mapping folds it
    // into `edge`, which is exactly why selection is reasoned about by family.
    expect(fams.has('edge')).toBe(true);
  });

  it('tags the added scenarios as KB-sourced Standard Coverage (assumption, not fabricated)', () => {
    const p = plan(['positive', 'negative', 'edge_cases'] as CoverageType[], false);
    const std = p.scenarios.filter(s => (s as any).provenance?.source === 'Standard Coverage');
    expect(std.length).toBeGreaterThanOrEqual(2);
    for (const s of std) {
      expect((s as any).provenance.assumption).toBe(true);
      // Never a positive — the happy path is Phase-1 requirement-guaranteed.
      expect(coverageFamily(s.coverageType)).not.toBe('positive');
      expect((s as any).provenance.evidence).toEqual([]);
    }
  });
});

describe('Standard Coverage — selection is the authorisation boundary', () => {
  it('does NOT emit Standard Coverage negatives/edge when the user only selected Positive', () => {
    const p = plan(['positive'] as CoverageType[], false);
    const std = p.scenarios.filter(s => (s as any).provenance?.source === 'Standard Coverage');
    // Nothing authorised beyond positive → no standard-coverage failure/edge cases.
    expect(std).toHaveLength(0);
    const fams = familiesOf(p);
    expect(fams.has('negative')).toBe(false);
    expect(fams.has('edge')).toBe(false);
  });

  it('selecting only Negative authorises negatives but NOT edge', () => {
    const p = plan(['positive', 'negative'] as CoverageType[], false);
    const std = p.scenarios.filter(s => (s as any).provenance?.source === 'Standard Coverage');
    expect(std.length).toBeGreaterThanOrEqual(1);
    expect(std.every(s => coverageFamily(s.coverageType) === 'negative')).toBe(true);
  });
});

describe('Standard Coverage — category-universal only, never feature-specific', () => {
  it('emits the category-UNIVERSAL CRUD negatives/edge but SKIPS the keyword-gated one', () => {
    const p = plan(['positive', 'negative', 'edge_cases'] as CoverageType[], false);
    const stdIds = new Set(
      p.scenarios
        .filter(s => (s as any).provenance?.source === 'Standard Coverage')
        .map(s => s.id),
    );
    // Category-universal obligations (no `conditionalOnKeywords`) — apply to
    // essentially any create/edit form, so selecting the family emits them.
    expect(stdIds.has('crud-neg-required-fields')).toBe(true);
    expect(stdIds.has('crud-neg-invalid-format')).toBe(true);
    expect(stdIds.has('crud-edge-boundary-lengths')).toBe(true);
    // Feature-specific obligation (gated on ['unique','duplicate',...]) — NOT
    // emitted from selection alone; it needs evidence that a uniqueness rule
    // exists. This is the line that keeps balance from becoming invention.
    expect(stdIds.has('crud-neg-duplicate')).toBe(false);
  });
});

describe('Standard Coverage vs Deep Coverage', () => {
  it('Deep is a superset — never drops a Standard Coverage family', () => {
    const off = familiesOf(plan(['positive', 'negative', 'edge_cases'] as CoverageType[], false));
    const on = familiesOf(plan(['positive', 'negative', 'edge_cases'] as CoverageType[], true));
    for (const f of off) expect(on.has(f)).toBe(true);
  });

  it('Deep OFF and Deep ON both cover the failure path (no regression from the fix)', () => {
    for (const deep of [false, true]) {
      expect(familiesOf(plan(['positive', 'negative', 'edge_cases'] as CoverageType[], deep)).has('negative')).toBe(true);
    }
  });
});
