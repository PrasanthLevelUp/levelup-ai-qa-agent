/**
 * SPRINT 2 — Intent-aware Step Generator :: GATE 0 (mandatory reproduction)
 *
 * Purpose: BEFORE writing any implementation, reproduce the CURRENT builder
 * output for every scenario intent in the roadmap and record whether each one
 * is a defect (an honest skeleton placeholder) or already correct. Scope for the
 * sprint is then set BY THIS EVIDENCE — we only implement intents that actually
 * reproduce as placeholders. (User rule: "the roadmap follows the reproductions,
 * not the other way around.")
 *
 * Uses the SAME faithful OrangeHRM mixed profile that reproduced the CSV in
 * Sprint 1 (Add Employee form WITHOUT the incidental "employee" token + a
 * foreign Employee-Search filter form).
 *
 * Run: npx ts-node scripts/intent-gate0.ts
 */
import { planScenarios } from '../src/engines/scenario-planner';
import {
  buildDraftTestCases,
  classifyGroundingIntent,
  type ScenarioGroundingIntent,
} from '../src/engines/scenario-builder';
import { getScenarioStepFlow } from '../src/engines/qa-knowledge-engine';
import type { CoverageType } from '../src/engines/test-coverage-engine';

const ADD_FORM = {
  page: 'https://demo.orangehrmlive.com/web/index.php/pim/addEmployee',
  submitLabel: 'Save',
  submitSelector: 'button[type=submit]',
  fields: [
    { label: 'First Name', name: 'firstName', type: 'text', required: true, selector: 'input[name=firstName]' },
    { label: 'Middle Name', name: 'middleName', type: 'text', selector: 'input[name=middleName]' },
    { label: 'Last Name', name: 'lastName', type: 'text', required: true, selector: 'input[name=lastName]' },
    { label: 'Profile Photo', name: 'photo', type: 'file', selector: 'input[type=file]' },
  ],
};
const SEARCH_FORM = {
  page: 'https://demo.orangehrmlive.com/web/index.php/pim/viewEmployeeList',
  submitLabel: 'Search',
  submitSelector: 'button.oxd-button--search',
  fields: [
    { label: 'Type for hints...', name: 'employeeName', type: 'text', selector: 'input.oxd-input' },
    { label: 'Enter comma separated words...', name: 'tags', type: 'text', selector: 'input.tags' },
    { label: 'From', name: 'fromDate', type: 'date', selector: 'input.from' },
  ],
};
const KNOWLEDGE: any = {
  applicationProfile: {
    baseUrl: 'https://demo.orangehrmlive.com/',
    name: 'OrangeHRM',
    pages: [
      { url: ADD_FORM.page, title: 'PIM', pageType: 'form' },
      { url: SEARCH_FORM.page, title: 'Employee List', pageType: 'list' },
    ],
    forms: [ADD_FORM, SEARCH_FORM],
  },
  testData: [
    { name: 'new_employee', sampleKeys: ['employeeId', 'firstName', 'lastName'] },
    { name: 'duplicate_employee', sampleKeys: ['employeeId', 'firstName', 'lastName'] },
  ],
};
const EMPLOYEE_REQ = {
  title: 'Create Employee',
  description:
    'Admin can add a new employee by entering first name, last name, employee ID and an optional profile photo. ' +
    'Employee ID may be auto-generated or entered manually and must be unique. On save the employee is created and ' +
    'becomes searchable by ID and by name.',
  module: 'HR / Employee Management',
  businessFlow:
    'Admin opens Add Employee form → fills fields → uploads photo → saves → sees confirmation → employee searchable',
  acceptanceCriteria:
    'Given an authorized admin, when a valid employee is submitted, then the record is created, a success ' +
    'notification is shown, the user is redirected to the employee list, and the new employee is immediately ' +
    'searchable by ID and name.',
};
const FAMILIES: CoverageType[] = ['positive', 'negative', 'edge_cases'];

// Roadmap intent buckets — we sub-classify the coarse `authorization` intent by
// canonical id so Gate 0 can tell authorization vs authentication vs session vs
// direct-URL apart (they currently collapse into one held bucket).
function roadmapBucket(id: string, intent: ScenarioGroundingIntent): string {
  const i = (id || '').toLowerCase();
  if (intent === 'authorization') {
    if (/unauthenticated|redirect/.test(i)) return 'AUTHENTICATION';
    if (/session|timeout/.test(i)) return 'SESSION';
    if (/direct-endpoint|direct-url|direct/.test(i)) return 'DIRECT_URL';
    return 'AUTHORIZATION';
  }
  if (intent === 'search') return 'SEARCH';
  if (intent === 'navigation') return 'CANCEL/NAV';
  if (intent === 'file_upload') return 'FILE_UPLOAD';
  return 'FORM_ENTRY';
}

const isPlaceholder = (steps: string[]) => steps.some((s) => /Exercise the ".*" scenario/.test(s));

const plan = planScenarios(EMPLOYEE_REQ as any, FAMILIES, undefined, undefined, false);
const drafts = buildDraftTestCases(plan as any, KNOWLEDGE as any, EMPLOYEE_REQ as any).drafts;

console.log('\n════════ GATE 0 — CURRENT OUTPUT PER SCENARIO ════════\n');
const byBucket: Record<string, { total: number; placeholder: number; ids: string[] }> = {};
for (let i = 0; i < plan.scenarios.length; i++) {
  const s: any = plan.scenarios[i];
  const d: any = drafts[i];
  const intent = classifyGroundingIntent({ id: s.id, riskArea: s.riskArea, stepFlow: getScenarioStepFlow(s) ?? undefined });
  const bucket = roadmapBucket(s.id, intent);
  const ph = isPlaceholder(d.steps);
  byBucket[bucket] ??= { total: 0, placeholder: 0, ids: [] };
  byBucket[bucket].total++;
  if (ph) byBucket[bucket].placeholder++;
  byBucket[bucket].ids.push(s.id);
  if (['AUTHORIZATION', 'AUTHENTICATION', 'SESSION', 'DIRECT_URL', 'SEARCH', 'CANCEL/NAV', 'FILE_UPLOAD'].includes(bucket)) {
    console.log(`[${bucket}] id=${s.id}  risk="${s.riskArea}"  stepFlow=${getScenarioStepFlow(s) ?? '—'}  placeholder=${ph ? 'YES ❌' : 'no'}`);
    console.log(`    title: ${s.title}`);
    console.log(`    steps: ${JSON.stringify(d.steps)}`);
    console.log('');
  }
}

console.log('\n════════ GATE 0 SUMMARY — DEFECT REPRODUCTION BY INTENT ════════\n');
const order = ['FORM_ENTRY', 'FILE_UPLOAD', 'SEARCH', 'CANCEL/NAV', 'AUTHORIZATION', 'AUTHENTICATION', 'SESSION', 'DIRECT_URL'];
for (const b of order) {
  const v = byBucket[b];
  if (!v) { console.log(`${b.padEnd(16)} — NOT EMITTED by planner (no scenario of this intent)`); continue; }
  const verdict = v.placeholder > 0 ? `DEFECT (${v.placeholder}/${v.total} placeholder) ❌` : 'already correct ✓';
  console.log(`${b.padEnd(16)} total=${v.total}  placeholder=${v.placeholder}  → ${verdict}`);
}
console.log('');
