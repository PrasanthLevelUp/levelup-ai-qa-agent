/**
 * Unit tests for PX-1A — Dataset Usage (datasets assist, they don't dominate).
 *
 * Product contract locked in here:
 *   1. Datasets are OPTIONAL. No greedy fallback to datasets[0].
 *   2. Only scenarios that naturally consume a full valid record (positive
 *      creates, duplicate checks) attempt a dataset match. Security / boundary /
 *      whitespace / validation scenarios always use generated sample values.
 *   3. Matching trusts the DATA STRUCTURE before the LABEL:
 *          Dataset KEYS (primary) → Dataset NAME (secondary) → Requirement (tie-break)
 *      A generically-named dataset whose KEYS fit the form beats a well-named
 *      dataset whose keys are irrelevant.
 *   4. Requirement context is ONLY a tie-breaker — it can never pull in a dataset
 *      on its own.
 *   5. Matching is token-based (whole words), so a scenario word like "data"
 *      never spuriously matches a dataset named "Dataset_A".
 *
 * Run with: npx jest tests/unit/dataset-usage-priority.test.ts
 */

import { planScenarios } from '../../src/engines/scenario-planner';
import { buildDraftTestCases } from '../../src/engines/scenario-builder';
import type { CoverageType } from '../../src/engines/test-coverage-engine';

const FAMILIES: CoverageType[] = ['positive', 'negative', 'edge_cases'];

const FORM = {
  page: 'https://demo.orangehrmlive.com/web/index.php/pim/addEmployee',
  submitLabel: 'Save',
  submitSelector: 'button[type=submit]',
  fields: [
    { label: 'First Name', name: 'firstName', type: 'text', required: true, selector: 'input[name=firstName]' },
    { label: 'Last Name', name: 'lastName', type: 'text', required: true, selector: 'input[name=lastName]' },
  ],
};

const REQ: any = {
  title: 'Add New Employee',
  description: 'HR admin can create a new employee record by entering first name and last name.',
  module: 'HR',
  acceptanceCriteria: 'Given valid employee data, the record is created and searchable.',
};

/** Build drafts and return the resolved dataset name for a scenario, or null. */
function datasetFor(testData: any[], match: RegExp): string | null {
  const knowledge: any = {
    applicationProfile: { baseUrl: 'https://x/', name: 'OrangeHRM', forms: [FORM] },
    testData,
  };
  const plan = planScenarios(REQ, FAMILIES, undefined, undefined, false);
  const { drafts } = buildDraftTestCases(plan as any, knowledge, REQ);
  const d = drafts.find((x: any) => match.test(x.title));
  if (!d) throw new Error(`No scenario matched ${match}`);
  const m = /✓ Dataset: (\S+)/.exec(d.testData || '');
  return m ? m[1] : null;
}

const POSITIVE = /create a record with valid data/i;
const DUPLICATE = /duplicate/i;
const SQL = /sql-injection/i;
const XSS = /xss|script payload/i;
const WHITESPACE = /whitespace/i;
const BOUNDARY = /length \/ value boundaries/i;

describe('PX-1A — datasets are optional (no greedy fallback)', () => {
  it('returns generated sample values when NO dataset structurally fits', () => {
    expect(datasetFor(
      [{ name: 'Regression_Set_01', sampleKeys: ['orderId', 'sku', 'price'] }],
      POSITIVE,
    )).toBeNull();
  });

  it('never falls back to datasets[0] just because a dataset exists', () => {
    // First dataset does NOT fit; engine must not pick it.
    expect(datasetFor(
      [
        { name: 'Dataset_A', sampleKeys: ['col1', 'col2'] },
        { name: 'Dataset_B', sampleKeys: ['x', 'y'] },
      ],
      POSITIVE,
    )).toBeNull();
  });
});

describe('PX-1A — keys are the primary signal (data structure over label)', () => {
  it('a generic name with FITTING keys beats a good name with irrelevant keys', () => {
    expect(datasetFor(
      [
        { name: 'Employee_Master', sampleKeys: ['id', 'createdAt', 'updatedAt'] },
        { name: 'Regression_Set',  sampleKeys: ['employeeId', 'firstName', 'lastName'] },
      ],
      POSITIVE,
    )).toBe('Regression_Set');
  });

  it('a meaningless dataset name still matches when its keys fit the form', () => {
    expect(datasetFor(
      [{ name: 'Dataset_A', sampleKeys: ['firstName', 'lastName'] }],
      POSITIVE,
    )).toBe('Dataset_A');
  });

  it('a scenario word ("data") does not spuriously match a name ("Dataset_A")', () => {
    // Dataset_A's keys do NOT fit → must NOT be picked despite "data" ⊂ "Dataset_A".
    expect(datasetFor(
      [{ name: 'Dataset_A', sampleKeys: ['col1', 'col2'] }],
      POSITIVE,
    )).toBeNull();
  });
});

describe('PX-1A — requirement context is only a tie-breaker', () => {
  it('breaks a structural tie toward the requirement-relevant dataset', () => {
    expect(datasetFor(
      [
        { name: 'person_records', sampleKeys: ['firstName', 'lastName'] },
        { name: 'employee_data',  sampleKeys: ['firstName', 'lastName'] },
      ],
      POSITIVE,
    )).toBe('employee_data');
  });

  it('cannot pull in a dataset on its own (no structural fit → inline)', () => {
    // Name contains "employee" (matches requirement) but keys do NOT fit the form.
    expect(datasetFor(
      [{ name: 'employee_audit_log', sampleKeys: ['event', 'timestamp'] }],
      POSITIVE,
    )).toBeNull();
  });
});

describe('PX-1A — deterministic tie-breaking (never random)', () => {
  it('picks the earliest uploaded dataset when everything else ties', () => {
    const datasets = [
      { name: 'set_one', sampleKeys: ['firstName', 'lastName'] },
      { name: 'set_two', sampleKeys: ['firstName', 'lastName'] },
    ];
    // Both fit structurally, neither matches requirement → first upload wins, stably.
    const first = datasetFor(datasets, POSITIVE);
    const again = datasetFor(datasets, POSITIVE);
    expect(first).toBe('set_one');
    expect(again).toBe('set_one');
  });
});

describe('PX-1A — security / validation scenarios never consume datasets', () => {
  const employeeDatasets = [
    { name: 'new_employee', sampleKeys: ['firstName', 'lastName'] },
    { name: 'duplicate_employee', sampleKeys: ['firstName', 'lastName'] },
  ];

  it('positive create uses new_employee', () => {
    expect(datasetFor(employeeDatasets, POSITIVE)).toBe('new_employee');
  });

  it('duplicate check uses duplicate_employee', () => {
    expect(datasetFor(employeeDatasets, DUPLICATE)).toBe('duplicate_employee');
  });

  it.each([
    ['SQL injection', SQL],
    ['XSS', XSS],
    ['whitespace', WHITESPACE],
    ['boundary', BOUNDARY],
  ])('%s scenario uses generated sample values (no dataset)', (_label, rx) => {
    expect(datasetFor(employeeDatasets, rx)).toBeNull();
  });
});
