/**
 * Unit tests for the Deterministic Scenario Builder.
 *
 * The builder is PURE + synchronous (zero LLM tokens): given a scenario plan and
 * the retrieved knowledge context it ASSEMBLES grounded draft test cases. These
 * tests lock the guarantees that make it safe to sit between the retriever and
 * the LLM: grounding in real selectors/datasets, determinism, fail-open
 * behaviour, coverage never dropping below the grounded scenarios, no mutation
 * of inputs, and correct conditional handling.
 *
 * Run with: npx jest tests/unit/scenario-builder.test.ts
 */

import { planScenarios } from '../../src/engines/scenario-planner';
import {
  buildDraftTestCases,
  buildDraftBlock,
  buildDeterministicOutput,
  buildScenariosFromDrafts,
  draftToTestCase,
  buildFormatterInputs,
  buildFormatterPrompt,
  buildRepairPrompt,
  applyPolish,
} from '../../src/engines/scenario-builder';
import type { CoverageType } from '../../src/engines/test-coverage-engine';

const LOGIN_REQ = {
  title: 'User Login',
  description: 'A registered user logs in with their email and password to access the dashboard.',
  acceptanceCriteria: 'Valid credentials authenticate; invalid credentials are rejected with an error.',
  businessFlow: 'Open login page → enter email + password → submit → land on dashboard.',
};

const LOGIN_PROFILE = {
  baseUrl: 'https://app.example.com',
  name: 'Example App',
  loginUrl: 'https://app.example.com/login',
  username: 'standard_user',
  pages: [{ url: 'https://app.example.com/login', title: 'Login', pageType: 'auth' }],
  forms: [
    {
      page: 'https://app.example.com/login',
      action: '/session',
      method: 'POST',
      submitSelector: '#login-btn',
      fields: [
        { name: 'email', type: 'email', required: true, selector: '#email', label: 'Email' },
        { name: 'password', type: 'password', required: true, selector: '#password', label: 'Password' },
      ],
    },
  ],
  keyElements: [{ label: 'Login', tag: 'button', selector: '#login-btn', role: 'button' }],
};

const LOGIN_KNOWLEDGE: any = {
  applicationProfile: LOGIN_PROFILE,
  testData: [
    { name: 'standard_user', environment: 'staging', recordCount: 1, sampleKeys: ['email', 'password'] },
  ],
};

const COVERAGE: CoverageType[] = ['positive', 'negative', 'edge_cases'];

// A requirement whose Acceptance Criteria explicitly justify a negative +
// security scenario (account lockout). Used to exercise multi-scenario builds
// now that the planner only emits scenarios the evidence justifies.
const LOGIN_REQ_LOCKOUT = {
  title: 'User Login with lockout',
  description: 'A registered user logs in with email and password.',
  acceptanceCriteria:
    'Valid credentials authenticate; the account is locked after 5 failed attempts.',
  businessFlow: 'Open login page → enter email + password → submit → land on dashboard.',
};

