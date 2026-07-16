/**
 * Validation Planner — obligation-driven.
 *
 * The engine discovers VALIDATION OBLIGATIONS (what must be validated, and the
 * business risk each guards against), deduplicates them by intent, sizes the
 * plan dynamically from a risk profile, honours repository reuse, and only at
 * the very end projects the result onto Positive/Negative/Edge for presentation.
 *
 * These tests assert the mindset, not a target count:
 *   - the unit is an obligation carrying concept/intent/risk, not a P/N/E label;
 *   - positives belong to the capability, not the field count;
 *   - duplicate INTENT is collapsed (and counted);
 *   - the plan size emerges from applicable dimensions, so simple ≠ complex;
 *   - repository-covered obligations are reported but not regenerated;
 *   - Positive/Negative/Edge is a derived projection, never the driver.
 *
 * Pure — NO LLM, NO DB, NO UI.
 */

import { understandRequirement, TIER_PROFILES } from '../../src/requirement-understanding';
import type { RequirementInput } from '../../src/requirement-coverage/types';
import { planValidations } from '../../src/validation-planning';
import { DIMENSION_ORDER, DIMENSION_TO_FAMILY } from '../../src/validation-planning/types';

const addEmployee: RequirementInput = {
  id: 'REQ-002',
  title: 'User can create new employee',
  description:
    'The admin can add a new employee with name, email, phone and department. ' +
    'Email is required and must be unique. Department is mandatory. ' +
    'Only an authorized admin can create employees.',
};

const simpleContact: RequirementInput = {
  id: 'REQ-050',
  title: 'Visitor can submit a contact message',
  description: 'A visitor submits a message with their name and message text.',
};

function planFor(req: RequirementInput = addEmployee, options = {}, profile = TIER_PROFILES.startup) {
  const model = understandRequirement({ requirement: req, profile });
  return planValidations(model, options);
}

/* -------------------------------------------------------------------------- */
/*  The unit is an obligation, not a Positive/Negative/Edge test               */
/* -------------------------------------------------------------------------- */

