/**
 * Unit tests — Candidate Discovery (Sprint 2, Milestone 2A · PR 1)
 * ================================================================
 * Verifies discovery finds candidates from every source (reuse assets + locator
 * families) and — critically — the PR-1 boundaries:
 *   • It NEVER ranks   (report.ranked === false; candidates carry no score).
 *   • It NEVER selects (report.selected === false).
 *   • It is PURE (does not mutate inputs) and NEVER throws (fails open).
 *   • It is DETERMINISTIC (same input → identical output).
 */
import {
  discoverCandidates,
  classifyIntent,
  extractTarget,
  discoverReuseCandidates,
  discoverLocatorCandidates,
  REUSE_TYPES,
  type DiscoveryContext,
  type CandidateType,
} from '../../src/script-gen/candidate-discovery';

// A repo catalogue resembling a SauceDemo-style project.
const CTX: DiscoveryContext = {
  pageObjects: [
    { name: 'LoginPage', methods: ['login', 'logout', 'verifyError'], path: 'pages/login.page.ts' },
    { name: 'InventoryPage', methods: ['addToCart', 'openCart'], path: 'pages/inventory.page.ts' },
  ],
  helpers: [{ name: 'AuthHelper', functions: ['loginAs', 'clearSession'], path: 'helpers/auth.ts' }],
  fixtures: [{ name: 'authenticatedFixture', path: 'fixtures/auth.fixture.ts' }],
  components: [{ name: 'LoginForm', path: 'components/login-form.ts' }],
};

describe('classifyIntent', () => {
  it('detects navigate', () => {
    expect(classifyIntent('Navigate to the login page')).toBe('navigate');
    expect(classifyIntent('Open the dashboard')).toBe('navigate');
  });
  it('detects fill', () => {
    expect(classifyIntent('Enter a valid username')).toBe('fill');
    expect(classifyIntent('Type the password')).toBe('fill');
  });
  it('detects click', () => {
    expect(classifyIntent('Click the Login button')).toBe('click');
    expect(classifyIntent('Press Submit')).toBe('click');
  });
  it('detects verify FIRST so a verify-on-username step is not a fill', () => {
    expect(classifyIntent('Verify the username is displayed')).toBe('verify');
    expect(classifyIntent('Confirm the dashboard is visible')).toBe('verify');
  });
  it('returns unknown for unrecognised / empty steps', () => {
    expect(classifyIntent('')).toBe('unknown');
    expect(classifyIntent('Wibble the frobnicator')).toBe('unknown');
  });
});

describe('extractTarget', () => {
  it('strips verbs and structural words', () => {
    expect(extractTarget('Click the Login button')).toContain('login');
    expect(extractTarget('Enter a valid username into the Username field')).toContain('username');
  });
  it('never throws on junk', () => {
    expect(() => extractTarget('!!! @@@ ')).not.toThrow();
  });
});

describe('discoverReuseCandidates', () => {
  it('finds the matching page-object method (LoginPage.login())', () => {
    const c = discoverReuseCandidates('Click Login', CTX);
    expect(c.some((x) => x.type === 'existing-page-object' && x.source === 'LoginPage.login()')).toBe(true);
  });
  it('finds the matching helper (loginAs())', () => {
    const c = discoverReuseCandidates('Log the user in', CTX);
    expect(c.some((x) => x.type === 'existing-helper' && /loginAs/.test(x.source))).toBe(true);
  });
  it('finds the matching fixture (authenticatedFixture)', () => {
    const c = discoverReuseCandidates('authenticated user session', CTX);
    expect(c.some((x) => x.type === 'existing-fixture')).toBe(true);
  });
  it('finds the matching component (LoginForm)', () => {
    const c = discoverReuseCandidates('fill the login form', CTX);
    expect(c.some((x) => x.type === 'existing-component' && x.source === 'LoginForm')).toBe(true);
  });
  it('returns [] when the repo offers no reusable assets', () => {
    expect(discoverReuseCandidates('Click Login', {})).toEqual([]);
  });
  it('marks reuse candidates with reuse=true', () => {
    const c = discoverReuseCandidates('Click Login', CTX);
    expect(c.every((x) => x.reuse === REUSE_TYPES.has(x.type))).toBe(true);
    expect(c.every((x) => x.reuse === true)).toBe(true);
  });
});