describe('buildDraftTestCases — grounding', () => {
  it('keeps step text business-readable and captures REAL selectors in grounding (not in prose)', () => {
    const plan = planScenarios(LOGIN_REQ, COVERAGE, 'authentication');
    const { drafts, groundedCount } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);

    expect(drafts.length).toBeGreaterThan(0);
    expect(groundedCount).toBeGreaterThan(0);

    const first = drafts[0];
    const stepsText = first.steps.join(' ');
    // Separate DATA, not pipelines: the manual/business projection (steps) must
    // NOT contain selectors or raw URLs — those belong to the technical
    // projection (grounding).
    expect(stepsText).not.toContain('#email');
    expect(stepsText).not.toContain('#password');
    expect(stepsText).not.toContain('#login-btn');
    expect(stepsText).not.toContain('https://app.example.com/login');
    // Steps read like business actions.
    expect(stepsText).toContain('Email field');
    expect(stepsText).toContain('Password field');

    // The REAL selectors survive in the hidden per-step grounding, aligned by index.
    const groundedSelectors = first.grounding.map(g => g.selector).filter(Boolean);
    expect(groundedSelectors).toContain('#email');
    expect(groundedSelectors).toContain('#password');
    expect(groundedSelectors).toContain('#login-btn');
    first.grounding.forEach(g => {
      expect(g.stepIndex).toBeGreaterThanOrEqual(1);
      expect(g.stepIndex).toBeLessThanOrEqual(first.steps.length);
    });

    // Structured expected: an observable outcome (shown to manual QA) + objective mirror.
    expect(first.expected.observable.length).toBeGreaterThan(0);
    expect(first.expectedResult).toBe(first.expected.observable);

    // `source` relays the planner's evidence source (the core valid-login
    // scenario is derived from the Requirement) — NOT a grounding echo. Whether
    // a real selector was used is the SEPARATE `grounded` axis.
    expect(first.source).toBe('requirement');
    expect(first.grounded).toBe(true);
    expect(first.provenance.source).toBe('Requirement');
    expect(first.testData).toContain('standard_user');
  });

  it('varies the DATA intent by coverage type (valid vs invalid)', () => {
    // The lockout AC justifies a negative scenario alongside the core positive.
    const plan = planScenarios(LOGIN_REQ_LOCKOUT, ['positive', 'negative'], 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ_LOCKOUT);

    const pos = drafts.find(d => d.coverageType === 'positive');
    const neg = drafts.find(d => d.coverageType === 'negative');
    expect(pos && pos.steps.join(' ')).toContain('valid');
    expect(neg && neg.steps.join(' ')).toContain('invalid');
  });
});

