/**
 * Validation Planner — taxonomy-driven.
 *
 * The planner is the component that was actually missing when the engine
 * returned 11 Positive / 1 Negative / 0 Edge. It walks a QA TAXONOMY
 * (Category → applicable Rules/Fields → Point) rather than iterating fields, so
 * positives belong to the capability (not the field count) and cross-field
 * concerns (security, data integrity) are a few grouped points, not one-per-field.
 *
 * Pure — NO LLM, NO DB, NO UI. Every assertion is on plain data in / data out.
 */

import { understandRequirement, TIER_PROFILES } from '../../src/requirement-understanding';
import type { RequirementInput } from '../../src/requirement-coverage/types';
import { planValidations, SECURITY_PAYLOADS, DATA_INTEGRITY_CHECKS } from '../../src/validation-planning';
import { TAXONOMY_ORDER } from '../../src/validation-planning/types';

const addEmployee: RequirementInput = {
  id: 'REQ-002',
  title: 'User can create new employee',
  description:
    'The admin can add a new employee with name, email, phone and department. ' +
    'Email is required and must be unique. Department is mandatory. ' +
    'Only an authorized admin can create employees.',
};

function planFor(profile = TIER_PROFILES.startup, options = {}) {
  const model = understandRequirement({ requirement: addEmployee, profile });
  return planValidations(model, options);
}

/* -------------------------------------------------------------------------- */
/*  The headline: balance replaces 11/1/0                                      */
/* -------------------------------------------------------------------------- */

describe('planValidations — balanced coverage for Add Employee', () => {
  const plan = planFor();

  it('produces validations across every core family, not just positive', () => {
    expect(plan.mix.positive).toBeGreaterThan(0);
    expect(plan.mix.negative).toBeGreaterThan(0);
    expect(plan.mix.edge).toBeGreaterThan(0);
  });

  it('is NOT positive-heavy the way the reported suite was', () => {
    // the reported failure was 11 positive of 12 (92%); a knowledge-planned
    // suite must not be dominated by positives.
    const positiveShare = plan.mix.positive / plan.mix.total;
    expect(positiveShare).toBeLessThan(0.5);
  });

  it('has more negative+edge coverage than positive', () => {
    expect(plan.mix.negative + plan.mix.edge).toBeGreaterThan(plan.mix.positive);
  });

  it('exposes a human-readable intended mix label before any generation', () => {
    expect(plan.mix.label).toMatch(/Positive: \d+ · Negative: \d+ · Edge: \d+ · Advanced: \d+/);
  });

  it('reports a per-category breakdown (reads like a QA test plan)', () => {
    expect(plan.mix.byCategory.functional).toBeGreaterThan(0);
    expect(plan.mix.byCategory.input_validation).toBeGreaterThan(0);
    expect(Object.values(plan.mix.byCategory).reduce((a, b) => a + (b ?? 0), 0)).toBe(plan.mix.total);
  });
});

/* -------------------------------------------------------------------------- */
/*  The core inversion: positives belong to the capability, not the fields     */
/* -------------------------------------------------------------------------- */

