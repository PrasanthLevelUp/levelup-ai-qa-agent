/**
 * Unit tests for the Feature Grounding Engine.
 *
 * The defect this sprint fixed: scenarios belonging to the SAME feature were
 * independently grounded (per-scenario `pickForm` on each scenario's narrow
 * vocabulary), so the same feature resolved DIFFERENT forms — or none — scenario
 * by scenario. A scenario sharing no word with the captured field labels fell to
 * a placeholder; a file/authorization scenario matched a foreign search-filter
 * form and inherited its junk labels.
 *
 * The fix has two deterministic, data-only parts (no new engine/LLM):
 *   1. FEATURE-LEVEL FORM RESOLUTION — the form is resolved ONCE from the whole
 *      feature's vocabulary and reused by every scenario that interacts with it.
 *   2. INTENT-BASED GROUNDING — each scenario is classified by its STABLE
 *      structured signals (canonical id, riskArea, KB stepFlow) — never its
 *      title — into a grounding intent. Authorization/authentication/session/
 *      direct-URL scenarios are HELD as Needs Review (no fabricated form steps)
 *      pending the Intent-aware Step Generator, honouring the product rule
 *      "never generate confident-but-incorrect artifacts".
 *
 * Run with: npx jest tests/unit/feature-grounding-engine.test.ts
 */

import { planScenarios } from '../../src/engines/scenario-planner';
import {
  buildDraftTestCases,
  classifyGroundingIntent,
} from '../../src/engines/scenario-builder';
import type { CoverageType } from '../../src/engines/test-coverage-engine';

/* ------------------------------------------------------------------ */
/*  classifyGroundingIntent — pure classification from STABLE signals  */
/* ------------------------------------------------------------------ */
describe('classifyGroundingIntent — classifies by intent, not title', () => {
  it('classifies authorization/authentication/session/direct-URL scenarios as authorization (held)', () => {
    // riskArea signal
    expect(classifyGroundingIntent({ riskArea: 'Authorization' })).toBe('authorization');
    // canonical id signals — the planner labels ALL of these riskArea
    // "Authorization"; the ids disambiguate the concern but the intent is the
    // same: none of them fill the feature form.
    expect(classifyGroundingIntent({ id: 'crud-neg-direct-endpoint-authz' })).toBe('authorization');
    expect(classifyGroundingIntent({ id: 'crud-neg-unauthenticated-redirect' })).toBe('authorization');
    expect(classifyGroundingIntent({ id: 'crud-neg-unauthorized' })).toBe('authorization');
    expect(classifyGroundingIntent({ id: 'login-session-timeout' })).toBe('authorization');
  });

  it('classifies file-handling scenarios as file_upload', () => {
    expect(classifyGroundingIntent({ riskArea: 'File handling' })).toBe('file_upload');
    expect(classifyGroundingIntent({ id: 'crud-pos-upload-valid' })).toBe('file_upload');
  });

  it('classifies search scenarios from the KB stepFlow or risk area', () => {
    expect(classifyGroundingIntent({ stepFlow: 'search' })).toBe('search');
    expect(classifyGroundingIntent({ riskArea: 'Search correctness' })).toBe('search');
  });

  it('classifies cancel/navigation scenarios as navigation', () => {
    expect(classifyGroundingIntent({ stepFlow: 'cancel' })).toBe('navigation');
    expect(classifyGroundingIntent({ riskArea: 'Navigation' })).toBe('navigation');
  });

  it('defaults to form_entry for ordinary create/validation/boundary scenarios', () => {
    expect(classifyGroundingIntent({ id: 'crud-pos-create', riskArea: 'Data creation' })).toBe('form_entry');
    expect(classifyGroundingIntent({ id: 'crud-neg-injection-sql', riskArea: 'Input validation' })).toBe('form_entry');
    expect(classifyGroundingIntent({ id: 'crud-neg-duplicate', riskArea: 'Data integrity' })).toBe('form_entry');
    expect(classifyGroundingIntent({})).toBe('form_entry');
  });

  it('does NOT rely on the title — a title mentioning "search" on a form-entry id stays form_entry', () => {
    // The whole point of INTENT (not title) classification: a create scenario
    // whose title happens to contain the word "search" (e.g. "Created record is
    // immediately searchable") must still be a form_entry — it fills the form.
    expect(
      classifyGroundingIntent({ id: 'crud-pos-searchable', riskArea: 'Data creation' }),
    ).toBe('form_entry');
  });
});

/* ------------------------------------------------------------------ */
/*  Feature-level resolution + hold — end-to-end through the builder   */
/* ------------------------------------------------------------------ */

// A faithful OrangeHRM-style MIXED profile: an Add Employee form that does NOT
// carry the incidental "employee" token (Employee Id auto-generated) AND a
// foreign Employee-Search filter form. This is the exact profile that
// reproduced the uploaded CSV (25 placeholders / 3 search-leaks / 29% AR) under
// the OLD per-scenario resolution.
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