describe('buildDraftTestCases — pure transform (no existence decisions)', () => {
  it('emits EXACTLY one draft per planned scenario — never creates or drops', () => {
    const plan = planScenarios(LOGIN_REQ, COVERAGE, 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    expect(drafts.length).toBe(plan.scenarios.length);
    // Each draft corresponds 1:1 (by id) to a planned scenario — no invention.
    expect(drafts.map(d => d.scenarioId).sort())
      .toEqual(plan.scenarios.map(s => s.id).sort());
  });

  it('no invention: a bare login yields ONLY the KB obligations (core + mandatory), no conditional phantoms', () => {
    // The planner justifies the authentication KB obligations for a bare
    // requirement (valid login + invalid credentials + required fields); the
    // builder must faithfully emit exactly those and nothing more — no invented
    // SQL Injection / lockout / session phantoms (those are conditional).
    const plan = planScenarios(
      { title: 'User Login', description: 'User can log in successfully.' },
      ['positive', 'negative', 'edge_cases', 'security'],
      'authentication',
    );
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    const ids = new Set(drafts.map(d => d.scenarioId));
    // The three mandatory KB obligations are present...
    for (const kb of ['auth-neg-empty-fields', 'auth-neg-wrong-password', 'auth-pos-valid']) {
      expect(ids.has(kb)).toBe(true);
    }
    // ...and no conditional PHANTOMS were invented from the coverage type alone.
    for (const phantom of ['auth-neg-locked-user', 'auth-sec-injection', 'auth-sec-session', 'auth-pos-logout']) {
      expect(ids.has(phantom)).toBe(false);
    }
    // The only non-KB draft (if any) is the requirement-grounded step scenario
    // (Sprint 5.1 completeness) — never an invented phantom.
    for (const d of drafts) {
      const isKb = d.scenarioId.startsWith('auth-');
      const isReqStep = d.scenarioId.startsWith('req-step-');
      expect(isKb || isReqStep).toBe(true);
    }
  });

  it('reflects the planner: explicit lockout evidence yields strictly more drafts than a bare login', () => {
    const planBare = planScenarios(
      { title: 'User Login', description: 'User can log in successfully.' },
      ['positive', 'negative', 'security'],
      'authentication',
    );
    const planLock = planScenarios(LOGIN_REQ_LOCKOUT, ['positive', 'negative', 'security'], 'authentication');

    const bare = buildDraftTestCases(planBare, LOGIN_KNOWLEDGE, LOGIN_REQ);
    const lock = buildDraftTestCases(planLock, LOGIN_KNOWLEDGE, LOGIN_REQ_LOCKOUT);

    // Each build is a faithful 1:1 transform of its plan…
    expect(bare.drafts.length).toBe(planBare.scenarios.length);
    expect(lock.drafts.length).toBe(planLock.scenarios.length);
    // …and the lockout evidence justified more scenarios upstream.
    expect(lock.drafts.length).toBeGreaterThan(bare.drafts.length);
    const hasLockout = (r: typeof lock) =>
      r.drafts.some(d => /lock/i.test(`${d.title} ${d.riskArea}`));
    expect(hasLockout(lock)).toBe(true);
    expect(hasLockout(bare)).toBe(false);
  });
});

describe('buildDraftTestCases — determinism & purity', () => {
  it('produces identical output for identical input', () => {
    const plan = planScenarios(LOGIN_REQ, COVERAGE, 'authentication');
    const a = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    const b = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('does not mutate the plan or knowledge inputs', () => {
    const plan = planScenarios(LOGIN_REQ, COVERAGE, 'authentication');
    const planSnapshot = JSON.stringify(plan);
    const knowledgeSnapshot = JSON.stringify(LOGIN_KNOWLEDGE);
    buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    expect(JSON.stringify(plan)).toBe(planSnapshot);
    expect(JSON.stringify(LOGIN_KNOWLEDGE)).toBe(knowledgeSnapshot);
  });
});

describe('buildDraftTestCases — fail-open', () => {
  it('still produces drafts from the objective when there is NO App Profile', () => {
    const plan = planScenarios(LOGIN_REQ, COVERAGE, 'authentication');
    const { drafts, groundedCount } = buildDraftTestCases(plan, undefined, LOGIN_REQ);
    expect(drafts.length).toBe(plan.scenarios.length);
    expect(groundedCount).toBe(0);
    for (const d of drafts) {
      // Even with no App Profile, `source` still relays the planner's evidence
      // source — the core scenario is derived from the Requirement, and any
      // Sprint 5.1 requirement-step scenario relays 'requirement' or (when the
      // step came from acceptance criteria) 'acceptance_criteria'. Grounding
      // absence is reflected only in `grounded`.
      expect(['requirement', 'acceptance_criteria']).toContain(d.source);
      expect(d.grounded).toBe(false);
      expect(d.steps.length).toBeGreaterThan(0);
    }
  });

  it('returns an empty result for an empty/undefined plan (never throws)', () => {
    expect(buildDraftTestCases(undefined, LOGIN_KNOWLEDGE, LOGIN_REQ)).toEqual({
      drafts: [], groundedCount: 0,
    });
  });
});

describe('buildDraftBlock', () => {
  it('renders a compact block that instructs REFINE-not-reinvent', () => {
    const plan = planScenarios(LOGIN_REQ, COVERAGE, 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    const block = buildDraftBlock(drafts);
    expect(block).toContain('PRE-BUILT DRAFT TEST CASES');
    expect(block).toContain('scenarioIndex');
    expect(block).toContain(`DRAFTS (${drafts.length})`);
    // The block forbids invention and forbids dropping drafts (no-invention).
    expect(block).toContain('DO NOT invent');
    expect(block).toContain('DO NOT drop');
  });

  it('returns empty string for no drafts', () => {
    expect(buildDraftBlock([])).toBe('');
  });
});

describe('Formatter mode — deterministic output', () => {
  it('maps every draft to a COMPLETE test case (no field left to the LLM)', () => {
    const plan = planScenarios(LOGIN_REQ, COVERAGE, 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    const out = buildDeterministicOutput(drafts);

    // One scenario + one test case per draft — coverage fixed by the builder.
    expect(out.scenarios.length).toBe(drafts.length);
    expect(out.testCases.length).toBe(drafts.length);

    out.testCases.forEach((tc, i) => {
      expect(tc.title.length).toBeGreaterThan(0);
      expect(tc.steps.length).toBeGreaterThan(0);
      expect(tc.expectedResult.length).toBeGreaterThan(0);
      expect(tc.preconditions.length).toBeGreaterThan(0);
      expect(['P0', 'P1', 'P2', 'P3']).toContain(tc.priority);
      expect(['critical', 'major', 'minor', 'trivial']).toContain(tc.severity);
      // scenarioIndex is the POSITION in the emitted list so it always aligns
      // with the deterministically-derived scenarios array.
      expect(tc.scenarioIndex).toBe(i);
      // `source` is the slug of the planner's evidence source (one of the four
      // evidence buckets) — carried through, never a grounding echo.
      expect(['requirement', 'acceptance_criteria', 'app_knowledge', 'test_data'])
        .toContain(tc.source);
    });
  });

  it('derives severity from priority deterministically', () => {
    const plan = planScenarios(LOGIN_REQ, COVERAGE, 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    const p0 = drafts.find(d => d.priority === 'P0');
    if (p0) expect(draftToTestCase(p0, 0).severity).toBe('critical');
  });

  it('scenarios derived from drafts carry the coverage type + risk area', () => {
    const plan = planScenarios(LOGIN_REQ, COVERAGE, 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    const scenarios = buildScenariosFromDrafts(drafts);
    scenarios.forEach((s, i) => {
      expect(s.scenario).toBe(drafts[i].title);
      expect(s.coverageType).toBe(drafts[i].coverageType);
      expect(s.riskArea).toBe(drafts[i].riskArea);
    });
  });
});

describe('Formatter mode — minimal prompt (FormatterInput contract)', () => {
  it('does NOT re-teach the 20-principle standard and withholds selectors as invariants', () => {
    const plan = planScenarios(LOGIN_REQ, COVERAGE, 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    const out = buildDeterministicOutput(drafts);
    const inputs = buildFormatterInputs(out.testCases);
    const formatterPrompt = buildFormatterPrompt(inputs);

    // The standard is enforced by the deterministic validator AFTER generation,
    // NOT embedded in the prompt. The prompt must be tiny and must not carry the
    // 20 principles, principle numbering, or the standard doc's scaffolding.
    expect(formatterPrompt).not.toContain('QA Artifact Standard');
    expect(formatterPrompt).not.toContain('20 principles');
    expect(formatterPrompt).not.toContain('Principle'); // no principle re-teaching
    expect(formatterPrompt).toContain(`EXACTLY ${inputs.length}`);
    // Selectors and raw URLs are technical invariants that live in `grounding`,
    // NOT in the editable wording payload — the model never sees them and so
    // cannot corrupt them (and this trims the tokens further).
    expect(formatterPrompt).not.toContain('#email');
    expect(formatterPrompt).not.toContain('#login-btn');
    expect(formatterPrompt).not.toContain('"grounding"');
    // It must NOT drag in the heavy generation scaffolding.
    expect(formatterPrompt).not.toContain('COVERAGE OBJECTIVES');
    expect(formatterPrompt).not.toContain('GROUNDED SCOPE');
    expect(formatterPrompt).not.toContain('Acceptance Criteria');
    // The INSTRUCTION portion (everything before the data payload) is tiny and
    // fixed-size — it does not grow with the number of cases or re-teach the
    // standard. Only the data payload after "TEST CASES:" scales with input.
    const instructions = formatterPrompt.split('TEST CASES:')[0];
    // Fixed-size preamble: it must not grow per-case or re-teach the standard.
    // (Includes one short, fixed DATA line describing the masked resolvedDataset
    // added in Sprint 2C — still a few lines, still principle-free.)
    expect(instructions.length).toBeLessThan(1400);
  });

  it('sends the FIXED semantic context as DATA + only the editable wording fields', () => {
    // Use the lockout requirement so the plan justifies >1 scenario and the
    // compact JSON array actually contains multiple objects.
    const plan = planScenarios(LOGIN_REQ_LOCKOUT, ['positive', 'negative'], 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ_LOCKOUT);
    const out = buildDeterministicOutput(drafts);
    const inputs = buildFormatterInputs(out.testCases);
    const formatterPrompt = buildFormatterPrompt(inputs);
    // The contract carries the canonical id + editable wording fields...
    expect(formatterPrompt).toContain('"id":');
    expect(formatterPrompt).toContain('"expected":');
    // ...and the FIXED structural context travels as data (not prose rules).
    expect(formatterPrompt).toContain('"objective":');
    expect(formatterPrompt).toContain('"variation":');
    expect(formatterPrompt).toContain('"expectedBehavior":');
    expect(formatterPrompt).toContain('"dataRole":');
    // ...but NOT the technical invariants the model must never touch.
    expect(formatterPrompt).not.toContain('"severity"');
    expect(formatterPrompt).not.toContain('"sourceEvidence"');
    expect(formatterPrompt).not.toContain('"automationComplexity"');
    expect(formatterPrompt).not.toContain('"selectorAvailability"');
    // The payload is compact (whitespace-free array joins).
    expect(formatterPrompt).toContain('},{');
  });

  it('buildFormatterInputs folds KB semantics into the contract (and falls back safely)', () => {
    const plan = planScenarios(LOGIN_REQ, COVERAGE, 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    const out = buildDeterministicOutput(drafts);

    // With semantics provided, they win.
    const semantics = new Map([
      [out.testCases[0].scenarioId, {
        variation: 'invalid password',
        expectedBehavior: 'an inline error is shown and no session is created',
        requiredDataRole: 'registered_user',
      } as any],
    ]);
    const withSem = buildFormatterInputs(out.testCases, semantics);
    expect(withSem[0].variation).toBe('invalid password');
    expect(withSem[0].expectedBehavior).toBe('an inline error is shown and no session is created');
    expect(withSem[0].dataRole).toBe('registered_user');
    // The editable seed wording is carried through from the deterministic case.
    expect(withSem[0].title).toBe(out.testCases[0].title);
    expect(withSem[0].id).toBe(out.testCases[0].scenarioId);

    // Without semantics, the contract is still TOTAL (safe defaults).
    const noSem = buildFormatterInputs(out.testCases);
    expect(noSem[0].dataRole).toBe('valid_data');
    expect(typeof noSem[0].variation).toBe('string');
    expect(noSem[0].variation.length).toBeGreaterThan(0);
  });

  it('FormatterInput is IMMUTABLE — semantic truth cannot be mutated at runtime', () => {
    const plan = planScenarios(LOGIN_REQ, COVERAGE, 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    const out = buildDeterministicOutput(drafts);
    const inputs = buildFormatterInputs(out.testCases);
    const input: any = inputs[0];

    // The object AND its steps array are frozen.
    expect(Object.isFrozen(input)).toBe(true);
    expect(Object.isFrozen(input.steps)).toBe(true);

    // Mutating a semantic field is a no-op (silent in loose mode, throws in
    // strict mode) — the value never changes either way.
    const originalObjective = input.objective;
    try { input.objective = 'HACKED'; } catch { /* strict-mode TypeError is fine */ }
    expect(input.objective).toBe(originalObjective);

    const originalLen = input.steps.length;
    try { input.steps.push('injected step'); } catch { /* frozen array */ }
    expect(input.steps.length).toBe(originalLen);
  });

  it('carries the resolvedDataset already on a case (resolved upstream at graph build) onto the FormatterInput', () => {
    const plan = planScenarios(LOGIN_REQ, COVERAGE, 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    const out = buildDeterministicOutput(drafts);
    const semantics = new Map([
      [out.testCases[0].scenarioId, {
        variation: 'valid credentials',
        expectedBehavior: 'the user is authenticated and lands on the dashboard',
        requiredDataRole: 'registered_user',
      } as any],
    ]);
    // Resolution no longer happens in buildFormatterInputs — it runs ONCE at
    // Scenario Graph build time and the winning record is carried down onto the
    // case (via the Test Case Lab projection). Simulate that here.
    out.testCases[0].resolvedDataset = {
      datasetId: 'valid_users',
      recordId: 'standard_user',
      values: { username: 'standard_user', password: 'secret_sauce' },
      reason: "role 'registered_user' matched dataset 'valid_users' → record 'standard_user'",
    };
    const inputs = buildFormatterInputs(out.testCases, semantics);
    const resolved = inputs[0].resolvedDataset;
    expect(resolved).toBeDefined();
    expect(resolved!.datasetId).toBe('valid_users');
    expect(resolved!.recordId).toBe('standard_user');
    // A resolved record has NO confidence — deterministic, binary (see Sprint 2C).
    expect((resolved as any).confidence).toBeUndefined();
    // Additive: dataRole is untouched and the semantics map is not mutated.
    expect(inputs[0].dataRole).toBe('registered_user');
    expect(semantics.get(out.testCases[0].scenarioId)!.requiredDataRole).toBe('registered_user');
  });

  it('buildFormatterPrompt shows dataset/record/role but MASKS literal values', () => {
    const plan = planScenarios(LOGIN_REQ, COVERAGE, 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    const out = buildDeterministicOutput(drafts);
    const semantics = new Map([
      [out.testCases[0].scenarioId, {
        variation: 'valid credentials',
        expectedBehavior: 'the user is authenticated and lands on the dashboard',
        requiredDataRole: 'registered_user',
      } as any],
    ]);
    // Feed an UNMASKED resolved record (as the graph node holds internally) to
    // prove the prompt boundary masks the values.
    out.testCases[0].resolvedDataset = {
      datasetId: 'valid_users',
      recordId: 'standard_user',
      values: { username: 'standard_user', password: 'secret_sauce' },
      reason: "role 'registered_user' matched dataset 'valid_users' → record 'standard_user'",
    };
    const inputs = buildFormatterInputs(out.testCases, semantics);
    const prompt = buildFormatterPrompt(inputs);
    // The dataset id, record id and role are surfaced for role-based wording...
    expect(prompt).toContain('valid_users');
    expect(prompt).toContain('standard_user');
    expect(prompt).toContain('"resolvedDataset"');
    // ...but the literal secret value must NEVER leak into the prompt.
    expect(prompt).not.toContain('secret_sauce');
    expect(prompt).toContain('*****');
    // Masking must not have mutated the resolved values on the frozen input.
    expect(inputs[0].resolvedDataset!.values.password).toBe('secret_sauce');
  });

  it('buildRepairPrompt lists ONLY the failing cases and their specific fixes', () => {
    const plan = planScenarios(LOGIN_REQ, COVERAGE, 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    const out = buildDeterministicOutput(drafts);
    const inputs = buildFormatterInputs(out.testCases);
    const failId = inputs[0].id;
    const repair = buildRepairPrompt(inputs, {
      [failId]: ['[step 2] Split the combined action into one action per step.'],
    });
    expect(repair).toContain('REQUIRED FIXES');
    expect(repair).toContain(failId);
    expect(repair).toContain('Split the combined action');
    expect(repair).toContain(`EXACTLY ${inputs.length}`);
  });
});

describe('Canonical object — stable id + typed selectors', () => {
  it('every draft and test case carries a stable canonical scenarioId', () => {
    const plan = planScenarios(LOGIN_REQ, COVERAGE, 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    const out = buildDeterministicOutput(drafts);
    drafts.forEach(d => expect(typeof d.scenarioId).toBe('string'));
    // scenarioId comes from the KB scenario id (e.g. auth-*), and is unique.
    const ids = out.testCases.map(tc => tc.scenarioId);
    expect(ids.every(id => id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.some(id => id.startsWith('auth-'))).toBe(true);
  });

  it('exposes the real selectors as a typed field extracted from the steps', () => {
    const plan = planScenarios(LOGIN_REQ, COVERAGE, 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    const out = buildDeterministicOutput(drafts);
    const first = out.testCases[0];
    expect(first.selectors).toEqual(expect.arrayContaining(['#email', '#password', '#login-btn']));
  });
});

describe('applyPolish — canonical reconciliation', () => {
  it('overlays polished wording but preserves EVERY deterministic invariant', () => {
    const plan = planScenarios(LOGIN_REQ, COVERAGE, 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    const det = buildDeterministicOutput(drafts).testCases;
    const polished = {
      cases: det.map(tc => ({
        id: tc.scenarioId,
        title: `Polished: ${tc.title}`,
        objective: `Polished objective`,
        preconditions: tc.preconditions,
        steps: tc.steps.map(s => `Polished ${s}`),
        expected: `Polished expected`,
      })),
    };
    const { cases, contractOk } = applyPolish(det, polished);
    expect(contractOk).toBe(true);
    cases.forEach((c, i) => {
      // wording taken from the model
      expect(c.title.startsWith('Polished:')).toBe(true);
      expect(c.expectedResult).toBe('Polished expected');
      // invariants preserved verbatim
      expect(c.priority).toBe(det[i].priority);
      expect(c.severity).toBe(det[i].severity);
      expect(c.source).toBe(det[i].source);
      expect(c.scenarioId).toBe(det[i].scenarioId);
      expect(c.selectors).toEqual(det[i].selectors);
      expect(c.steps.length).toBe(det[i].steps.length);
    });
  });

  it('ships the deterministic cases unchanged when the model breaks the count contract', () => {
    // Lockout requirement justifies >1 scenario, so a single returned case is a
    // genuine count-contract violation.
    const plan = planScenarios(LOGIN_REQ_LOCKOUT, ['positive', 'negative'], 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ_LOCKOUT);
    const det = buildDeterministicOutput(drafts).testCases;
    const { cases, contractOk } = applyPolish(det, { cases: [{ id: det[0].scenarioId, title: 'only one' }] });
    expect(contractOk).toBe(false);
    expect(cases.length).toBe(det.length);
    expect(cases[0].title).toBe(det[0].title); // unchanged
  });

  it('falls back to deterministic wording when the model omits or blanks a field', () => {
    const plan = planScenarios(LOGIN_REQ, COVERAGE, 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    const det = buildDeterministicOutput(drafts).testCases;
    const polished = { cases: det.map(tc => ({ id: tc.scenarioId, title: '   ' })) };
    const { cases } = applyPolish(det, polished);
    cases.forEach((c, i) => expect(c.title).toBe(det[i].title)); // blank ignored
  });
});

describe('No invention — authentication (quality over quantity)', () => {
  it('a bare login does NOT emit ungrounded FEATURE-SPECIFIC scenarios (no SQL injection / lockout / masking phantoms)', () => {
    // The Sprint 6.x "Standard Coverage" balance fix does NOT relax this
    // invariant for a bare login, because the phantom scenarios below are all
    // FEATURE-SPECIFIC (gated on `conditionalOnKeywords` in the KB: lockout,
    // injection, masking, identifier-format). Standard Coverage only emits
    // category-UNIVERSAL obligations (e.g. required-fields, invalid-format) — it
    // never conjures a mechanism the requirement never mentions. So a bare login
    // still yields exactly the KB's `always` obligations (valid + invalid +
    // required) and nothing feature-specific, even with negative/edge/security
    // all selected.
    const plan = planScenarios(
      { title: 'User Login', description: 'User can log in successfully.' },
      ['positive', 'negative', 'edge_cases', 'security'],
      'authentication',
    );
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    const ids = new Set(drafts.map(d => d.scenarioId));
    // The KB obligations for a bare credential login: valid + invalid + required.
    for (const kb of ['auth-neg-empty-fields', 'auth-neg-wrong-password', 'auth-pos-valid']) {
      expect(ids.has(kb)).toBe(true);
    }
    // The feature-specific (keyword-gated) scenarios are gone — nothing in the
    // bare requirement justifies them, and Standard Coverage never emits them.
    expect(ids.has('auth-sec-injection')).toBe(false);
    expect(ids.has('auth-neg-invalid-identifier-format')).toBe(false);
    expect(ids.has('auth-edge-password-masking')).toBe(false);
    expect(ids.has('auth-neg-locked-user')).toBe(false);
    // Any additional draft is the requirement-grounded step (Sprint 5.1), never
    // an invented mechanism phantom.
    for (const d of drafts) {
      expect(d.scenarioId.startsWith('auth-') || d.scenarioId.startsWith('req-step-')).toBe(true);
    }
  });

  it('explicit evidence (acceptance criteria) DOES justify the corresponding scenarios', () => {
    // When the requirement actually states a lockout rule, the matching
    // scenarios ARE planned — evidence, not a fixed baseline, drives coverage.
    const plan = planScenarios(LOGIN_REQ_LOCKOUT, ['positive', 'negative', 'security'], 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ_LOCKOUT);
    const ids = drafts.map(d => d.scenarioId);
    expect(ids).toContain('auth-pos-valid');
    expect(ids).toContain('auth-neg-locked-user');
    // Each is justified by the acceptance criteria clause.
    for (const d of drafts) {
      if (d.scenarioId === 'auth-neg-locked-user') {
        expect(d.provenance.source).toBe('Acceptance Criteria');
      }
    }
  });
});
