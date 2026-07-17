/**
 * Unit tests for Scenario-specific Test Data (Sprint 3).
 *
 * The defect this sprint fixed: positive/coverage-default form-fill steps fell
 * through `dataPhraseFor` to a single generic placeholder ("Enter a valid First
 * Name in the First Name field"). Every generated suite therefore shipped
 * unexecutable, obviously-templated data. Sprint 3 replaces that with:
 *   - realistic, deterministic sample values selected by hash(field+scenario)
 *     so 500 generations stay varied (never one hardcoded "Emma Watson"),
 *   - field-TYPE-aware values (email → address, phone → number, number → age),
 *   - type-aware invalids for negatives (email → "not-an-email", etc.),
 *   - boundary values grounded in REAL stated constraints (max/min length),
 *   - and NEVER an invented length/range when the requirement is silent.
 *
 * Hard rule preserved: existing SQL / XSS / duplicate / whitespace intent
 * payloads are UNCHANGED — this sprint only touches generic positive data.
 *
 * Run with: npx jest tests/unit/scenario-specific-test-data.test.ts
 */

import { planScenarios } from '../../src/engines/scenario-planner';
import { buildDraftTestCases } from '../../src/engines/scenario-builder';
import type { CoverageType } from '../../src/engines/test-coverage-engine';

const FAMILIES: CoverageType[] = ['positive', 'negative', 'edge_cases'];

/* ------------------------------------------------------------------ */
/*  Fixture A — Add Employee: requirement states NO length limits       */
/* ------------------------------------------------------------------ */
const EMP_KNOWLEDGE: any = {
  applicationProfile: {
    baseUrl: 'https://demo.orangehrmlive.com/', name: 'OrangeHRM',
    forms: [{
      page: 'https://demo.orangehrmlive.com/web/index.php/pim/addEmployee',
      submitLabel: 'Save', submitSelector: 'button[type=submit]',
      fields: [
        { label: 'First Name', name: 'firstName', type: 'text', required: true, selector: 'input[name=firstName]' },
        { label: 'Last Name', name: 'lastName', type: 'text', required: true, selector: 'input[name=lastName]' },
        { label: 'Department', name: 'department', type: 'text', selector: 'input[name=department]' },
        { label: 'Notes', name: 'notes', type: 'text', selector: 'input[name=notes]' },
      ],
    }],
  },
  testData: [{ name: 'new_employee', sampleKeys: ['firstName', 'lastName'] }],
};
const EMP_REQ: any = {
  title: 'Create Employee',
  description: 'Admin can add a new employee by entering first name and last name. On save the employee is created and becomes searchable by name.',
  module: 'HR',
  acceptanceCriteria: 'Given an authorized admin, when a valid employee is submitted, then the record is created and is searchable.',
};

function build(knowledge: any, req: any): string {
  const plan = planScenarios(req, FAMILIES, undefined, undefined, false);
  const drafts = buildDraftTestCases(plan as any, knowledge, req).drafts;
  return drafts.map((d: any) => d.steps.join('\n')).join('\n');
}

const empText = build(EMP_KNOWLEDGE, EMP_REQ);

describe('Sprint 3 — generic "a valid <Field>" placeholder is eliminated', () => {
  it('never emits the generic "Enter a valid First Name / Last Name" placeholder', () => {
    expect(empText).not.toMatch(/Enter a valid First Name/);
    expect(empText).not.toMatch(/Enter a valid Last Name/);
    expect(empText).not.toMatch(/\ba valid data\b/);
  });

  it('positive First Name uses a realistic, quoted sample value', () => {
    // e.g.  Enter "Emma" in the First Name field
    expect(empText).toMatch(/Enter "[A-Z][a-z]+" in the First Name field/);
  });

  it('a recognised-but-unlisted concept like Department still gets a realistic value (not "a valid Department")', () => {
    expect(empText).not.toMatch(/a valid Department/);
    // Department is a recognised concept → a realistic department name.
    expect(empText).toMatch(/Enter "(Finance|Human Resources|Marketing|Engineering|Sales|Operations)" in the Department field/);
  });

  it('an unknown field type falls back to "Sample <Label>", never "a valid Notes"', () => {
    expect(empText).not.toMatch(/a valid Notes/);
    // "Notes" matches no concept → deterministic "Sample <Label>" fallback.
    expect(empText).toMatch(/Enter "Sample Notes" in the Notes field/);
  });
});

