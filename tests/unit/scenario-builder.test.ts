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
  buildFormatterPrompt,
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

    // The primary positive is the CORE happy-path for the requirement, so its
    // provenance is 'core' (always generated, never an assumption). Real
    // selectors still ground it — grounding and provenance are separate axes.
    expect(first.source).toBe('core');
    expect(first.assumption).toBe(false);
    expect(first.grounded).toBe(true);
    expect(first.testData).toContain('standard_user');
  });

  it('varies the DATA intent by coverage type (valid vs invalid vs boundary)', () => {
    const plan = planScenarios(LOGIN_REQ, COVERAGE, 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);

    const pos = drafts.find(d => d.coverageType === 'positive');
    const neg = drafts.find(d => d.coverageType === 'negative');
    expect(pos && pos.steps.join(' ')).toContain('valid');
    expect(neg && neg.steps.join(' ')).toContain('invalid');
  });
});

describe('buildDraftTestCases — coverage floor', () => {
  it('emits at least one draft per grounded (non-conditional) scenario', () => {
    const plan = planScenarios(LOGIN_REQ, COVERAGE, 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    expect(drafts.length).toBeGreaterThanOrEqual(plan.groundedCount);
  });

  it('drops unsupported conditional scenarios but keeps them when the requirement supports them', () => {
    // A plain login must NOT emit drafts for conditional scenarios (lockout,
    // session, remember-me…) that nothing in the requirement/context supports.
    // A requirement that explicitly mentions lockout + logout should pull those
    // scenarios in — raising the draft count above the plain baseline.
    const req = {
      title: 'User Login with lockout',
      description: 'User logs in with email/password. Account locks after repeated failed attempts. User can log out.',
      acceptanceCriteria: 'Lock the account after 3 failed attempts; logout ends the session.',
    };
    const planPlain = planScenarios(LOGIN_REQ, ['positive', 'negative', 'security'], 'authentication');
    const planLock = planScenarios(req, ['positive', 'negative', 'security'], 'authentication');

    const plain = buildDraftTestCases(planPlain, LOGIN_KNOWLEDGE, LOGIN_REQ);
    const lock = buildDraftTestCases(planLock, LOGIN_KNOWLEDGE, req);

    // The lockout requirement supports more scenarios → strictly more drafts.
    expect(lock.drafts.length).toBeGreaterThan(plain.drafts.length);
    // Every draft is either a grounded scenario or a conditional one the
    // requirement/context supported — nothing else leaks through.
    expect(plain.drafts.length).toBe(planPlain.groundedCount + plain.conditionalKept);
    expect(lock.drafts.length).toBe(planLock.groundedCount + lock.conditionalKept);
    // A lockout-related draft is present only in the lockout build.
    const hasLockout = (r: typeof lock) =>
      r.drafts.some(d => /lock|logout|session/i.test(`${d.title} ${d.riskArea}`));
    expect(hasLockout(lock)).toBe(true);
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
    expect(drafts.length).toBeGreaterThanOrEqual(plan.groundedCount);
    expect(groundedCount).toBe(0);
    const PROVENANCE = ['core', 'requirement', 'acceptance_criteria', 'test_data', 'app_knowledge', 'baseline'];
    for (const d of drafts) {
      // No App Profile means nothing is GROUNDED, but every draft still carries
      // a traceable provenance source (derived from the requirement / AC text)
      // and an explicit assumption flag — the builder never invents silently.
      expect(PROVENANCE).toContain(d.source);
      expect(typeof d.assumption).toBe('boolean');
      expect(d.grounded).toBe(false);
      expect(d.steps.length).toBeGreaterThan(0);
    }
    // The core happy-path is present and is never an assumption.
    const core = drafts.find(d => d.source === 'core');
    expect(core && core.assumption).toBe(false);
  });

  it('returns an empty result for an empty/undefined plan (never throws)', () => {
    expect(buildDraftTestCases(undefined, LOGIN_KNOWLEDGE, LOGIN_REQ)).toEqual({
      drafts: [], groundedCount: 0, conditionalKept: 0,
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
    expect(block).toContain('FLOOR, not a ceiling');
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
      // Every case carries a traceable provenance source (no silent invention).
      expect(['core', 'requirement', 'acceptance_criteria', 'test_data', 'app_knowledge', 'baseline'])
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

describe('Formatter mode — minimal prompt', () => {
  it('is DRAMATICALLY smaller than the full draft block, and withholds selectors as invariants', () => {
    const plan = planScenarios(LOGIN_REQ, COVERAGE, 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    const out = buildDeterministicOutput(drafts);
    const formatterPrompt = buildFormatterPrompt(out.testCases);

    // The prompt must NOT contain the requirement, app-profile block headers,
    // knowledge or coverage-objective scaffolding — only the polish payload.
    expect(formatterPrompt).toContain('polish');
    expect(formatterPrompt).toContain(`EXACTLY ${out.testCases.length}`);
    // Selectors and raw URLs are technical invariants that live in `grounding`,
    // NOT in the editable wording payload — the model never sees them and so
    // cannot corrupt them (and this trims the tokens further). Steps stay
    // business-readable.
    expect(formatterPrompt).not.toContain('#email');
    expect(formatterPrompt).not.toContain('#login-btn');
    expect(formatterPrompt).not.toContain('"grounding"');
    // It must NOT drag in the heavy generation scaffolding.
    expect(formatterPrompt).not.toContain('COVERAGE OBJECTIVES');
    expect(formatterPrompt).not.toContain('GROUNDED SCOPE');
    expect(formatterPrompt).not.toContain('Acceptance Criteria');
  });

  it('sends ONLY the editable wording fields — invariants are withheld from the model', () => {
    const plan = planScenarios(LOGIN_REQ, COVERAGE, 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    const out = buildDeterministicOutput(drafts);
    const formatterPrompt = buildFormatterPrompt(out.testCases);
    // The editable payload carries the canonical id + wording fields...
    expect(formatterPrompt).toContain('"id":');
    expect(formatterPrompt).toContain('"expected":');
    // ...but NOT the deterministic invariants (the model never sees them, so it
    // literally cannot change them). This is what cuts the OUTPUT tokens too.
    expect(formatterPrompt).not.toContain('"severity"');
    expect(formatterPrompt).not.toContain('"sourceEvidence"');
    expect(formatterPrompt).not.toContain('"automationComplexity"');
    expect(formatterPrompt).not.toContain('"selectorAvailability"');
    // The payload is compact (whitespace-free array joins).
    expect(formatterPrompt).toContain('},{');
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
    const plan = planScenarios(LOGIN_REQ, COVERAGE, 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
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

describe('No invention — scenarios must be justified, not padded', () => {
  it('a bare login does NOT emit negative/edge scenarios nothing justifies', () => {
    // Philosophy: the builder may only generate scenarios it can trace to the
    // requirement, acceptance criteria, app knowledge or supplied test data.
    // A minimal "log in" requirement (no lockout, no injection, no masking
    // language, and no matching test data) must therefore NOT fabricate those
    // negative/edge/security cases just to inflate the count.
    const plan = planScenarios(LOGIN_REQ, ['positive', 'negative', 'edge_cases', 'security'], 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    const ids = drafts.map(d => d.scenarioId);

    // These are only warranted when the requirement/AC/data mention them.
    expect(ids).not.toContain('auth-sec-injection');
    expect(ids).not.toContain('auth-neg-invalid-identifier-format');
    expect(ids).not.toContain('auth-edge-password-masking');
    expect(ids).not.toContain('auth-neg-empty-fields');
    expect(ids).not.toContain('auth-neg-unknown-user');

    // The core happy-path is always present…
    expect(ids).toContain('auth-pos-valid');
    // …and the AC ("invalid credentials are rejected") justifies exactly the
    // wrong-password negative — traceable to the acceptance criteria.
    const wrong = drafts.find(d => d.scenarioId === 'auth-neg-wrong-password');
    expect(wrong).toBeTruthy();
    expect(wrong!.source).toBe('acceptance_criteria');
    expect(wrong!.assumption).toBe(false);
  });

  it('pulls in a negative/security scenario ONLY when the requirement justifies it', () => {
    // The same builder, given a requirement that explicitly mentions lockout,
    // now legitimately generates the lockout scenarios — because they are
    // traceable to the requirement text, not invented.
    const req = {
      title: 'User Login with lockout',
      description: 'User logs in with email/password. Account locks after repeated failed attempts.',
      acceptanceCriteria: 'Lock the account after 3 failed attempts.',
    };
    const plan = planScenarios(req, ['positive', 'negative', 'security'], 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, req);
    const locked = drafts.find(d => d.scenarioId === 'auth-neg-locked-user');
    expect(locked).toBeTruthy();
    // Justified by the requirement wording → traceable, not an assumption.
    expect(locked!.assumption).toBe(false);
    expect(['requirement', 'acceptance_criteria']).toContain(locked!.source);
  });
});
