/**
 * Unit tests — Engineering Standards (Sprint 2 · PR 2B.1)
 * =======================================================
 * One deterministic decision per candidate. Verifies:
 *   • evaluateCandidate() folds compatibility + quality into a single
 *     engineeringValue (the sort key) — Ranking is then just a sort.
 *   • Stale reuse (deprecated / legacy / wrong-framework) is driven BELOW the
 *     generated-locator floor, so it can never win by merely existing.
 *   • Bad reuse (sleep / waitForTimeout / pause / FIXME) is likewise demoted.
 *   • Confidence is derived for the external surface; raw numbers stay internal.
 *   • Pure, deterministic, fail-open. No AI. Override API stays internal.
 */
import {
  DEFAULT_CANDIDATE_PRIORITY,
  configureCandidatePriority,
  resetEngineeringStandards,
  assessCompatibility,
  assessQuality,
  evaluateCandidate,
  COMPATIBILITY_MIN,
} from '../../src/script-gen/engineering-standards';
import {
  discoverCandidates,
  rankReport,
  type ImplementationCandidate,
  type DiscoveryContext,
} from '../../src/script-gen/candidate-discovery';

/** Minimal candidate factory for direct evaluation tests. */
function cand(
  partial: Partial<ImplementationCandidate> & Pick<ImplementationCandidate, 'type' | 'reuse'>,
): ImplementationCandidate {
  return { source: 'X', reason: 'r', ...partial } as ImplementationCandidate;
}

/** The generated-locator floor — nothing stale should outrank this. */
const DOM_FLOOR = DEFAULT_CANDIDATE_PRIORITY['dom-locator'].engineering; // 75

afterEach(() => resetEngineeringStandards());

describe('evaluateCandidate — the one decision', () => {
  it('a clean, compatible candidate keeps its base engineering value', () => {
    expect(evaluateCandidate(cand({ type: 'existing-fixture', reuse: true })).engineeringValue).toBe(100);
    expect(evaluateCandidate(cand({ type: 'app-profile-locator', reuse: false })).engineeringValue).toBe(92);
    expect(evaluateCandidate(cand({ type: 'dom-locator', reuse: false })).engineeringValue).toBe(75);
  });

  it('returns the whole verdict in one object', () => {
    const e = evaluateCandidate(cand({ type: 'existing-page-object', reuse: true }));
    expect(e).toEqual(
      expect.objectContaining({
        engineeringValue: expect.any(Number),
        locatorQuality: expect.any(Number),
        compatibility: expect.any(Number),
        quality: expect.objectContaining({ ok: expect.any(Boolean) }),
        confidence: expect.stringMatching(/high|medium|low/),
      }),
    );
  });

  it('DEPRECATED reuse is driven below the generated-locator floor', () => {
    const e = evaluateCandidate(cand({ type: 'existing-fixture', reuse: true, meta: { deprecated: true } }));
    expect(e.engineeringValue).toBeLessThan(DOM_FLOOR);
    expect(e.confidence).toBe('low');
  });

  it('LEGACY reuse (even a page object) drops below the floor', () => {
    const e = evaluateCandidate(
      cand({ type: 'existing-page-object', reuse: true, source: 'LegacyLoginPage', meta: { path: 'pages/legacy/login.ts' } }),
    );
    expect(e.engineeringValue).toBeLessThan(DOM_FLOOR);
  });

  it('WRONG-framework reuse drops below the floor', () => {
    const e = evaluateCandidate(
      cand({ type: 'existing-helper', reuse: true, meta: { framework: 'cypress', projectFramework: 'playwright' } }),
    );
    expect(e.engineeringValue).toBeLessThan(DOM_FLOOR);
  });

  it('BAD-quality reuse (sleep) drops below the floor', () => {
    const e = evaluateCandidate(
      cand({ type: 'existing-fixture', reuse: true, meta: { source: 'await sleep(5000)' } }),
    );
    expect(e.quality.ok).toBe(false);
    expect(e.engineeringValue).toBeLessThan(DOM_FLOOR);
    expect(e.confidence).toBe('low');
  });

  it('never penalises generated locators (they are compatible & ungated)', () => {
    for (const type of ['app-profile-locator', 'accessibility-locator', 'dom-locator'] as const) {
      const e = evaluateCandidate(cand({ type, reuse: false, meta: { source: 'await sleep(1)' } }));
      expect(e.compatibility).toBe(100);
      expect(e.quality.ok).toBe(true);
    }
  });

  it('is deterministic', () => {
    const c = cand({ type: 'existing-helper', reuse: true, meta: { path: 'helpers/auth.ts' } });
    expect(evaluateCandidate(c)).toEqual(evaluateCandidate(c));
  });
});

