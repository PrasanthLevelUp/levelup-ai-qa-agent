/**
 * SPRINT 2 — manual-inspection render of the Add Employee suite.
 * Emits a readable markdown of EVERY generated scenario (intent, review status,
 * full steps) so a human can eyeball that: no placeholders remain; authorization
 * scenarios do not look like form-entry; search uses search actions; cancel uses
 * cancel actions; file upload says "Upload" not "Enter".
 *
 * Run: npx ts-node scripts/intent-render.ts > ../SPRINT2_ADD_EMPLOYEE_OUTPUT.md
 */
import { planScenarios } from '../src/engines/scenario-planner';
import { buildDraftTestCases, classifyGroundingIntent, classifyHeldIntent } from '../src/engines/scenario-builder';
import { getScenarioStepFlow } from '../src/engines/qa-knowledge-engine';
import type { CoverageType } from '../src/engines/test-coverage-engine';

const ADD_FORM = {
  page: 'https://demo.orangehrmlive.com/web/index.php/pim/addEmployee',
  submitLabel: 'Save', submitSelector: 'button[type=submit]',
  fields: [
    { label: 'First Name', name: 'firstName', type: 'text', required: true, selector: 'input[name=firstName]' },
    { label: 'Middle Name', name: 'middleName', type: 'text', selector: 'input[name=middleName]' },
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
const KNOWLEDGE: any = {
  applicationProfile: { baseUrl: 'https://demo.orangehrmlive.com/', name: 'OrangeHRM', forms: [ADD_FORM, SEARCH_FORM] },
  testData: [{ name: 'new_employee', sampleKeys: ['employeeId', 'firstName', 'lastName'] }, { name: 'duplicate_employee', sampleKeys: ['employeeId', 'firstName', 'lastName'] }],
};
const REQ: any = {
  title: 'Create Employee',
  description: 'Admin can add a new employee by entering first name, last name and an optional profile photo. Employee ID may be auto-generated. On save the employee is created and becomes searchable by ID and by name. Only authorized admins may access the form.',
  module: 'HR', acceptanceCriteria: 'Given an authorized admin, when a valid employee is submitted, then the record is created, a success notification is shown, and the employee is searchable.',
};
const FAMILIES: CoverageType[] = ['positive', 'negative', 'edge_cases'];

const plan = planScenarios(REQ, FAMILIES, undefined, undefined, false);
const drafts = buildDraftTestCases(plan as any, KNOWLEDGE, REQ).drafts;

const isPlaceholder = (steps: string[]) => steps.some((s) => /Exercise the ".*" scenario/.test(s));
let placeholders = 0, ready = 0;

console.log('# Sprint 2 — Add Employee regenerated output (manual inspection)\n');
console.log(`Requirement: **${REQ.title}** · scenarios: **${plan.scenarios.length}**\n`);
console.log('Legend: 🟢 Automation Ready · 🟡 Needs Review · intent shown per scenario.\n');

plan.scenarios.forEach((s: any, i: number) => {
  const d: any = drafts[i];
  const g = classifyGroundingIntent({ id: s.id, riskArea: s.riskArea, stepFlow: getScenarioStepFlow(s) ?? undefined });
  const label = g === 'authorization' ? `held:${classifyHeldIntent({ id: s.id, riskArea: s.riskArea, title: s.title })}` : g;
  if (isPlaceholder(d.steps)) placeholders++;
  if (d.automationReady) ready++;
  const badge = d.automationReady ? '🟢' : '🟡';
  console.log(`### ${i + 1}. ${badge} ${s.title}`);
  console.log(`- id: \`${s.id}\` · intent: **${label}** · placeholder: ${isPlaceholder(d.steps) ? '**YES ❌**' : 'no'}`);
  console.log('- steps:');
  (d.steps as string[]).forEach((st, k) => console.log(`  ${k + 1}. ${st}`));
  if (d.needsReview) console.log(`- ⚠️ review: ${d.reviewReasons[0]}`);
  console.log('');
});

console.log('---\n## Summary\n');
console.log(`- Placeholder steps: **${placeholders}** (target 0)`);
console.log(`- Automation Ready: **${ready}/${plan.scenarios.length}** (${Math.round((ready / plan.scenarios.length) * 100)}%)`);
console.log(`- Needs Review (held non-form intents + any ungrounded): **${plan.scenarios.length - ready}**`);
