/**
 * EXPECTED RESULT VALIDATOR — unit tests
 * ======================================
 * Locks the deterministic provability gate: every assertion is scored against
 * Observable / Grounded / Black-box. Same input → same verdict, never throws.
 *
 * Run with: npx jest tests/unit/expected-result-validator.test.ts
 */
import {
  validateAssertion,
  validateExpectedResult,
} from '../../src/engines/expected-result-validator';

describe('validateAssertion — BLACK-BOX condition', () => {
  const codeLevel = [
    'The block is enforced server-side, not merely hidden in the UI.',
    'The database row is updated correctly.',
    'The transaction is committed.',
    'The CSRF token is validated.',
    'The backend cache is invalidated.',
  ];
  it.each(codeLevel)('rejects code-level internal: %s', (a) => {
    const v = validateAssertion(a);
    expect(v.blackBox).toBe(false);
    expect(v.passed).toBe(false);
    expect(v.violations.join(' ')).toMatch(/black-box/);
  });
});

describe('validateAssertion — OBSERVABLE condition', () => {
  const internal = [
    'The record is durably saved.',
    'The input is neutralised and escaped as literal text.',
    'The payload is never executed or interpreted.',
    'There is no data corruption.',
    'The search index is refreshed.',
  ];
  it.each(internal)('rejects invisible internal-state claim: %s', (a) => {
    const v = validateAssertion(a);
    expect(v.observable).toBe(false);
    expect(v.passed).toBe(false);
    expect(v.violations.join(' ')).toMatch(/observable/);
  });
});

describe('validateAssertion — GROUNDED condition', () => {
  it('rejects an invented side-effect not present in the inputs', () => {
    const v = validateAssertion('A confirmation email is sent to the admin.', {
      requirementText: 'Add Employee: enter first name, last name and employee ID, then save.',
    });
    expect(v.grounded).toBe(false);
    expect(v.violations.join(' ')).toMatch(/grounded/);
  });

  it('ALLOWS the same side-effect when the requirement DOES mention it', () => {
    const v = validateAssertion('A confirmation email is sent to the admin.', {
      requirementText: 'On save, the system sends a confirmation email to the HR admin.',
    });
    expect(v.grounded).toBe(true);
    expect(v.passed).toBe(true);
  });
});

describe('validateAssertion — clean assertions pass all three', () => {
  const good = [
    'The Employee record is created successfully.',
    'A success confirmation message is displayed.',
    'The new Employee appears in the Employees list.',
    'The saved Employee shows the entered First Name, Last Name and Employee ID values exactly as entered.',
    'The new Employee is still shown in the Employees list after the page is refreshed.',
    'A clear "already exists" uniqueness error is shown, identifying the conflicting Employee ID.',
    'The operation is denied — no Employee is created or changed.',
    'No pop-up, alert box, or injected element appears on any Employee screen.',
    'The over-limit First Name value is rejected.',
  ];
  it.each(good)('passes: %s', (a) => {
    const v = validateAssertion(a, {
      requirementText: 'Add Employee: first name, last name, employee ID, save, appears in list.',
      profileText: 'Employees list First Name Last Name Employee ID',
    });
    expect(v.observable).toBe(true);
    expect(v.grounded).toBe(true);
    expect(v.blackBox).toBe(true);
    expect(v.passed).toBe(true);
    expect(v.violations).toEqual([]);
  });
});

describe('validateAssertion — word-boundary safety (no false positives)', () => {
  it('does not trip "sql" inside "no SQL-like error is shown" wording via unrelated words', () => {
    // "validated" must not trip "valid"; ensure common words are safe.
    const v = validateAssertion('A clear validation message is shown for the First Name field.');
    expect(v.passed).toBe(true);
  });
});

describe('validateExpectedResult — aggregate', () => {
  it('passes an all-clean list with score 1', () => {
    const r = validateExpectedResult([
      'The Employee record is created successfully.',
      'The new Employee appears in the Employees list.',
    ]);
    expect(r.passed).toBe(true);
    expect(r.score).toBe(1);
    expect(r.violations).toEqual([]);
  });

  it('fails a mixed list and reports per-assertion violations', () => {
    const r = validateExpectedResult([
      'The Employee record is created successfully.',
      'The block is enforced server-side.',
    ]);
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0.5);
    expect(r.violations.length).toBeGreaterThan(0);
  });

  it('is permissive on empty input and never throws', () => {
    expect(validateExpectedResult([]).passed).toBe(true);
    expect(validateExpectedResult(undefined).passed).toBe(true);
    expect(validateExpectedResult(null).score).toBe(1);
  });

  it('is deterministic — same input yields identical verdict', () => {
    const input = ['The new Employee appears in the Employees list.', 'The database is updated.'];
    expect(validateExpectedResult(input)).toEqual(validateExpectedResult(input));
  });
});
