/**
 * SCENARIO CORRECTNESS (TRUST) TESTS
 * ==================================
 * Sprint 2. These lock the three internal-consistency guarantees the founder
 * demanded before any further coverage work. They are the anti-regression net
 * for the trust defect where an "Add Employee" case was emitted with login
 * fields (Username/Password/_token) in its steps AND marked Automation Ready.
 *
 * The three rules under test — all DETERMINISTIC, no LLM:
 *   1. Scenario ↔ Fields  : steps only reference fields that exist for the
 *      feature. When no form matches, we DO NOT fall back to a foreign form.
 *   2. Scenario ↔ Test Data: the payload matches the validation intent
 *      (SQL, XSS, duplicate, ...), not a single hard-coded value.
 *   3. Scenario ↔ Automation Ready: a case is only Automation Ready when it is
 *      grounded on the feature's real form with real selectors; otherwise it is
 *      Needs Review with an explicit reason.
 *
 * Run with: npx jest tests/unit/scenario-correctness.test.ts
 */

import { planScenarios } from '../../src/engines/scenario-planner';
import { buildDraftTestCases, AUTOMATION_GATING_CHECKS } from '../../src/engines/scenario-builder';
import { checks, validateScenarioIntegrity } from '../../src/engines/scenario-integrity';
import type { CoverageType } from '../../src/engines/test-coverage-engine';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// The requirement is "Add Employee" — a CRUD feature that has NOTHING to do
// with the login form.
const ADD_EMPLOYEE_REQ = {
  title: 'Add Employee',
  description:
    'An HR admin adds a new employee by entering their first name, last name and a unique employee ID, then saving the record.',
  acceptanceCriteria:
    'A new employee is created with valid data; a duplicate employee ID is rejected; malicious input is handled safely.',
  businessFlow:
    'Open the Add Employee form → enter first name + last name + employee ID → save → the employee appears in the list.',
};

// App Profile that ONLY knows about the login form (this is the exact trap that
// used to leak login fields into Add Employee steps).
const LOGIN_ONLY_PROFILE = {
  baseUrl: 'https://app.example.com',
  name: 'Example App',
  loginUrl: 'https://app.example.com/login',
  pages: [{ url: 'https://app.example.com/login', title: 'Login', pageType: 'auth' }],
  forms: [
    {
      page: 'https://app.example.com/login',
      action: '/session',
      method: 'POST',
      submitSelector: '#login-btn',
      fields: [
        { name: 'username', type: 'text', required: true, selector: '#username', label: 'Username' },
        { name: 'password', type: 'password', required: true, selector: '#password', label: 'Password' },
        { name: '_token', type: 'hidden', required: true, selector: '#_token', label: '_token' },
      ],
    },
  ],
  keyElements: [{ label: 'Login', tag: 'button', selector: '#login-btn', role: 'button' }],
};

