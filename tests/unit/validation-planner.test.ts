/**
 * Validation Planner.
 *
 * The planner is the component that was actually missing when the engine
 * returned 11 Positive / 1 Negative / 0 Edge. Given the Business Model for
 * "Add New Employee", it must enumerate — from knowledge, no LLM — the
 * validations every discovered field and rule demands, yielding a BALANCED
 * intended mix (positives, negatives, boundaries, edges, permission) instead of
 * a positive-heavy guess.
 *
 * Pure — NO LLM, NO DB, NO UI. Every assertion is on plain data in / data out.
 */

import { understandRequirement, TIER_PROFILES } from '../../src/requirement-understanding';
import type { RequirementInput } from '../../src/requirement-coverage/types';
import { planValidations } from '../../src/validation-planning';

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
});

/* -------------------------------------------------------------------------- */
/*  Per-field validation expansion                                             */
/* -------------------------------------------------------------------------- */

describe('planValidations — per-field validations', () => {
  const plan = planFor();
  const forField = (f: string) => plan.points.filter((p) => p.appliesTo === f);

  it('plans email format + boundary + duplicate, not just a happy path', () => {
    const email = forField('email');
    const cats = email.map((p) => p.category);
    expect(cats).toEqual(expect.arrayContaining(['positive', 'negative', 'boundary']));
    // the unique rule contributes the duplicate negative
    expect(email.some((p) => p.id.endsWith('negative:duplicate'))).toBe(true);
    // invalid-format negative from the email type
    expect(email.some((p) => p.id.endsWith('negative:invalid-format'))).toBe(true);
  });

  it('plans an empty-rejection negative for a required field (department)', () => {
    const dept = forField('department');
    expect(dept.some((p) => p.category === 'negative' && p.id.endsWith('negative:empty'))).toBe(true);
  });

  it('plans input-safety edges for free-text fields by default', () => {
    const name = forField('name');
    expect(name.some((p) => p.id.endsWith('edge:sql-ish'))).toBe(true);
    expect(name.some((p) => p.id.endsWith('edge:xss-ish'))).toBe(true);
  });

  it('can suppress input-safety edges via options', () => {
    const noSafety = planFor(TIER_PROFILES.startup, { includeInputSafetyEdges: false });
    const name = noSafety.points.filter((p) => p.appliesTo === 'name');
    expect(name.some((p) => p.id.endsWith('edge:sql-ish'))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*  Rule-driven validations                                                    */
/* -------------------------------------------------------------------------- */

describe('planValidations — rule-driven validations', () => {
  const plan = planFor();

  it('plans a permission check from the admin-only rule', () => {
    const perm = plan.points.filter((p) => p.category === 'permission');
    expect(perm.length).toBeGreaterThan(0);
    expect(perm.every((p) => p.family === 'advanced')).toBe(true);
  });

  it('plans a duplicate negative from the unique rule', () => {
    expect(plan.points.some((p) => p.id.endsWith('negative:duplicate'))).toBe(true);
  });

  it('does not double-emit empty when both a required field and a mandatory rule exist', () => {
    const deptEmpty = plan.points.filter((p) => p.appliesTo === 'department' && p.id.endsWith('negative:empty'));
    expect(deptEmpty.length).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/*  Provenance, assumptions, determinism                                       */
/* -------------------------------------------------------------------------- */

describe('planValidations — provenance & determinism', () => {
  it('carries the target field source onto each point (tier admissibility inherited)', () => {
    const plan = planFor(TIER_PROFILES.enterprise);
    // enterprise model has only repository/requirement elements, so no point can
    // hang off knowledge_base or domain_inference.
    expect(plan.points.every((p) => p.source === 'repository' || p.source === 'requirement')).toBe(true);
  });

  it('marks boundary/edge best-practices as assumptions, positives/negatives on stated fields as grounded', () => {
    const plan = planFor(TIER_PROFILES.enterprise);
    const emailValid = plan.points.find((p) => p.appliesTo === 'email' && p.id.endsWith('positive:valid'));
    const emailMax = plan.points.find((p) => p.appliesTo === 'email' && p.id.endsWith('boundary:max-length'));
    expect(emailValid?.assumption).toBe(false);
    expect(emailMax?.assumption).toBe(true);
  });

  it('every point has a rationale (no unexplained coverage)', () => {
    const plan = planFor();
    expect(plan.points.every((p) => p.rationale.length > 0)).toBe(true);
  });

  it('is deterministic — identical model + options yield identical plan', () => {
    const a = planFor();
    const b = planFor();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('orders points positive → negative → edge → advanced', () => {
    const plan = planFor();
    const order = ['positive', 'negative', 'edge', 'advanced'];
    const idxs = plan.points.map((p) => order.indexOf(p.family));
    const sorted = [...idxs].sort((x, y) => x - y);
    expect(idxs).toEqual(sorted);
  });
});