describe('Sprint 3 — no length/range constraint is INVENTED when the requirement is silent', () => {
  it('emits no "<n>-character maximum/minimum/limit" phrasing for the constraint-free Employee form', () => {
    expect(empText).not.toMatch(/\d+-character (maximum|minimum|limit)/);
  });
});

describe('Sprint 3 — existing SQL / XSS / duplicate / whitespace intent payloads are preserved', () => {
  it('keeps the exact SQL-injection payload', () => {
    expect(empText).toMatch(/Enter the SQL-injection string "' OR 1=1 --" in the First Name field/);
  });
  it('keeps the exact XSS payload', () => {
    expect(empText).toMatch(/Enter the XSS payload "<script>alert\(1\)<\/script>" in the First Name field/);
  });
  it('keeps the duplicate-value intent phrasing', () => {
    expect(empText).toMatch(/Enter a First Name that already exists \(a duplicate of an existing record\)/);
  });
  it('keeps the whitespace-only intent phrasing', () => {
    expect(empText).toMatch(/Enter a whitespace-only First Name \(e\.g\. "   "\)/);
  });
});

/* ------------------------------------------------------------------ */
/*  Fixture B — Register Account: constraint-bearing, typed fields      */
/* ------------------------------------------------------------------ */
const REG_KNOWLEDGE: any = {
  applicationProfile: {
    baseUrl: 'https://example.com/', name: 'AcmePortal',
    forms: [{
      page: 'https://example.com/register',
      submitLabel: 'Register', submitSelector: 'button[type=submit]',
      fields: [
        { label: 'Username', name: 'username', type: 'text', required: true, selector: 'input[name=username]' },
        { label: 'Email', name: 'email', type: 'email', required: true, selector: 'input[name=email]' },
        { label: 'Phone', name: 'phone', type: 'tel', selector: 'input[name=phone]' },
        { label: 'Age', name: 'age', type: 'number', selector: 'input[name=age]' },
      ],
    }],
  },
  testData: [{ name: 'new_user', sampleKeys: ['username', 'email'] }],
};
const REG_REQ: any = {
  title: 'Register Account',
  description: 'A visitor registers by entering a username, email, phone and age. The username must be at most 20 characters and at least 3 characters. The email must be a valid format. Age must be a number.',
  module: 'Accounts',
  acceptanceCriteria: 'Given valid details, when the visitor registers, then the account is created and a confirmation email is sent.',
};

const regText = build(REG_KNOWLEDGE, REG_REQ);

describe('Sprint 3 — field-TYPE-aware positive values', () => {
  it('an email field gets a realistic address, not a name', () => {
    expect(regText).toMatch(/Enter "[a-z0-9.]+@[a-z0-9.]+\.[a-z]+" in the Email field/i);
  });
  it('a phone (tel) field gets a numeric phone value', () => {
    expect(regText).toMatch(/Enter "\d{10}" in the Phone field/);
  });
});

describe('Sprint 3 — type-aware invalids for negative scenarios', () => {
  it('email negative uses "not-an-email", not "an invalid Email"', () => {
    expect(regText).toMatch(/an invalid email address \(e\.g\. "not-an-email"\)/);
    expect(regText).not.toMatch(/Enter an invalid Email in the Email field/);
  });
  it('phone negative uses a type-aware invalid number example', () => {
    expect(regText).toMatch(/an invalid phone number \(e\.g\. "123"\)/);
  });
  it('numeric (age) negative uses an out-of-range number example', () => {
    expect(regText).toMatch(/an out-of-range number \(e\.g\. "-1"\)/);
  });
});

describe('Sprint 3 — boundary values are grounded in the REAL stated constraint', () => {
  it('username boundary references the stated 20-character limit (not an arbitrary MAX+1)', () => {
    expect(regText).toMatch(/values of 19, 20 and 21 characters \(below, at and above the 20-character limit\)/);
  });
  it('does NOT invent a max-length for Email / Phone / Age (requirement is silent on those)', () => {
    const typedLines = regText
      .split('\n')
      .filter((l) => /\b(Email|Phone|Age)\b/.test(l))
      .join('\n');
    expect(typedLines).not.toMatch(/\d+-character (maximum|minimum|limit)/);
  });
});
