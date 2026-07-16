/**
 * Add-Employee gold sprint — Phase 3c: field-aware expansion.
 *
 * A senior QA does NOT collapse validation into one generic "required field"
 * case — they write a per-field check for every input the form names. Phase 3c
 * reads the fields from the requirement text and expands the universal
 * validation/boundary concepts across them (whitespace-only per field, per-name
 * numeric/unicode/min, per-id leading-zero, per-field max/over-max). The fields
 * are READ from the requirement (never hardcoded), so the same pass works for
 * any data-entry form.
 *
 * These tests pin: (1) per-field scenarios are produced for the named fields;
 * (2) they are assumption-tagged (Standard/Deep Coverage), never fake grounding;
 * (3) a requirement that names NO fields yields none; (4) file fields are not
 * text-expanded (uploads own that surface). Pure — NO LLM, NO DB.
 */
import { planScenarios } from '../../src/engines/scenario-planner';
import type { CoverageType } from '../../src/engines/test-coverage-engine';

const ALL: CoverageType[] = ['positive', 'negative', 'edge_cases', 'boundary', 'security'];

const EMPLOYEE = {
  title: 'Create Employee',
  description:
    'Admin can add a new employee by entering first name, last name, employee ID and an optional profile photo. ' +
    'Employee ID may be auto-generated or entered manually and must be unique.',
  module: 'HR',
  businessFlow: 'Open Add Employee, fill fields, save.',
  acceptanceCriteria: 'Given valid details, the employee is created and searchable by ID and name.',
};

function plan(input: any, deep: boolean) {
  return planScenarios(input as any, ALL, 'crud', undefined, deep);
}

describe('Phase 3c — field-aware expansion', () => {
  it('expands per-field validation for each named field (first name, last name, employee id)', () => {
    const ids = new Set(plan(EMPLOYEE, true).scenarios.map(s => s.id));
    // Per-field whitespace-only (distinct field, distinct trim bug).
    expect(ids.has('field-first-name-whitespace')).toBe(true);
    expect(ids.has('field-last-name-whitespace')).toBe(true);
    // One cross-field "all required blank" submit.
    expect(ids.has('field-all-required-blank')).toBe(true);
    // Name-type rules on the first name field.
    expect(ids.has('field-first-name-numeric')).toBe(true);
    expect(ids.has('field-first-name-min')).toBe(true);
    expect(ids.has('field-first-name-unicode')).toBe(true);
    // Representative length boundaries on a name field + the id field.
    expect(ids.has('field-first-name-max-accepted')).toBe(true);
    expect(ids.has('field-first-name-over-max')).toBe(true);
    expect(ids.has('field-employee-id-over-max')).toBe(true);
    // Id-type rule: leading zeros preserved.
    expect(ids.has('field-employee-id-leading-zero')).toBe(true);
  });

  it('field-aware scenarios are assumption-tagged, never fake requirement grounding', () => {
    const fieldScenarios = plan(EMPLOYEE, true).scenarios.filter(s => s.id.startsWith('field-'));
    expect(fieldScenarios.length).toBeGreaterThan(0);
    for (const s of fieldScenarios) {
      expect(s.provenance.assumption).toBe(true);
      expect(['Standard Coverage', 'Deep Coverage']).toContain(s.provenance.source);
      expect(s.provenance.evidence).toHaveLength(0);
    }
  });

  it('names the actual field in the scenario text so it reads hand-authored', () => {
    const byId = new Map(plan(EMPLOYEE, true).scenarios.map(s => [s.id, s]));
    expect(byId.get('field-first-name-whitespace')!.objective.toLowerCase()).toContain('first name');
    expect(byId.get('field-employee-id-leading-zero')!.objective.toLowerCase()).toContain('employee id');
  });

  it('a requirement that names no discrete fields yields no field expansion', () => {
    const vague = {
      title: 'Delete a record',
      description: 'An admin can delete a record from the system.',
      module: 'Admin',
      businessFlow: 'Select a record and delete it.',
      acceptanceCriteria: 'The record is removed.',
    };
    const fieldScenarios = plan(vague, true).scenarios.filter(s => s.id.startsWith('field-'));
    expect(fieldScenarios).toHaveLength(0);
  });

  it('does not text-expand a file/photo field (uploads own that surface)', () => {
    const ids = new Set(plan(EMPLOYEE, true).scenarios.map(s => s.id));
    expect([...ids].some(id => /^field-(profile-)?photo/.test(id))).toBe(false);
  });
});
