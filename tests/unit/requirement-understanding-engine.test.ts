/**
 * Requirement Understanding Engine.
 *
 * The engine turns a Requirement (+ optional Repository Context) into a
 * deterministic Business Model — entities, actions, fields, business rules —
 * where every element is attributed to an Evidence source and scored. These
 * tests pin the behaviour that motivated the sprint: the "Add New Employee"
 * requirement must yield a real business model (entity Employee, action Create,
 * the mentioned fields and rules), and the Evidence Hierarchy must control what
 * is admitted and how confident we are.
 *
 * Pure — NO LLM, NO DB, NO UI. Every assertion is on plain data in / data out.
 */

import {
  understandRequirement,
  inferFieldDataType,
  knowledgeBaseRulesFor,
  domainFieldsForEntity,
  TIER_PROFILES,
  EVIDENCE_RANK,
  EVIDENCE_BASE_CONFIDENCE,
  type RepositoryEvidence,
} from '../../src/requirement-understanding';
import type { RequirementInput } from '../../src/requirement-coverage/types';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const addEmployee: RequirementInput = {
  id: 'REQ-002',
  title: 'User can create new employee',
  description:
    'The admin can add a new employee with name, email, phone and department. ' +
    'Email is required and must be unique. Department is mandatory. ' +
    'Only an authorized admin can create employees.',
};

const employeeRepo: RepositoryEvidence = {
  entities: ['Employee'],
  forms: [
    {
      name: 'employee-form',
      entity: 'Employee',
      fields: [
        { name: 'Email', type: 'email', required: true },
        { name: 'Salary', type: 'number' },
      ],
    },
  ],
  flows: [{ name: 'create employee', category: 'crud' }],
};

/* -------------------------------------------------------------------------- */
/*  Data-type + knowledge helpers                                              */
/* -------------------------------------------------------------------------- */

describe('field data-type inference', () => {
  it('prefers explicit raw type hints', () => {
    expect(inferFieldDataType('Contact', 'email')).toBe('email');
    expect(inferFieldDataType('Choice', 'select')).toBe('enum');
  });
  it('falls back to name-based inference', () => {
    expect(inferFieldDataType('Email Address')).toBe('email');
    expect(inferFieldDataType('Phone Number')).toBe('phone');
    expect(inferFieldDataType('Department')).toBe('enum');
    expect(inferFieldDataType('Something Odd')).toBe('unknown');
  });
});

describe('knowledge base rules by type', () => {
  it('attaches a format rule to typed fields', () => {
    expect(knowledgeBaseRulesFor('email')).toContain('format');
    expect(knowledgeBaseRulesFor('password')).toEqual(expect.arrayContaining(['format', 'length']));
  });
  it('attaches nothing universal to plain text/enum', () => {
    expect(knowledgeBaseRulesFor('text')).toEqual([]);
    expect(knowledgeBaseRulesFor('enum')).toEqual([]);
  });
});