describe('planValidations — positives do not scale with field count', () => {
  const plan = planFor();

  it('emits every positive from the functional category, never per field', () => {
    const positives = plan.points.filter((p) => p.family === 'positive');
    expect(positives.length).toBeGreaterThan(0);
    expect(positives.every((p) => p.category === 'functional')).toBe(true);
  });

  it('bounds functional positives to the capability (at most a couple), not one-per-field', () => {
    // 4+ fields in this requirement, but positives must stay ~capability-sized.
    expect(plan.mix.byCategory.functional).toBeLessThanOrEqual(2);
  });

  it('has no field-level positive point (the old per-field "valid" leak is gone)', () => {
    const fieldPositives = plan.points.filter((p) => p.family === 'positive' && p.target === 'field');
    expect(fieldPositives.length).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Category → applicable fields/rules                                         */
/* -------------------------------------------------------------------------- */

describe('planValidations — category-driven discovery', () => {
  const plan = planFor();
  const forField = (f: string) => plan.points.filter((p) => p.appliesTo === f);

  it('plans email format-rejection, boundary and duplicate across three categories', () => {
    const email = forField('email');
    const cats = email.map((p) => p.category);
    expect(cats).toEqual(expect.arrayContaining(['input_validation', 'boundary', 'business_rule']));
    expect(email.some((p) => p.id === 'email:business_rule:duplicate')).toBe(true);
    expect(email.some((p) => p.id === 'email:input_validation:invalid-format')).toBe(true);
    expect(email.some((p) => p.id === 'email:boundary:max-length')).toBe(true);
  });

  it('plans an empty-rejection negative for a required field (department)', () => {
    const dept = forField('department');
    expect(dept.some((p) => p.id === 'department:input_validation:empty')).toBe(true);
  });

  it('plans a permission check from the admin-only rule (advanced family)', () => {
    const perm = plan.points.filter((p) => p.category === 'permission');
    expect(perm.length).toBeGreaterThan(0);
    expect(perm.every((p) => p.family === 'advanced')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  Cross-field concerns are grouped, not repeated per field                   */
/* -------------------------------------------------------------------------- */

describe('planValidations — security & data integrity are category-level', () => {
  const plan = planFor();

  it('emits exactly one point per security payload, regardless of field count', () => {
    const security = plan.points.filter((p) => p.category === 'security');
    expect(security.length).toBe(SECURITY_PAYLOADS.length);
    // each is a grouped point that lists the free-text fields it touches
    expect(security.every((p) => (p.appliesToFields?.length ?? 0) > 0)).toBe(true);
  });

  it('emits exactly one point per data-integrity check, listing affected fields', () => {
    const data = plan.points.filter((p) => p.category === 'data_integrity');
    expect(data.length).toBe(DATA_INTEGRITY_CHECKS.length);
    expect(data.every((p) => (p.appliesToFields?.length ?? 0) > 0)).toBe(true);
  });

  it('can suppress security + data-integrity via options', () => {
    const noSafety = planFor(TIER_PROFILES.startup, { includeInputSafetyEdges: false });
    expect(noSafety.points.some((p) => p.category === 'security')).toBe(false);
    expect(noSafety.points.some((p) => p.category === 'data_integrity')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  No double-emit                                                             */
/* -------------------------------------------------------------------------- */

describe('planValidations — no double emission', () => {
  const plan = planFor();

  it('does not double-emit empty when both a required field and a mandatory rule exist', () => {
    const deptEmpty = plan.points.filter((p) => p.id === 'department:input_validation:empty');
    expect(deptEmpty.length).toBe(1);
  });

  it('has globally unique point ids', () => {
    const ids = plan.points.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

/* -------------------------------------------------------------------------- */
/*  Provenance, assumptions, determinism, ordering                            */
/* -------------------------------------------------------------------------- */

describe('planValidations — provenance & determinism', () => {
  it('carries the target source onto each point (tier admissibility inherited)', () => {
    const plan = planFor(TIER_PROFILES.enterprise);
    // enterprise model admits only repository/requirement elements, so no point
    // can hang off knowledge_base or domain_inference.
    expect(plan.points.every((p) => p.source === 'repository' || p.source === 'requirement')).toBe(true);
  });

  it('marks best-practice boundaries as assumptions, stated expectations as grounded', () => {
    const plan = planFor(TIER_PROFILES.enterprise);
    const happyPath = plan.points.find((p) => p.id.endsWith('functional:happy-path'));
    const emailMax = plan.points.find((p) => p.id === 'email:boundary:max-length');
    const emailFormat = plan.points.find((p) => p.id === 'email:input_validation:invalid-format');
    expect(happyPath?.assumption).toBe(false);   // the primary success path is stated
    expect(emailFormat?.assumption).toBe(false);  // rejecting a malformed stated field is grounded
    expect(emailMax?.assumption).toBe(true);      // a specific length limit was never stated
  });

  it('every point has a rationale (no unexplained coverage)', () => {
    const plan = planFor();
    expect(plan.points.every((p) => p.rationale.length > 0)).toBe(true);
  });

  it('is deterministic — identical model + options yield identical plan', () => {
    expect(JSON.stringify(planFor())).toBe(JSON.stringify(planFor()));
  });

  it('groups points in taxonomy order (functional first, safety last)', () => {
    const plan = planFor();
    const idxs = plan.points.map((p) => TAXONOMY_ORDER.indexOf(p.category));
    const sorted = [...idxs].sort((x, y) => x - y);
    expect(idxs).toEqual(sorted);
  });

  it('caps boundary points per field when maxEdgePerField is set', () => {
    const capped = planFor(TIER_PROFILES.startup, { maxEdgePerField: 1 });
    const byField = new Map<string, number>();
    for (const p of capped.points.filter((x) => x.category === 'boundary')) {
      byField.set(p.appliesTo, (byField.get(p.appliesTo) ?? 0) + 1);
    }
    for (const n of byField.values()) expect(n).toBeLessThanOrEqual(1);
  });
});
