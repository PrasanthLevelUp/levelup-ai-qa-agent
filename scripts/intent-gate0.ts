/**
 * PX-1A Gate 0 — Reproduce dataset usage behavior
 * 
 * Goal: Understand when/how datasets get assigned to scenarios.
 * Expected finding: Datasets might be getting used in scenarios where
 * deterministic inline data (Sprint 3) would be more appropriate.
 */

import { planScenarios } from '../src/engines/scenario-planner';
import { buildDraftTestCases } from '../src/engines/scenario-builder';
import type { CoverageType } from '../src/engines/test-coverage-engine';

const REQUIREMENT = {
  title: 'Add New Employee',
  description: 'HR admin can create a new employee record',
  module: 'HR',
  acceptanceCriteria: 'Given valid employee data, the record is created and searchable.',
};

const KNOWLEDGE = {
  applicationProfile: {
    baseUrl: 'https://demo.orangehrmlive.com/',
    name: 'OrangeHRM',
    forms: [{
      page: 'https://demo.orangehrmlive.com/web/index.php/pim/addEmployee',
      submitLabel: 'Save',
      submitSelector: 'button[type=submit]',
      fields: [
        { label: 'First Name', name: 'firstName', type: 'text', required: true },
        { label: 'Last Name', name: 'lastName', type: 'text', required: true },
      ],
    }],
  },
  testData: [
    { name: 'new_employee', sampleKeys: ['firstName', 'lastName'] },
    { name: 'duplicate_employee', sampleKeys: ['firstName', 'lastName'] },
  ],
};

const FAMILIES: CoverageType[] = ['positive', 'negative', 'edge_cases'];
const plan = planScenarios(REQUIREMENT, FAMILIES, undefined, undefined, false);
const { drafts } = buildDraftTestCases(plan as any, KNOWLEDGE, REQUIREMENT);

console.log('\n=== PX-1A GATE 0 — Dataset Usage Behavior ===\n');
console.log(`Generated ${drafts.length} test cases\n`);

// Group by scenario type
const byIntent = new Map<string, any[]>();
for (const d of drafts) {
  const intent = 
    /duplicate/i.test(d.title || '') ? 'duplicate' :
    /SQL|injection/i.test(d.title || '') ? 'sql' :
    /XSS|script/i.test(d.title || '') ? 'xss' :
    /whitespace/i.test(d.title || '') ? 'whitespace' :
    /boundary|edge|length/i.test(d.title || '') ? 'boundary' :
    d.coverageType === 'positive' ? 'positive' :
    d.coverageType === 'negative' ? 'negative' :
    'other';
  
  if (!byIntent.has(intent)) byIntent.set(intent, []);
  byIntent.get(intent)!.push(d);
}

// Check each intent category
for (const [intent, cases] of byIntent.entries()) {
  if (cases.length === 0) continue;
  
  console.log(`## ${intent.toUpperCase()} (${cases.length} scenarios)\n`);
  
  const sample = cases[0];
  const stepsText = (sample.steps || []).join(' ');
  const hasDatasetRef = /new_employee|duplicate_employee/i.test(sample.testData || '');
  const firstNameInSteps = stepsText.match(/Enter "([^"]+)" in the First Name/)?.[1] || 
                           stepsText.match(/Enter ([^"]+) in the First Name/)?.[1] || 
                           'N/A';
  
  console.log(`Title: "${sample.title}"`);
  console.log(`testData field: "${sample.testData}"`);
  console.log(`Has dataset reference: ${hasDatasetRef ? 'YES' : 'NO'}`);
  console.log(`First Name value in steps: "${firstNameInSteps}"`);
  console.log();
}

console.log('═══════════════════════════════════════════════════════════════');
console.log('FINDING:');
console.log();
console.log('If SQL/XSS/whitespace/boundary scenarios reference uploaded datasets,');
console.log('that means datasets are being used where deterministic generated values');
console.log('(from Sprint 3) would be more appropriate.');
console.log();
console.log('Expected behavior:');
console.log('- Positive → new_employee dataset (if it matches)');
console.log('- Duplicate → duplicate_employee dataset (if it matches)');
console.log('- SQL/XSS/whitespace/boundary → NO dataset, use generated payloads');
console.log('═══════════════════════════════════════════════════════════════\n');
