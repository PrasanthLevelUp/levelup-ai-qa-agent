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

console.log('\n=== PX-1A PROOF — Dataset Matching Behavior ===\n');

const positive = drafts.find(d => d.coverageType === 'positive' && /create.*valid/i.test(d.title));
const duplicate = drafts.find(d => /duplicate/i.test(d.title));
const sql = drafts.find(d => /sql/i.test(d.title));
const whitespace = drafts.find(d => /whitespace/i.test(d.title));

console.log('## Positive "Create a record with valid data"');
console.log(`testData: ${positive?.testData}`);
console.log(`Title terms: ${positive?.title?.toLowerCase().split(/\s+/).join(', ')}`);
console.log();

console.log('## Duplicate');
console.log(`testData: ${duplicate?.testData}`);
console.log(`Has "duplicate" term: YES → matches "duplicate_employee"`);
console.log();

console.log('## SQL Injection');
console.log(`testData: ${sql?.testData}`);
console.log(`Should use inline SQL payload: YES`);
console.log();

console.log('## Whitespace');
console.log(`testData: ${whitespace?.testData}`);
console.log(`Should use inline whitespace value: YES`);
console.log();

console.log('═══════════════════════════════════════════════════════════');
console.log('EXPECTED:');
console.log('- Positive scenarios should match based on requirement context');
console.log('  (requirement title "Add New Employee" contains "employee")');
console.log('- Need to pass requirement/entity terms to pickDataset, not just');
console.log('  scenario title terms');
console.log('═══════════════════════════════════════════════════════════\n');
