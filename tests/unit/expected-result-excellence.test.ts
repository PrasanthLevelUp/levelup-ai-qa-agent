/**
 * EXPECTED RESULT EXCELLENCE TESTS
 * ================================
 * Sprint: "Expected Result Excellence". These lock the guarantee the founder
 * demanded: buildExpected() must emit BUSINESS-OBSERVABLE ASSERTION LISTS that a
 * Senior QA would accept without rewriting — never a single generic success/
 * failure sentence.
 *
 * The defect this net protects against: buildExpected() switched ONLY on
 * coverageType and emitted ONE generic sentence per type, so all 39 Add-Employee
 * scenarios collapsed onto ~6 identical strings ("The action succeeds and the
 * user reaches the expected next state...", "The action is rejected, a clear...
 * error message is shown."). Those are not assertions — they are placeholders.
 *
 * The contract under test (all DETERMINISTIC, no LLM, derived ONLY from the
 * planner scenario, the requirement, and the application profile):
 *   1. Every Expected Result is a LIST — `expected.assertions` is an array of
 *      >= 2 concrete assertions, and `expected.observable` is a "✓ "-prefixed
 *      checklist string mirroring it.
 *   2. Assertions name the real BUSINESS ENTITY ("Employee") and the real
 *      fields ("First Name", "Last Name", "Employee ID") — not "the record" /
 *      "the action".
 *   3. Assertions are SCENARIO-TYPE dependent: positive-create, negative-
 *      duplicate, negative-validation, authorization, boundary-accept,
 *      boundary-reject and injection each produce a DIFFERENT, intent-matching
 *      list.
 *   4. Polarity is preserved (positive lists read as success, negative lists as
 *      rejection) so the integrity polarity gate never downgrades them.
 *
 * Run with: npx jest tests/unit/expected-result-excellence.test.ts
 */

import { planScenarios } from '../../src/engines/scenario-planner';
import { buildDraftTestCases } from '../../src/engines/scenario-builder';
import { validateExpectedResult } from '../../src/engines/expected-result-validator';
import type { CoverageType } from '../../src/engines/test-coverage-engine';

// ---------------------------------------------------------------------------
// Fixtures — the real Add-Employee requirement + a profile that knows the form,
// a list page, and the login page (mirrors the shipped Add-Employee suite).
// ---------------------------------------------------------------------------

const ADD_EMPLOYEE_REQ = {
  title: 'Add Employee',
  description:
    'An HR admin adds a new employee by entering their first name, last name and a unique employee ID, then saving the record.',
  acceptanceCriteria:
    'A new employee is created with valid data; a duplicate employee ID is rejected; malicious input is handled safely.',
  businessFlow:
    'Open the Add Employee form → enter first name + last name + employee ID → save → the employee appears in the list.',
};

const EMPLOYEE_PROFILE = {
  baseUrl: 'https://app.example.com',
  name: 'Example App',
  loginUrl: 'https://app.example.com/login',
  pages: [
    { url: 'https://app.example.com/login', title: 'Login', pageType: 'auth' },
    { url: 'https://app.example.com/employees', title: 'Employees', pageType: 'list' },
    { url: 'https://app.example.com/employees/new', title: 'Add Employee', pageType: 'form' },
  ],
  forms: [
    {
      page: 'https://app.example.com/login',
      action: '/session',
      method: 'POST',
      submitSelector: '#login-btn',
      fields: [
        { name: 'username', type: 'text', required: true, selector: '#username', label: 'Username' },
        { name: 'password', type: 'password', required: true, selector: '#password', label: 'Password' },
      ],
    },
    {
      page: 'https://app.example.com/employees/new',
      action: '/employees',
      method: 'POST',
      submitLabel: 'Save',
      submitSelector: '#save',
      fields: [
        { name: 'first_name', type: 'text', required: true, selector: '#first-name', label: 'First Name' },
        { name: 'last_name', type: 'text', required: true, selector: '#last-name', label: 'Last Name' },
        { name: 'employee_id', type: 'text', required: true, selector: '#emp-id', label: 'Employee ID' },
      ],
    },
  ],
  keyElements: [{ label: 'Save', tag: 'button', selector: '#save', role: 'button' }],
};

const employeeKnowledge = (): any => ({ applicationProfile: EMPLOYEE_PROFILE, testData: [] });
const COVERAGE: CoverageType[] = ['positive', 'negative', 'boundary', 'security', 'edge_cases'];

// Build the full Add-Employee suite ONCE.
const plan = planScenarios(ADD_EMPLOYEE_REQ, COVERAGE, 'crud');
const { drafts } = buildDraftTestCases(plan, employeeKnowledge(), ADD_EMPLOYEE_REQ);
const byId = (id: string): any => drafts.find((d: any) => d.scenarioId === id);
const assertionsOf = (d: any): string[] => (d?.expected?.assertions || []) as string[];
const observableOf = (d: any): string => (d?.expected?.observable || d?.expectedResult || '');