describe('compatibility signals', () => {
  it('clean reuse and all generated locators are fully compatible', () => {
    expect(assessCompatibility(cand({ type: 'existing-fixture', reuse: true, meta: { path: 'fixtures/auth.ts' } }))).toBe(100);
    expect(assessCompatibility(cand({ type: 'dom-locator', reuse: false }))).toBe(100);
  });

  it('deprecated / legacy / archived / framework-mismatch all score below the min', () => {
    const stale: Array<Partial<ImplementationCandidate>> = [
      { meta: { deprecated: true } },
      { source: 'LegacyLoginPage', meta: { path: 'x' } },
      { meta: { path: 'pages/login.page.old.ts' } },
      { meta: { tags: ['archived'] } },
      { meta: { framework: 'cypress', projectFramework: 'playwright' } },
    ];
    for (const s of stale) {
      expect(assessCompatibility(cand({ type: 'existing-page-object', reuse: true, ...s }))).toBeLessThan(COMPATIBILITY_MIN);
    }
  });
});

describe('quality signals', () => {
  it('flags sleep / waitForTimeout / pause / FIXME', () => {
    for (const src of ['await sleep(5000)', 'await page.waitForTimeout(3000)', 'await page.pause()', '// FIXME later']) {
      expect(assessQuality(cand({ type: 'existing-helper', reuse: true, meta: { source: src } })).ok).toBe(false);
    }
  });
  it('passes clean code and fails open with no source', () => {
    expect(assessQuality(cand({ type: 'existing-helper', reuse: true, meta: { source: 'await page.getByRole("button").click()' } })).ok).toBe(true);
    expect(assessQuality(cand({ type: 'existing-fixture', reuse: true })).ok).toBe(true);
  });
});

describe('priority table — internal override', () => {
  it('DEFAULT table is frozen', () => {
    expect(Object.isFrozen(DEFAULT_CANDIDATE_PRIORITY)).toBe(true);
  });
  it('override changes evaluation, reset restores it', () => {
    configureCandidatePriority({ 'existing-helper': { engineering: 200 } });
    expect(evaluateCandidate(cand({ type: 'existing-helper', reuse: true })).engineeringValue).toBe(200);
    resetEngineeringStandards();
    expect(evaluateCandidate(cand({ type: 'existing-helper', reuse: true })).engineeringValue).toBe(96);
  });
});

describe('integration — Ranking is just sort(engineeringValue)', () => {
  const CTX: DiscoveryContext = {
    pageObjects: [{ name: 'LoginPage', methods: ['login'], path: 'pages/login.page.ts' }],
    fixtures: [{ name: 'loginFixture', path: 'fixtures/auth.fixture.ts' }],
  };
  const ranked = (ctx: DiscoveryContext) => rankReport(discoverCandidates(['Click Login'], ctx)).steps[0].candidates;
  const bestLocatorRank = (cs: ImplementationCandidate[]) =>
    cs.filter((c) => !c.reuse).sort((a, b) => a.rank! - b.rank!)[0].rank!;

  it('a clean, compatible fixture beats every generated locator', () => {
    const cs = ranked(CTX);
    const fixture = cs.find((c) => c.type === 'existing-fixture')!;
    expect(fixture.rank!).toBeLessThan(bestLocatorRank(cs));
    expect(fixture.confidence).toBe('high');
  });

  it('a DEPRECATED fixture is demoted below generated locators', () => {
    const cs = ranked({ ...CTX, fixtures: [{ name: 'loginFixture', path: 'fixtures/auth.fixture.ts', deprecated: true }] });
    const fixture = cs.find((c) => c.type === 'existing-fixture')!;
    expect(fixture.rank!).toBeGreaterThan(bestLocatorRank(cs));
    expect(fixture.confidence).toBe('low');
  });

  it('a LEGACY page object is demoted below a clean fixture AND generated locators', () => {
    const cs = ranked({
      pageObjects: [{ name: 'LoginPage', methods: ['login'], path: 'pages/legacy/login.page.ts' }],
      fixtures: [{ name: 'loginFixture', path: 'fixtures/auth.fixture.ts' }],
    });
    const po = cs.find((c) => c.type === 'existing-page-object')!;
    const fixture = cs.find((c) => c.type === 'existing-fixture')!;
    expect(po.rank!).toBeGreaterThan(fixture.rank!);
    expect(po.rank!).toBeGreaterThan(bestLocatorRank(cs));
  });

  it('a helper full of sleep() is out-ranked by a freshly generated locator', () => {
    const cs = ranked({ helpers: [{ name: 'AuthHelper', functions: ['login'], path: 'helpers/auth.ts', source: 'await sleep(5000)' }] });
    const helper = cs.find((c) => c.type === 'existing-helper')!;
    expect(helper.rank!).toBeGreaterThan(bestLocatorRank(cs));
  });

  it('every candidate carries confidence + reason (external surface)', () => {
    for (const c of ranked(CTX)) {
      expect(['high', 'medium', 'low']).toContain(c.confidence);
      expect(c.reason.length).toBeGreaterThan(0);
    }
  });
});