describe('discoverLocatorCandidates', () => {
  it('enumerates all three locator families for a click', () => {
    const c = discoverLocatorCandidates('Click the Login button', 'click');
    const types = c.map((x) => x.type);
    expect(types).toEqual(
      expect.arrayContaining<CandidateType>(['app-profile-locator', 'accessibility-locator', 'dom-locator']),
    );
    expect(c.find((x) => x.type === 'accessibility-locator')!.source).toMatch(/getByRole/);
  });
  it('uses getByLabel for a fill', () => {
    const c = discoverLocatorCandidates('Enter the username', 'fill');
    expect(c.find((x) => x.type === 'accessibility-locator')!.source).toMatch(/getByLabel/);
  });
  it('produces NO locator candidates for navigate / verify', () => {
    expect(discoverLocatorCandidates('Navigate to login', 'navigate')).toEqual([]);
    expect(discoverLocatorCandidates('Verify dashboard visible', 'verify')).toEqual([]);
  });
  it('locator candidates are never reuse', () => {
    const c = discoverLocatorCandidates('Click Login', 'click');
    expect(c.every((x) => x.reuse === false)).toBe(true);
  });
});

describe('discoverCandidates (orchestrator)', () => {
  const STEPS = [
    'Navigate to the login page',
    'Enter a valid username',
    'Enter a valid password',
    'Click the Login button',
    'Verify the dashboard is displayed',
  ];

  it('produces a per-step report with an intent for each step', () => {
    const r = discoverCandidates(STEPS, CTX);
    expect(r.steps).toHaveLength(STEPS.length);
    expect(r.steps.map((s) => s.intent)).toEqual(['navigate', 'fill', 'fill', 'click', 'verify']);
  });

  it('aggregates totals honestly', () => {
    const r = discoverCandidates(STEPS, CTX);
    const manual = r.steps.reduce((n, s) => n + s.candidates.length, 0);
    expect(r.totalCandidates).toBe(manual);
    expect(r.reuseCandidates).toBe(
      r.steps.reduce((n, s) => n + s.candidates.filter((c) => c.reuse).length, 0),
    );
    expect(r.stepsWithCandidates).toBe(r.steps.filter((s) => s.candidates.length > 0).length);
  });

  it('discovers reuse + locator candidates together for a click step', () => {
    const r = discoverCandidates(['Click Login'], CTX);
    const types = new Set(r.steps[0].candidates.map((c) => c.type));
    expect(types.has('existing-page-object')).toBe(true);
    expect(types.has('accessibility-locator')).toBe(true);
    expect(types.has('dom-locator')).toBe(true);
  });

  // ── PR-1 boundary invariants ────────────────────────────────────────────
  it('NEVER ranks — flag is false and candidates carry no score field', () => {
    const r = discoverCandidates(STEPS, CTX);
    expect(r.ranked).toBe(false);
    for (const s of r.steps) {
      for (const c of s.candidates) {
        expect(c).not.toHaveProperty('score');
        expect(c).not.toHaveProperty('rank');
      }
    }
  });

  it('NEVER selects — flag is false', () => {
    expect(discoverCandidates(STEPS, CTX).selected).toBe(false);
  });

  it('is PURE — does not mutate its inputs', () => {
    const steps = [...STEPS];
    const stepsCopy = JSON.parse(JSON.stringify(steps));
    const ctxCopy = JSON.parse(JSON.stringify(CTX));
    discoverCandidates(steps, CTX);
    expect(steps).toEqual(stepsCopy);
    expect(CTX).toEqual(ctxCopy);
  });

  it('is DETERMINISTIC — identical output across runs', () => {
    expect(discoverCandidates(STEPS, CTX)).toEqual(discoverCandidates(STEPS, CTX));
  });

  it('FAILS OPEN — empty report on empty/invalid input, never throws', () => {
    expect(discoverCandidates([], CTX).totalCandidates).toBe(0);
    expect(discoverCandidates(undefined as any).totalCandidates).toBe(0);
    expect(discoverCandidates(null as any).totalCandidates).toBe(0);
    expect(() => discoverCandidates([undefined as any, 123 as any], CTX)).not.toThrow();
  });

  it('works with no repo context (locator families only, no reuse)', () => {
    const r = discoverCandidates(['Click Login'], {});
    expect(r.reuseCandidates).toBe(0);
    expect(r.totalCandidates).toBeGreaterThan(0);
  });
});
