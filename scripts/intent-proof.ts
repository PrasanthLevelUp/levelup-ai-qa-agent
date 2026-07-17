/**
 * SPRINT 2 — Intent-aware Step Generator :: BEFORE/AFTER PROOF
 *
 * Proves the sprint deliverable on the SAME faithful profiles used for Gate 0:
 *   • Add Employee requirement — reproduces authorization / authentication /
 *     direct-URL placeholders.
 *   • Checkout requirement — reproduces the session-timeout placeholder.
 *
 * BEFORE values are the recorded Gate 0 reproduction (all held intents emitted
 * the skeleton "Exercise the <title> scenario"). AFTER values are computed live.
 * Also verifies the intents Sprint 1 already handled (search / cancel / file
 * upload) did NOT regress.
 *
 * Run: npx ts-node scripts/intent-proof.ts
 */
import { planScenarios } from '../src/engines/scenario-planner';
import { buildDraftTestCases, classifyGroundingIntent, classifyHeldIntent } from '../src/engines/scenario-builder';
import { getScenarioStepFlow } from '../src/engines/qa-knowledge-engine';
import type { CoverageType } from '../src/engines/test-coverage-engine';

const FAMILIES: CoverageType[] = ['positive', 'negative', 'edge_cases'];
const isPlaceholder = (steps: string[]) => steps.some((s) => /Exercise the ".*" scenario/.test(s));

/* ---- Add Employee (mixed profile: Add form w/o "employee" token + search form) ---- */
const ADD_FORM = {
  page: 'https://demo.orangehrmlive.com/web/index.php/pim/addEmployee',
  submitLabel: 'Save', submitSelector: 'button[type=submit]',
  fields: [
    { label: 'First Name', name: 'firstName', type: 'text', required: true, selector: 'input[name=firstName]' },
    { label: 'Last Name', name: 'lastName', type: 'text', required: true, selector: 'input[name=lastName]' },
    { label: 'Profile Photo', name: 'photo', type: 'file', selector: 'input[type=file]' },
  ],
};
const SEARCH_FORM = {
  page: 'https://demo.orangehrmlive.com/web/index.php/pim/viewEmployeeList',
  submitLabel: 'Search', submitSelector: 'button.oxd-button--search',
  fields: [
    { label: 'Type for hints...', name: 'employeeName', type: 'text', selector: 'input.oxd-input' },
    { label: 'Enter comma separated words...', name: 'tags', type: 'text', selector: 'input.tags' },
  ],
};
const EMP_KNOW: any = {
  applicationProfile: { baseUrl: 'https://demo.orangehrmlive.com/', name: 'OrangeHRM', forms: [ADD_FORM, SEARCH_FORM] },
  testData: [{ name: 'new_employee', sampleKeys: ['employeeId', 'firstName', 'lastName'] }],
};
const EMP_REQ: any = {
  title: 'Create Employee',
  description: 'Admin can add a new employee by entering first name, last name and an optional profile photo. On save the employee is created and becomes searchable by ID and by name.',
  module: 'HR', acceptanceCriteria: 'Given an authorized admin, when a valid employee is submitted, then the record is created, a success notification is shown, and the employee is searchable.',
};

/* ---- Checkout (for the session-timeout intent) ---- */
const CO_KNOW: any = {
  applicationProfile: { baseUrl: 'https://shop.example.com/', name: 'Shop', forms: [{ page: 'https://shop.example.com/checkout', submitLabel: 'Place Order', submitSelector: 'button#place', fields: [{ label: 'Card Number', name: 'card', type: 'text', selector: '#card' }, { label: 'Expiry', name: 'exp', type: 'text', selector: '#exp' }] }] },
  testData: [],
};
const CO_REQ: any = { title: 'Checkout', description: 'User completes checkout by entering card number and expiry then places the order. Session may expire during checkout.', module: 'Commerce', acceptanceCriteria: 'Given a cart, when the user checks out with valid payment, then an order is placed. Session timeout / expire during checkout must be handled.' };

function draftsFor(req: any, know: any) {
  const plan = planScenarios(req, FAMILIES, undefined, undefined, false);
  const drafts = buildDraftTestCases(plan as any, know, req).drafts;
  return plan.scenarios.map((s: any, i: number) => ({ s, d: drafts[i] }));
}

const emp = draftsFor(EMP_REQ, EMP_KNOW);
const co = draftsFor(CO_REQ, CO_KNOW);
const all = [...emp, ...co];