// App Profile that actually knows the Add Employee form.
const EMPLOYEE_PROFILE = {
  baseUrl: 'https://app.example.com',
  name: 'Example App',
  loginUrl: 'https://app.example.com/login',
  pages: [
    { url: 'https://app.example.com/login', title: 'Login', pageType: 'auth' },
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

const loginKnowledge = (): any => ({ applicationProfile: LOGIN_ONLY_PROFILE, testData: [] });
const employeeKnowledge = (): any => ({ applicationProfile: EMPLOYEE_PROFILE, testData: [] });

const COVERAGE: CoverageType[] = ['positive', 'negative'];

const stepsOf = (d: any): string => (d.steps || []).join(' ').toLowerCase();

// ---------------------------------------------------------------------------
// Rule 1 — Scenario ↔ Fields  (+ Rule 3 gating when NO form matches)
// ---------------------------------------------------------------------------

describe('Rule 1 — no foreign fields leak in (Add Employee vs login-only profile)', () => {
  const plan = planScenarios(ADD_EMPLOYEE_REQ, COVERAGE, 'crud');
  const { drafts } = buildDraftTestCases(plan, loginKnowledge(), ADD_EMPLOYEE_REQ);

  // The ONE scenario that legitimately concerns the login page: an auth-guard
  // check ("unauthenticated user is redirected to login"). Grounding THIS on the
  // login form is CORRECT — it is about login — so it is excluded from the
  // "no login fields" assertion. The trust bug was never this scenario; it was
  // the CREATE / field-level / injection scenarios (Add-Employee DATA) being
  // poured into login fields. Those are the surface we lock down here.
  const isLoginRelated = (d: any) =>
    /unauthenticated|redirect/i.test(d.scenarioId) || /redirected to login/i.test(d.title);
  const bugSurface = drafts.filter((d) => !isLoginRelated(d));

  it('produces drafts (and a real bug surface of non-login scenarios)', () => {
    expect(drafts.length).toBeGreaterThan(0);
    expect(bugSurface.length).toBeGreaterThan(0);
  });

  it('NEVER pours Add-Employee data into login fields (username / password / _token)', () => {
    for (const d of bugSurface) {
      const text = stepsOf(d);
      expect(text).not.toContain('username');
      expect(text).not.toContain('password');
      expect(text).not.toContain('_token');
    }
  });

  it('marks every ungrounded (non-login) case Needs Review and NOT Automation Ready, with a reason', () => {
    for (const d of bugSurface) {
      expect(d.automationReady).toBe(false);
      expect(d.needsReview).toBe(true);
      expect(Array.isArray(d.reviewReasons)).toBe(true);
      expect(d.reviewReasons.length).toBeGreaterThan(0);
      expect(d.reviewReasons.join(' ')).toMatch(/no form|matches the|ungrounded/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Rule 1 (positive) + Rule 3 — correct grounding when the real form exists
// ---------------------------------------------------------------------------

describe('Rule 1/3 — grounds on the REAL employee form when the profile has it', () => {
  const plan = planScenarios(ADD_EMPLOYEE_REQ, COVERAGE, 'crud');
  const { drafts } = buildDraftTestCases(plan, employeeKnowledge(), ADD_EMPLOYEE_REQ);

  it('references the employee fields, not the login fields', () => {
    const posCreate = drafts.find((d) => d.coverageType === 'positive') || drafts[0];
    const text = stepsOf(posCreate);
    const referencesEmployeeField =
      text.includes('first name') || text.includes('last name') || text.includes('employee id');
    expect(referencesEmployeeField).toBe(true);
    expect(text).not.toContain('password');
  });

  it('exposes the feature real fields on applicationFields', () => {
    const d = drafts[0];
    expect(d.applicationFields).toEqual(
      expect.arrayContaining(['First Name', 'Last Name', 'Employee ID']),
    );
    expect(d.applicationFields).not.toContain('Password');
  });

  it('marks grounded cases Automation Ready and NOT Needs Review', () => {
    const grounded = drafts.filter((d) => d.grounded);
    expect(grounded.length).toBeGreaterThan(0);
    for (const d of grounded) {
      expect(d.automationReady).toBe(true);
      expect(d.needsReview).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — intent-driven test data
// ---------------------------------------------------------------------------

describe('Rule 2 — test data matches the validation intent', () => {
  const plan = planScenarios(ADD_EMPLOYEE_REQ, COVERAGE, 'crud');
  const { drafts } = buildDraftTestCases(plan, employeeKnowledge(), ADD_EMPLOYEE_REQ);

  const dataOf = (d: any): string =>
    [d.testData, ...(d.steps || [])].join(' ');

  it('uses a SQL-injection payload for the SQL-injection scenario', () => {
    const sql = drafts.find((d) => /sql/i.test(d.scenarioId) || /sql/i.test(d.title));
    expect(sql).toBeTruthy();
    expect(dataOf(sql)).toContain("' OR 1=1 --");
  });

  it('uses a script payload for the XSS scenario', () => {
    const xss = drafts.find((d) => /xss/i.test(d.scenarioId) || /xss|script/i.test(d.title));
    expect(xss).toBeTruthy();
    expect(dataOf(xss)).toContain('<script>alert(1)</script>');
  });

  it('does NOT reuse the same hard-coded value across different intents', () => {
    const sql = drafts.find((d) => /sql/i.test(d.scenarioId) || /sql/i.test(d.title));
    const xss = drafts.find((d) => /xss/i.test(d.scenarioId) || /xss|script/i.test(d.title));
    if (sql && xss) {
      expect(dataOf(sql)).not.toEqual(dataOf(xss));
    }
  });
});

// ---------------------------------------------------------------------------
// Rule 3 (full) — automation readiness is GATED on the deterministic integrity
// report. The product rule: one wrong dimension ⇒ Needs Review, never
// Automation Ready. This is a CONTRACT/property test over real builder output.
// ---------------------------------------------------------------------------

describe('Rule 3 (gate) — Automation Ready requires a clean correctness report', () => {
  const plan = planScenarios(ADD_EMPLOYEE_REQ, COVERAGE, 'crud');
  const { drafts } = buildDraftTestCases(plan, employeeKnowledge(), ADD_EMPLOYEE_REQ);

  const reportFor = (d: any) =>
    validateScenarioIntegrity({
      title: d.title,
      objective: d.objective,
      coverageType: d.coverageType,
      preconditions: d.preconditions,
      steps: d.steps,
      grounding: d.grounding,
      expected: d.expected,
      expectedResult: d.expectedResult,
      testData: d.testData,
      applicationFields: d.applicationFields,
    });

  it('never marks a case Automation Ready while a gating check is failing', () => {
    for (const d of drafts) {
      if (!d.automationReady) continue;
      const report = reportFor(d);
      const failingGates = report.checks.filter(
        (c: any) => AUTOMATION_GATING_CHECKS.has(c.id) && !c.passed,
      );
      expect(failingGates).toEqual([]);
    }
  });

  it('when a gating check fails, the case is Needs Review (not Automation Ready)', () => {
    for (const d of drafts) {
      const report = reportFor(d);
      const failing = report.checks.filter(
        (c: any) => AUTOMATION_GATING_CHECKS.has(c.id) && !c.passed,
      );
      if (failing.length > 0) {
        expect(d.automationReady).toBe(false);
        expect(d.needsReview).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The Step Validator itself — checkFieldValidity (deterministic, no LLM)
// ---------------------------------------------------------------------------

describe('Step Validator — checkFieldValidity', () => {
  const KNOWN = ['First Name', 'Last Name', 'Employee ID'];

  it('FAILS when a step references a field the feature does not have', () => {
    const r = checks.checkFieldValidity({
      title: 'Add Employee',
      steps: ['Enter a value in the Username field', 'Enter a value in the First Name field'],
      applicationFields: KNOWN,
    } as any);
    expect(r.score).toBe(0);
    expect(r.messages.join(' ')).toMatch(/Username/);
  });

  it('PASSES when every referenced field exists for the feature', () => {
    const r = checks.checkFieldValidity({
      title: 'Add Employee',
      steps: ['Enter a value in the First Name field', 'Enter a value in the Employee ID field'],
      applicationFields: KNOWN,
    } as any);
    expect(r.score).toBe(1);
  });

  it('is fail-open: PASSES (skips) when applicationFields is empty', () => {
    const r = checks.checkFieldValidity({
      title: 'Add Employee',
      steps: ['Enter a value in the Username field'],
      applicationFields: [],
    } as any);
    expect(r.score).toBe(1);
  });

  it('ignores the generic "field" fallback label', () => {
    const r = checks.checkFieldValidity({
      title: 'Add Employee',
      steps: ['Enter a value in the field'],
      applicationFields: KNOWN,
    } as any);
    expect(r.score).toBe(1);
  });
});