// ---------------------------------------------------------------------------
// Contract 1 — every Expected Result is a real assertion LIST
// ---------------------------------------------------------------------------

describe('Contract 1 — every Expected Result is a business-observable assertion list', () => {
  it('generated a suite', () => expect(drafts.length).toBeGreaterThan(0));

  it('EVERY draft exposes expected.assertions as an array of >= 2 concrete items', () => {
    for (const d of drafts) {
      const a = assertionsOf(d);
      expect(Array.isArray(a)).toBe(true);
      expect(a.length).toBeGreaterThanOrEqual(2);
      // no empty / whitespace-only assertions
      for (const item of a) expect(item.trim().length).toBeGreaterThan(0);
    }
  });

  it('observable mirrors the list as a "✓ "-prefixed checklist (one line per assertion)', () => {
    for (const d of drafts) {
      const a = assertionsOf(d);
      const obs = observableOf(d);
      expect(obs.startsWith('✓ ')).toBe(true);
      expect(obs.split('\n').length).toBe(a.length);
      for (const item of a) expect(obs).toContain(item);
    }
  });

  it('NO draft falls back to the old generic one-liners', () => {
    const BANNED = [
      'the action succeeds and the user reaches the expected next state',
      'the action is rejected, a clear, specific error message is shown',
    ];
    for (const d of drafts) {
      const obs = observableOf(d).toLowerCase();
      for (const banned of BANNED) expect(obs).not.toContain(banned);
    }
  });
});

// ---------------------------------------------------------------------------
// Contract 2 — assertions name the real entity + fields
// ---------------------------------------------------------------------------

describe('Contract 2 — positive create names the entity, the fields, and the list', () => {
  const d = byId('crud-pos-create');
  it('is generated', () => expect(d).toBeTruthy());

  it('reads as a create-and-confirm checklist (>= 5 assertions)', () => {
    expect(assertionsOf(d).length).toBeGreaterThanOrEqual(5);
  });

  it('names the business entity "Employee" (not "the record")', () => {
    expect(observableOf(d)).toContain('Employee');
  });

  it('asserts the entered fields are shown exactly as entered (First Name, Last Name, Employee ID)', () => {
    const obs = observableOf(d);
    expect(obs).toContain('First Name');
    expect(obs).toContain('Last Name');
    expect(obs).toContain('Employee ID');
    expect(obs.toLowerCase()).toMatch(/exactly as entered|saved exactly|stored exactly/);
  });

  it('asserts the record becomes visible in the list and survives a refresh (observable proxy for persistence)', () => {
    const obs = observableOf(d).toLowerCase();
    expect(obs).toMatch(/appears in the employees list/);
    expect(obs).toMatch(/after the page is refreshed/);
  });

  it('reads with positive polarity (success, no rejection language)', () => {
    const obs = observableOf(d).toLowerCase();
    expect(obs).toMatch(/success|successfully/);
    expect(obs).not.toMatch(/\brejected\b|\bdenied\b/);
  });
});

// ---------------------------------------------------------------------------
// Contract 3 — scenario-type dependent lists (each type differs)
// ---------------------------------------------------------------------------

describe('Contract 3 — different scenario types produce different assertion lists', () => {
  it('DUPLICATE — rejects the second record and cites an "already exists" conflict', () => {
    const obs = observableOf(byId('crud-neg-duplicate')).toLowerCase();
    expect(obs).toMatch(/not created|is not created/);
    expect(obs).toMatch(/already exists/);
    expect(obs).toMatch(/does not increase|left unchanged/);
    expect(obs).toMatch(/rejected/); // negative polarity token
  });

  it('REQUIRED-FIELDS — nothing saved + specific validation error + values retained', () => {
    const obs = observableOf(byId('crud-neg-required-fields')).toLowerCase();
    expect(obs).toMatch(/not created|no record is saved/);
    expect(obs).toMatch(/validation error/);
    expect(obs).toMatch(/retained/);
  });

  it('AUTHORIZATION — operation denied, nothing created/changed, denied message shown (all observable)', () => {
    const obs = observableOf(byId('crud-neg-unauthorized')).toLowerCase();
    expect(obs).toMatch(/operation is denied|access-denied|not-authorised|not authorised/);
    expect(obs).toMatch(/no employee is created or changed|no new or changed employee/);
    // The non-provable "enforced server-side" claim must be GONE.
    expect(obs).not.toMatch(/server-side|server side/);
  });

  it('INJECTION — literal text shown, no pop-up appears, generic error (all observable, no internals)', () => {
    const obs = observableOf(byId('crud-neg-injection-xss')).toLowerCase();
    expect(obs).toMatch(/plain text|literal characters|exactly as typed/);
    expect(obs).toMatch(/no pop-up|no popup|alert box|injected element/);
    expect(obs).toMatch(/generic error/);
    // Non-provable internals must be GONE.
    expect(obs).not.toMatch(/neutralised|escaped|executed|interpreted|corruption/);
  });

  it('BOUNDARY-ACCEPT vs BOUNDARY-REJECT are opposite assertions', () => {
    const accept = observableOf(byId('field-first-name-max-accepted')).toLowerCase();
    const reject = observableOf(byId('field-first-name-over-max')).toLowerCase();
    // accept side
    expect(accept).toMatch(/accepted/);
    expect(accept).toMatch(/created successfully/);
    expect(accept).toMatch(/no truncation|exactly as entered/);
    // reject side
    expect(reject).toMatch(/rejected/);
    expect(reject).toMatch(/allowed maximum|maximum/);
    expect(reject).toMatch(/no employee record is created|not created/);
    // they must not be identical strings
    expect(accept).not.toEqual(reject);
  });
});