// Find one representative draft per held intent.
function pick(intent: string) {
  return all.find(({ s }) => {
    const g = classifyGroundingIntent({ id: s.id, riskArea: s.riskArea, stepFlow: getScenarioStepFlow(s) ?? undefined });
    if (g !== 'authorization') return false;
    return classifyHeldIntent({ id: s.id, riskArea: s.riskArea, title: s.title }) === intent;
  });
}

console.log('\n════════ SPRINT 2 PROOF — Intent-aware Step Generator ════════\n');
console.log('| Intent          | Before (Gate 0)          | After                                   |');
console.log('|-----------------|--------------------------|-----------------------------------------|');
const rows: Array<[string, string]> = [
  ['authorization', 'authorization'], ['authentication', 'authentication'],
  ['session', 'session'], ['direct_url', 'direct_url'],
];
let allDeterministic = true;
for (const [label, intent] of rows) {
  const hit = pick(intent);
  if (!hit) { console.log(`| ${label.padEnd(15)} | (not emitted)            | —                                       |`); continue; }
  const ph = isPlaceholder(hit.d.steps);
  if (ph) allDeterministic = false;
  const after = ph ? 'STILL PLACEHOLDER ❌' : `Deterministic ✓ (${hit.d.steps.length} steps)`;
  console.log(`| ${label.padEnd(15)} | Placeholder ❌            | ${after.padEnd(39)} |`);
}

// Sprint-1 intents that must NOT regress.
console.log('\n──── No-regression check (Sprint 1 intents) ────');
const search = emp.filter(({ s }) => getScenarioStepFlow(s) === 'search');
const cancel = emp.filter(({ s }) => getScenarioStepFlow(s) === 'cancel');
const upload = emp.filter(({ s }) => /upload/i.test(s.id) || /file/i.test(s.riskArea));
const searchOk = search.length > 0 && search.every(({ d }) => !isPlaceholder(d.steps) && d.steps.some((x: string) => /search results|records list/i.test(x)));
const cancelOk = cancel.length > 0 && cancel.every(({ d }) => !isPlaceholder(d.steps) && d.steps.some((x: string) => /Cancel/.test(x)));
const uploadOk = upload.length > 0 && upload.every(({ d }) => !isPlaceholder(d.steps) && d.steps.some((x: string) => /^Upload /.test(x)));
console.log(`SEARCH  (${search.length}) still create-then-find, no placeholder : ${searchOk ? 'PASS ✓' : 'FAIL ❌'}`);
console.log(`CANCEL  (${cancel.length}) still uses Cancel action, no placeholder : ${cancelOk ? 'PASS ✓' : 'FAIL ❌'}`);
console.log(`UPLOAD  (${upload.length}) still says "Upload", not "Enter"         : ${uploadOk ? 'PASS ✓' : 'FAIL ❌'}`);

// Overall placeholder counts.
const empPh = emp.filter(({ d }) => isPlaceholder(d.steps)).length;
const coPh = co.filter(({ d }) => isPlaceholder(d.steps)).length;
console.log('\n──── Overall placeholder counts ────');
console.log(`Add Employee: ${empPh}/${emp.length} placeholders (Gate 0 before: 3)`);
console.log(`Checkout:     ${coPh}/${co.length} placeholders (Gate 0 before: 1)`);

// Honest-hold invariant: no held scenario fabricated form-fill.
const leaked = all.filter(({ s, d }) => {
  const g = classifyGroundingIntent({ id: s.id, riskArea: s.riskArea, stepFlow: getScenarioStepFlow(s) ?? undefined });
  return g === 'authorization' && /First Name|Last Name|Profile Photo|Card Number/.test(d.steps.join(' '));
});
console.log('\n──── Honest-hold invariant ────');
console.log(`Held scenarios that fabricated form-fill steps: ${leaked.length} (target 0) ${leaked.length === 0 ? '✓' : '❌'}`);

// Held scenarios remain Needs Review, never Automation Ready.
const heldDrafts = all.filter(({ s }) => classifyGroundingIntent({ id: s.id, riskArea: s.riskArea, stepFlow: getScenarioStepFlow(s) ?? undefined }) === 'authorization');
const wrongReady = heldDrafts.filter(({ d }) => d.automationReady).length;
console.log(`Held scenarios wrongly marked Automation Ready: ${wrongReady} (target 0) ${wrongReady === 0 ? '✓' : '❌'}`);

console.log('\n════════ RESULT: ' + (allDeterministic && searchOk && cancelOk && uploadOk && empPh === 0 && coPh === 0 && leaked.length === 0 && wrongReady === 0 ? 'ALL PROOFS PASS ✓' : 'FAILURES PRESENT ❌') + ' ════════\n');
