/**
 * SPRINT 3 — Scenario-specific Test Data: before/after proof.
 *
 * Two fixtures:
 *   A) Add Employee (no stated constraints) — proves realistic, type-aware
 *      positive values replace generic "a valid First Name", with NO invented
 *      length numbers.
 *   B) A constraint-bearing "Register Account" requirement (email, phone, age,
 *      username with a stated max length) — proves type-aware invalids and
 *      requirement-grounded boundary values, and that constraints are NEVER
 *      invented for fields the requirement is silent about.
 *
 * Run: npx ts-node scripts/testdata-proof.ts
 */
import { planScenarios } from '../src/engines/scenario-planner';
import { buildDraftTestCases } from '../src/engines/scenario-builder';
import type { CoverageType } from '../src/engines/test-coverage-engine';

const FAMILIES: CoverageType[] = ['positive', 'negative', 'edge_cases'];
let failures = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? '✅' : '❌'} ${m}`); if (!c) failures++; };

/* ---------------- Fixture A — Add Employee (no constraints) ---------------- */
const EMP_KNOWLEDGE: any = {
  applicationProfile: {
    baseUrl: 'https://demo.orangehrmlive.com/', name: 'OrangeHRM',
    forms: [{
      page: 'https://demo.orangehrmlive.com/web/index.php/pim/addEmployee',
      submitLabel: 'Save', submitSelector: 'button[type=submit]',
      fields: [
        { label: 'First Name', name: 'firstName', type: 'text', required: true, selector: 'input[name=firstName]' },
        { label: 'Last Name', name: 'lastName', type: 'text', required: true, selector: 'input[name=lastName]' },
      ],
    }],
  },
  testData: [{ name: 'new_employee', sampleKeys: ['employeeId', 'firstName', 'lastName'] }],
};
const EMP_REQ: any = {
  title: 'Create Employee',
  description: 'Admin can add a new employee by entering first name and last name. On save the employee is created and becomes searchable by name.',
  module: 'HR',
  acceptanceCriteria: 'Given an authorized admin, when a valid employee is submitted, then the record is created and is searchable.',
};

const empPlan = planScenarios(EMP_REQ, FAMILIES, undefined, undefined, false);
const empDrafts = buildDraftTestCases(empPlan as any, EMP_KNOWLEDGE, EMP_REQ).drafts;
const empText = empDrafts.map((d: any) => d.steps.join(' ')).join('\n');

console.log('\n=== Fixture A — Add Employee (requirement states NO length limits) ===');
ok(!/Enter a valid First Name|Enter a valid Last Name/.test(empText), 'No generic "a valid First/Last Name" anywhere');
ok(/Enter "[A-Z][a-z]+" in the First Name field/.test(empText), 'Positive First Name uses a realistic quoted value (e.g. "Emma")');
ok(!/\d+-character (maximum|minimum|limit)/.test(empText), 'No INVENTED length number (requirement stated none)');

/* --------- Fixture B — Register Account (constraint-bearing fields) --------- */
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

const regPlan = planScenarios(REG_REQ, FAMILIES, undefined, undefined, false);
const regDrafts = buildDraftTestCases(regPlan as any, REG_KNOWLEDGE, REG_REQ).drafts;
const regText = regDrafts.map((d: any) => d.steps.join(' ')).join('\n');

console.log('\n=== Fixture B — Register Account (username max 20 / min 3 stated) ===');
ok(/Enter "[a-z0-9.]+@[a-z0-9.]+" in the Email field/i.test(regText), 'Positive Email uses a realistic address value');
ok(/an invalid email address \(e\.g\. "not-an-email"\)/.test(regText), 'Negative Email uses a type-aware invalid, not "an invalid Email"');
// Boundary grounding: SOME scenario must reference the real 20-char maximum.
ok(/21 characters \(1 over the 20-character maximum\)|20-character limit/.test(regText), 'Boundary Username grounded in the stated 20-character maximum');
ok(!/\d+-character maximum/.test(regText.split('\n').filter((l) => /Email|Phone|Age/.test(l)).join('\n')), 'No max-length invented for Email/Phone/Age (requirement stated none for them)');

console.log(`\n${failures === 0 ? '✅ ALL PROOFS PASS' : `❌ ${failures} PROOF(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