describe('domain templates', () => {
  it('knows likely fields for an employee', () => {
    const fields = domainFieldsForEntity('employee');
    expect(fields).toEqual(expect.arrayContaining(['Name', 'Email', 'Department']));
  });
  it('is substring tolerant and empty for unknown entities', () => {
    expect(domainFieldsForEntity('new employee').length).toBeGreaterThan(0);
    expect(domainFieldsForEntity('wormhole')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*  Requirement-only understanding (L2)                                        */
/* -------------------------------------------------------------------------- */

describe('understandRequirement — requirement only', () => {
  const model = understandRequirement({ requirement: addEmployee, profile: TIER_PROFILES.enterprise });

  it('extracts the entity from the action + object', () => {
    expect(model.entities.map((e) => e.name)).toContain('Employee');
  });

  it('canonicalizes the action verb (create/add → create)', () => {
    expect(model.actions.map((a) => a.verb)).toContain('create');
  });

  it('extracts the fields the requirement mentions', () => {
    const names = model.fields.map((f) => f.normalized);
    expect(names).toEqual(expect.arrayContaining(['name', 'email', 'phone', 'department']));
  });

  it('extracts the stated business rules', () => {
    const kinds = model.businessRules.map((r) => r.ruleType);
    expect(kinds).toEqual(expect.arrayContaining(['unique', 'mandatory', 'permission']));
  });

  it('binds the unique rule to email', () => {
    const unique = model.businessRules.find((r) => r.ruleType === 'unique');
    expect(unique?.appliesTo).toBe('email');
  });

  it('marks a mandatory field as required', () => {
    const dept = model.fields.find((f) => f.normalized === 'department');
    expect(dept?.required).toBe(true);
  });

  it('attributes requirement-derived elements to the requirement source at 90', () => {
    const email = model.fields.find((f) => f.normalized === 'email')!;
    expect(email.provenance.source).toBe('requirement');
    expect(email.provenance.confidence).toBe(EVIDENCE_BASE_CONFIDENCE.requirement);
  });
});

/* -------------------------------------------------------------------------- */
/*  Evidence hierarchy: repository corroboration & precedence                  */
/* -------------------------------------------------------------------------- */

describe('understandRequirement — with repository evidence', () => {
  const model = understandRequirement({ requirement: addEmployee, repository: employeeRepo, profile: TIER_PROFILES.startup });

  it('lets repository evidence win precedence for a field seen in both', () => {
    const email = model.fields.find((f) => f.normalized === 'email')!;
    expect(email.provenance.source).toBe('repository');
  });

  it('boosts confidence to 100 when repository + requirement corroborate', () => {
    const email = model.fields.find((f) => f.normalized === 'email')!;
    expect(email.provenance.confidence).toBe(100);
    expect(email.corroboration.some((c) => c.source === 'requirement')).toBe(true);
  });

  it('adds repository-only fields the requirement never mentioned (Salary)', () => {
    const salary = model.fields.find((f) => f.normalized === 'salary');
    expect(salary).toBeDefined();
    expect(salary!.provenance.source).toBe('repository');
    expect(salary!.dataType).toBe('number');
  });

  it('adds knowledge-base format rule for the email field (L3, startup admits it)', () => {
    const fmt = model.businessRules.find((r) => r.ruleType === 'format' && r.appliesTo === 'email');
    expect(fmt).toBeDefined();
    expect(fmt!.provenance.source).toBe('knowledge_base');
  });

  it('reports contributing evidence levels strongest-first', () => {
    expect(model.evidenceLevels[0]).toBe('repository');
    expect(model.evidenceLevels).toEqual(expect.arrayContaining(['repository', 'requirement', 'knowledge_base']));
  });
});

/* -------------------------------------------------------------------------- */
/*  Tier filter: the configurable honesty posture                              */
/* -------------------------------------------------------------------------- */

describe('evidence-level tier filter', () => {
  it('enterprise admits only repository + requirement (no KB rules, no domain fields)', () => {
    const model = understandRequirement({ requirement: addEmployee, repository: employeeRepo, profile: TIER_PROFILES.enterprise });
    expect(model.evidenceLevels).not.toContain('knowledge_base');
    expect(model.evidenceLevels).not.toContain('domain_inference');
    expect(model.businessRules.some((r) => r.provenance.source === 'knowledge_base')).toBe(false);
  });

  it('startup admits KB but never domain inference', () => {
    const model = understandRequirement({ requirement: addEmployee, repository: employeeRepo, profile: TIER_PROFILES.startup });
    expect(model.evidenceLevels).toContain('knowledge_base');
    expect(model.fields.some((f) => f.provenance.source === 'domain_inference')).toBe(false);
  });

  it('deep_research admits domain-inferred fields, tagged as such', () => {
    const bare: RequirementInput = { id: 'REQ-X', title: 'User can create employee' };
    const model = understandRequirement({ requirement: bare, profile: TIER_PROFILES.deep_research });
    const inferred = model.fields.filter((f) => f.provenance.source === 'domain_inference');
    expect(inferred.length).toBeGreaterThan(0);
    // every inferred field carries the weaker confidence, never presented as fact
    for (const f of inferred) {
      expect(f.provenance.confidence).toBeLessThanOrEqual(EVIDENCE_BASE_CONFIDENCE.domain_inference);
      expect(EVIDENCE_RANK[f.provenance.source]).toBe(EVIDENCE_RANK.domain_inference);
    }
  });

  it('never emits llm_guess from any deterministic path', () => {
    const model = understandRequirement({ requirement: addEmployee, repository: employeeRepo, profile: { tier: 'custom', maxEvidenceLevel: 5 } });
    expect(model.evidenceLevels).not.toContain('llm_guess');
  });
});

/* -------------------------------------------------------------------------- */
/*  Aggregate confidence & determinism                                         */
/* -------------------------------------------------------------------------- */

describe('aggregate confidence & determinism', () => {
  it('raises a corroborated element\'s confidence above its requirement-only baseline', () => {
    // Aggregate mean is NOT monotonic with more evidence — admitting weaker L3/L4
    // elements can lower the mean even as strong elements get corroborated. The
    // real signal is PER-ELEMENT: a field seen in both repo + requirement should
    // beat the same field seen in the requirement alone.
    const withRepo = understandRequirement({ requirement: addEmployee, repository: employeeRepo, profile: TIER_PROFILES.startup });
    const reqOnly = understandRequirement({ requirement: addEmployee, profile: TIER_PROFILES.enterprise });
    const emailWith = withRepo.fields.find((f) => f.normalized === 'email')!;
    const emailWithout = reqOnly.fields.find((f) => f.normalized === 'email')!;
    expect(emailWith.provenance.confidence).toBeGreaterThan(emailWithout.provenance.confidence);
    expect(withRepo.confidence).toBeGreaterThan(0);
  });

  it('is deterministic — identical inputs yield identical output', () => {
    const a = understandRequirement({ requirement: addEmployee, repository: employeeRepo });
    const b = understandRequirement({ requirement: addEmployee, repository: employeeRepo });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('degrades gracefully to an empty-ish model for a contentless requirement', () => {
    const model = understandRequirement({ requirement: { id: 'R', title: '' } });
    expect(model.confidence).toBe(0);
    expect(model.entities).toEqual([]);
    expect(model.fields).toEqual([]);
  });
});