describe('planValidations — obligations, not P/N/E', () => {
  const plan = planFor();

  it('every obligation carries a concept, an intent, and the risk it addresses', () => {
    expect(plan.obligations.length).toBeGreaterThan(0);
    for (const o of plan.obligations) {
      expect(o.concept.length).toBeGreaterThan(0);
      expect(o.intent.length).toBeGreaterThan(0);
      expect(o.riskAddressed.length).toBeGreaterThan(0);
    }
  });

  it('the obligation id is its intent signature (concept::intent)', () => {
    for (const o of plan.obligations) expect(o.id).toBe(`${o.concept}::${o.intent}`);
  });

  it('obligations carry NO positive/negative/edge label — that lives only in presentation', () => {
    for (const o of plan.obligations) {
      expect(o).not.toHaveProperty('family');
      expect(o).not.toHaveProperty('category');
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Positives belong to the capability, not the field count                    */
/* -------------------------------------------------------------------------- */

describe('planValidations — positives scale with capability, not fields', () => {
  const plan = planFor();

  it('all functional obligations anchor to the capability', () => {
    const functional = plan.obligations.filter((o) => o.dimension === 'functional');
    expect(functional.length).toBeGreaterThan(0);
    expect(functional.every((o) => o.target === 'capability')).toBe(true);
  });

  it('has no field-level positive obligation (the old per-field "valid" leak is gone)', () => {
    const perFieldPositive = plan.obligations.filter(
      (o) => DIMENSION_TO_FAMILY[o.dimension] === 'positive' && o.target === 'field',
    );
    expect(perFieldPositive.length).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/*  Duplicate intent is collapsed and counted                                  */
/* -------------------------------------------------------------------------- */

describe('planValidations — intent dedup', () => {
  const plan = planFor();

  it('collapses the mandatory-rule + required-field empty rejection into one obligation', () => {
    const emailEmpty = plan.obligations.filter((o) => o.id === 'email::reject-empty');
    expect(emailEmpty.length).toBe(1);
  });

  it('reports how many duplicate-intent obligations were eliminated', () => {
    // email + department each have a mandatory rule AND are required fields → 2 collapses
    expect(plan.metrics.duplicationEliminated).toBeGreaterThanOrEqual(2);
  });

  it('has globally unique obligation ids (no duplicate intent survives)', () => {
    const ids = plan.obligations.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('expresses cross-field security/data-integrity as one obligation each, across all free-text fields', () => {
    const security = plan.obligations.filter((o) => o.dimension === 'security');
    const data = plan.obligations.filter((o) => o.dimension === 'data_integrity');
    expect(security.length).toBeGreaterThan(0);
    expect(security.every((o) => (o.appliesToFields?.length ?? 0) > 0)).toBe(true);
    expect(data.every((o) => (o.appliesToFields?.length ?? 0) > 0)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/*  Dynamic sizing — the plan size emerges from applicable risk dimensions     */
/* -------------------------------------------------------------------------- */

describe('planValidations — dynamic, risk-driven sizing', () => {
  it('activates only the dimensions that apply to the requirement', () => {
    const simple = planFor(simpleContact);
    // no auth rule, no business rules → those dimensions must not appear
    expect(simple.riskProfile.applicableDimensions).not.toContain('authorization');
    expect(simple.riskProfile.applicableDimensions).not.toContain('business_rule');
    expect(simple.obligations.some((o) => o.dimension === 'authorization')).toBe(false);
  });

  it('a richer requirement is larger and more complex than a simpler one', () => {
    const simple = planFor(simpleContact);
    const rich = planFor(addEmployee);
    expect(rich.obligations.length).toBeGreaterThan(simple.obligations.length);
    expect(rich.riskProfile.applicableDimensions.length).toBeGreaterThan(simple.riskProfile.applicableDimensions.length);
  });

  it('exposes a risk profile explaining the size (not a fixed target)', () => {
    const rich = planFor(addEmployee);
    expect(rich.riskProfile.hasAuthorization).toBe(true);
    expect(rich.riskProfile.securityExposureFields).toBeGreaterThan(0);
    expect(['simple', 'moderate', 'complex']).toContain(rich.riskProfile.complexity);
  });
});

/* -------------------------------------------------------------------------- */
/*  Repository intelligence — reuse, don't regenerate                          */
/* -------------------------------------------------------------------------- */

describe('planValidations — repository reuse', () => {
  it('marks already-covered obligations as covered and excludes them from work', () => {
    const covered = ['employee-capability::complete-happy-path', 'email-uniqueness::reject-duplicate'];
    const base = planFor();
    const withReuse = planFor(addEmployee, { alreadyCovered: covered });

    expect(withReuse.metrics.repositoryReuse).toBe(2);
    expect(withReuse.metrics.obligationsToGenerate).toBe(base.metrics.obligationsToGenerate - 2);
    // the obligations still appear in the plan (transparency), just marked covered
    expect(withReuse.obligations.length).toBe(base.obligations.length);
    for (const id of covered) {
      expect(withReuse.obligations.find((o) => o.id === id)?.status).toBe('covered');
    }
  });
});

/* -------------------------------------------------------------------------- */
/*  Count-free success metrics                                                 */
/* -------------------------------------------------------------------------- */

describe('planValidations — metrics measure coverage, not counts', () => {
  const plan = planFor();

  it('reports full business-rule coverage when every rule is addressed', () => {
    expect(plan.metrics.businessRuleCoverage).toBe(1);
  });

  it('reports full dimension coverage when every applicable dimension produced an obligation', () => {
    expect(plan.metrics.dimensionCoverage).toBe(1);
  });

  it('obligationsToGenerate equals the gap obligations, not the raw total', () => {
    const gaps = plan.obligations.filter((o) => o.status === 'gap').length;
    expect(plan.metrics.obligationsToGenerate).toBe(gaps);
  });
});

/* -------------------------------------------------------------------------- */
/*  Presentation is a derived projection                                       */
/* -------------------------------------------------------------------------- */

describe('planValidations — presentation is derived, not the driver', () => {
  const plan = planFor();

  it('presentation totals reconcile exactly with the obligations', () => {
    const { positive, negative, edge, advanced, total } = plan.presentation;
    expect(positive + negative + edge + advanced).toBe(total);
    expect(total).toBe(plan.obligations.length);
  });

  it('each family count equals the obligations whose dimension maps to it', () => {
    const expectedPositive = plan.obligations.filter((o) => DIMENSION_TO_FAMILY[o.dimension] === 'positive').length;
    expect(plan.presentation.positive).toBe(expectedPositive);
  });

  it('is not positive-heavy the way the reported 11/1/0 suite was', () => {
    expect(plan.presentation.positive / plan.presentation.total).toBeLessThan(0.5);
  });

  it('exposes a per-dimension breakdown that sums to the total', () => {
    const sum = Object.values(plan.presentation.byDimension).reduce((a, b) => a + (b ?? 0), 0);
    expect(sum).toBe(plan.presentation.total);
  });
});

/* -------------------------------------------------------------------------- */
/*  Provenance, ordering, determinism                                          */
/* -------------------------------------------------------------------------- */

describe('planValidations — provenance, ordering, determinism', () => {
  it('inherits target evidence source; enterprise tier admits only repository/requirement', () => {
    const plan = planFor(addEmployee, {}, TIER_PROFILES.enterprise);
    expect(plan.obligations.every((o) => o.source === 'repository' || o.source === 'requirement')).toBe(true);
  });

  it('marks best-practice boundaries as assumptions, stated expectations as grounded', () => {
    const plan = planFor(addEmployee, {}, TIER_PROFILES.enterprise);
    const happy = plan.obligations.find((o) => o.id.endsWith('::complete-happy-path'));
    const emailMax = plan.obligations.find((o) => o.id === 'email-length::enforce-max-length');
    const emailFormat = plan.obligations.find((o) => o.id === 'email::reject-malformed');
    expect(happy?.assumption).toBe(false);
    expect(emailFormat?.assumption).toBe(false);
    expect(emailMax?.assumption).toBe(true);
  });

  it('orders obligations in dimension (QA reading) order', () => {
    const plan = planFor();
    const idxs = plan.obligations.map((o) => DIMENSION_ORDER.indexOf(o.dimension));
    expect(idxs).toEqual([...idxs].sort((x, y) => x - y));
  });

  it('is deterministic — identical model + options yield an identical plan', () => {
    expect(JSON.stringify(planFor())).toBe(JSON.stringify(planFor()));
  });

  it('caps boundary obligations per field when maxBoundaryPerField is set', () => {
    const capped = planFor(addEmployee, { maxBoundaryPerField: 1 });
    const perField = new Map<string, number>();
    for (const o of capped.obligations.filter((x) => x.dimension === 'boundary')) {
      perField.set(o.appliesTo, (perField.get(o.appliesTo) ?? 0) + 1);
    }
    for (const n of perField.values()) expect(n).toBeLessThanOrEqual(1);
  });

  it('can suppress the security + data-integrity dimensions via options', () => {
    const noSafety = planFor(addEmployee, { includeInputSafetyEdges: false });
    expect(noSafety.obligations.some((o) => o.dimension === 'security')).toBe(false);
    expect(noSafety.obligations.some((o) => o.dimension === 'data_integrity')).toBe(false);
    expect(noSafety.riskProfile.applicableDimensions).not.toContain('security');
  });
});