// ---------------------------------------------------------------------------
// Contract 4 — field-scoped negatives name the specific field
// ---------------------------------------------------------------------------

describe('Contract 4 — field-scoped validation errors name the specific field', () => {
  it('First-Name whitespace error is scoped to the First Name field', () => {
    const obs = observableOf(byId('field-first-name-whitespace')).toLowerCase();
    expect(obs).toMatch(/validation error/);
    expect(obs).toMatch(/first name/);
  });

  it('Last-Name whitespace error is scoped to the Last Name field', () => {
    const obs = observableOf(byId('field-last-name-whitespace')).toLowerCase();
    expect(obs).toMatch(/validation error/);
    expect(obs).toMatch(/last name/);
  });
});

// ---------------------------------------------------------------------------
// Contract 5 — positive vs negative lists are polarity-clean (integrity gate)
// ---------------------------------------------------------------------------

describe('Contract 5 — polarity is clean so the integrity gate never downgrades', () => {
  const NEG_IDS = [
    'crud-neg-duplicate',
    'crud-neg-required-fields',
    'crud-neg-unauthorized',
    'crud-neg-injection-xss',
    'field-first-name-over-max',
  ];

  it('negative scenarios carry a rejection/denial token in the observable', () => {
    for (const id of NEG_IDS) {
      const obs = observableOf(byId(id)).toLowerCase();
      expect(obs).toMatch(/rejected|denied|not created|neutralised|escaped/);
    }
  });

  it('positive create carries a success token and no bare rejection token', () => {
    const obs = observableOf(byId('crud-pos-create')).toLowerCase();
    expect(obs).toMatch(/success|successfully/);
    expect(obs).not.toMatch(/\bfailure\b|\berror\b/);
  });
});

// ---------------------------------------------------------------------------
// Contract 6 — THE PROVABILITY GATE. Every assertion of every scenario must be
// Observable + Grounded + Black-box (the founder's "rich, but not provable"
// defect). Validated with the FULL context (requirement + scenario + profile).
// ---------------------------------------------------------------------------

describe('Contract 6 — every assertion of every scenario is Observable + Grounded + Black-box', () => {
  const requirementText = `${ADD_EMPLOYEE_REQ.title} ${ADD_EMPLOYEE_REQ.description} ${ADD_EMPLOYEE_REQ.acceptanceCriteria} ${ADD_EMPLOYEE_REQ.businessFlow}`;
  const profileText = [
    'Employee',
    'Employees',
    'Employees list',
    'First Name',
    'Last Name',
    'Employee ID',
    ...EMPLOYEE_PROFILE.pages.map((p) => `${p.title} ${p.pageType}`),
  ].join(' ');

  it('NO assertion in the entire Add Employee suite violates any of the three conditions', () => {
    const failures: string[] = [];
    for (const d of drafts) {
      const scenarioText = `${d.title || ''} ${d.objective || ''}`;
      const verdict = validateExpectedResult(assertionsOf(d), {
        requirementText,
        scenarioText,
        profileText,
      });
      if (!verdict.passed) {
        failures.push(`${d.scenarioId}: ${verdict.violations.join(' | ')}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('the OLD non-provable phrasings would have been REJECTED (gate is real, not vacuous)', () => {
    const bad = validateExpectedResult(
      [
        'The block is enforced server-side, not merely hidden in the UI.',
        'The Employee record persists after a page refresh (it is durably saved).',
        'The malicious input is safely neutralised — escaped as literal text, never executed.',
        'The database is updated and the transaction is committed.',
        'A confirmation email is sent to the HR admin.',
      ],
      { requirementText, profileText },
    );
    expect(bad.passed).toBe(false);
    // each of the five is caught
    expect(bad.assertions.filter((a) => !a.passed).length).toBe(5);
    // server-side => not black-box; durably => not observable; email => not grounded
    expect(bad.violations.join(' ')).toMatch(/black-box/);
    expect(bad.violations.join(' ')).toMatch(/observable/);
    expect(bad.violations.join(' ')).toMatch(/grounded/);
  });
});