function build() {
  const plan = planScenarios(EMPLOYEE_REQ as any, FAMILIES, undefined, undefined, false);
  return buildDraftTestCases(plan as any, KNOWLEDGE as any, EMPLOYEE_REQ as any).drafts;
}

const AUTHZ_IDS = new Set([
  'crud-neg-direct-endpoint-authz',
  'crud-neg-unauthenticated-redirect',
  'crud-neg-unauthorized',
]);
const isPlaceholder = (d: any) => (d.steps as string[]).some((s) => /Exercise the ".*" scenario/.test(s));
const hitsSearchForm = (d: any) =>
  (d.steps as string[]).some((s) => /Type for hints|comma separated|\bFrom field\b/.test(s));

describe('Feature Grounding Engine — feature-level resolution', () => {
  it('grounds EVERY form scenario on the ONE resolved Add form — zero placeholders', () => {
    const drafts = build();
    const formScenarios = drafts.filter((d: any) => !AUTHZ_IDS.has(d.scenarioId));
    // The exact regression the CSV showed: form scenarios falling to placeholders.
    const placeholders = formScenarios.filter(isPlaceholder);
    expect(placeholders).toHaveLength(0);
    // Representative form scenarios that shared NO vocabulary with the captured
    // field labels used to score 0 and fall through — they must now be grounded.
    for (const id of ['crud-neg-injection-sql', 'crud-neg-duplicate', 'crud-neg-whitespace-only']) {
      const d: any = drafts.find((x: any) => x.scenarioId === id);
      expect(d).toBeDefined();
      expect(isPlaceholder(d)).toBe(false);
      expect(d.steps.join(' ')).toContain('First Name');
    }
  });

  it('NEVER leaks the foreign search-filter form onto any scenario', () => {
    const drafts = build();
    const leaks = drafts.filter(hitsSearchForm);
    expect(leaks).toHaveLength(0);
    // No draft carries the search form's junk labels.
    for (const d of drafts as any[]) {
      const text = d.steps.join(' ');
      expect(text).not.toContain('Type for hints');
      expect(text).not.toContain('comma separated');
    }
  });

  it('makes >85% of scenarios Automation Ready (all form scenarios grounded on real selectors)', () => {
    const drafts = build();
    const ready = drafts.filter((d: any) => d.automationReady);
    expect(ready.length / drafts.length).toBeGreaterThan(0.85);
    // Every form (non-authz) scenario is automation ready.
    const formScenarios = drafts.filter((d: any) => !AUTHZ_IDS.has(d.scenarioId));
    for (const d of formScenarios as any[]) {
      expect(d.automationReady).toBe(true);
    }
  });

  it('uploads file fields (does not type into them)', () => {
    const drafts = build();
    // Any grounded form scenario exercises the Profile Photo file field.
    const withUpload = (drafts as any[]).find((d) => d.steps.join(' ').includes('Profile Photo'));
    expect(withUpload).toBeDefined();
    const photoStep = (withUpload.steps as string[]).find((s) => s.includes('Profile Photo'))!;
    expect(photoStep).toMatch(/^Upload /);
    expect(photoStep).not.toMatch(/Enter .* in the Profile Photo field/);
  });
});

describe('Feature Grounding Engine — honest hold (the critical guarantee)', () => {
  it('HOLDS every authorization scenario as Needs Review — 0 wrongly converted to form-fill', () => {
    const drafts = build();
    const authz = (drafts as any[]).filter((d) => AUTHZ_IDS.has(d.scenarioId));
    // The planner emits these three authorization concerns for the feature.
    expect(authz.length).toBeGreaterThanOrEqual(3);
    for (const d of authz) {
      // Held: marked Needs Review, NOT automation ready...
      expect(d.needsReview).toBe(true);
      expect(d.automationReady).toBe(false);
      // ...with a precise reason mentioning the Intent-aware Step Generator...
      expect(d.reviewReasons.join(' ')).toMatch(/Intent-aware Step Generator/);
      // ...and NO fabricated Add-form fill steps (the "confident-but-incorrect"
      // failure mode). It emits only the honest skeleton.
      const text = (d.steps as string[]).join(' ');
      expect(text).not.toContain('First Name');
      expect(text).not.toContain('Last Name');
      expect(text).not.toContain('Profile Photo');
      expect(isPlaceholder(d)).toBe(true);
    }
  });

  it('holds authorization scenarios EVEN THOUGH the feature form resolved (form scenarios beside them are grounded)', () => {
    const drafts = build();
    // Proof the hold is deliberate, not a resolution failure: in the SAME build,
    // form scenarios are fully grounded while authz scenarios are held.
    const create: any = drafts.find((d: any) => d.scenarioId === 'crud-pos-create');
    expect(create.automationReady).toBe(true);
    expect(create.steps.join(' ')).toContain('First Name');
    const authz: any = drafts.find((d: any) => d.scenarioId === 'crud-neg-unauthorized');
    expect(authz.needsReview).toBe(true);
    expect(authz.automationReady).toBe(false);
  });
});
