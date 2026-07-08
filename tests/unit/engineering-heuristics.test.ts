/**
 * Unit tests — Engineering Heuristics (Sprint 2 · PR 2B.1)
 * ========================================================
 * Verifies the pre-2C hardening:
 *   • The priority table is centralized and OVERRIDABLE (config, not code).
 *   • Compatibility is a real third dimension — stale/deprecated/wrong-framework
 *     reuse cannot win on engineering value alone.
 *   • Quality gates reuse — code full of sleep()/waitForTimeout() is out-ranked
 *     by a freshly generated implementation (Reuse → Quality Check → Ranking).
 *   • Confidence is derived for the external surface; raw scores stay internal.
 *   • Everything stays deterministic, pure and fail-open. No AI.
 */
import {
  DEFAULT_CANDIDATE_PRIORITY,
  configureCandidatePriority,
  getCandidatePriority,
  resetEngineeringHeuristics,
  assessCompatibility,
  assessQuality,
  deriveConfidence,
  passesGate,
  COMPATIBILITY_MIN,
} from '../../src/script-gen/engineering-heuristics';
import {
  discoverCandidates,
  rankReport,
  type ImplementationCandidate,
  type DiscoveryContext,
} from '../../src/script-gen/candidate-discovery';

/** Minimal candidate factory for direct heuristic tests. */
function cand(
  partial: Partial<ImplementationCandidate> & Pick<ImplementationCandidate, 'type' | 'reuse'>,
): ImplementationCandidate {
  return { source: 'X', reason: 'r', ...partial } as ImplementationCandidate;
}

afterEach(() => resetEngineeringHeuristics());

describe('priority table — centralized & overridable', () => {
  it('defaults match the engineering-value-first table', () => {
    expect(getCandidatePriority('existing-fixture').engineering).toBe(100);
    expect(getCandidatePriority('dom-locator').engineering).toBe(75);
  });

  it('can be overridden without code change (enterprise config)', () => {
    configureCandidatePriority({ 'existing-helper': { engineering: 200 } });
    expect(getCandidatePriority('existing-helper').engineering).toBe(200);
    // untouched dimensions keep their default
    expect(getCandidatePriority('existing-helper').locator).toBe(
      DEFAULT_CANDIDATE_PRIORITY['existing-helper'].locator,
    );
    // unrelated types untouched
    expect(getCandidatePriority('existing-fixture').engineering).toBe(100);
  });

  it('reset restores the built-in defaults', () => {
    configureCandidatePriority({ 'existing-fixture': { engineering: 1 } });
    resetEngineeringHeuristics();
    expect(getCandidatePriority('existing-fixture').engineering).toBe(100);
  });

  it('DEFAULT table is frozen (cannot be mutated in place)', () => {
    expect(Object.isFrozen(DEFAULT_CANDIDATE_PRIORITY)).toBe(true);
  });
});

describe('compatibility — is this reuse compatible with the CURRENT project?', () => {
  it('generated locators are always fully compatible', () => {
    expect(assessCompatibility(cand({ type: 'app-profile-locator', reuse: false }))).toBe(100);
    expect(assessCompatibility(cand({ type: 'dom-locator', reuse: false }))).toBe(100);
  });

  it('clean reuse is fully compatible', () => {
    expect(
      assessCompatibility(cand({ type: 'existing-fixture', reuse: true, meta: { path: 'fixtures/auth.ts' } })),
    ).toBe(100);
  });

  it('explicitly deprecated reuse scores lowest', () => {
    const c = cand({ type: 'existing-helper', reuse: true, meta: { deprecated: true } });
    expect(assessCompatibility(c)).toBeLessThan(COMPATIBILITY_MIN);
  });

  it('legacy/obsolete/archived path or name signals score low', () => {
    for (const meta of [
      { path: 'pages/legacy/login.page.ts' },
      { path: 'pages/login.page.old.ts' },
      { name: 'LegacyLoginPage', path: 'x' },
      { tags: ['archived'] },
    ]) {
      const c = cand({ type: 'existing-page-object', reuse: true, source: (meta as any).name ?? 'X', meta });
      expect(assessCompatibility(c)).toBeLessThan(COMPATIBILITY_MIN);
    }
  });

  it('wrong-framework reuse scores low', () => {
    const c = cand({
      type: 'existing-helper',
      reuse: true,
      meta: { framework: 'cypress', projectFramework: 'playwright' },
    });
    expect(assessCompatibility(c)).toBeLessThan(COMPATIBILITY_MIN);
  });
});

describe('quality — existing code must meet engineering standards', () => {
  it('flags blocking sleep() and hard waits', () => {
    const c = cand({ type: 'existing-helper', reuse: true, meta: { source: 'async function login(){ await sleep(5000); }' } });
    const q = assessQuality(c);
    expect(q.ok).toBe(false);
    expect(q.issues.length).toBeGreaterThan(0);
  });

  it('flags waitForTimeout', () => {
    const c = cand({ type: 'existing-helper', reuse: true, meta: { source: 'await page.waitForTimeout(3000)' } });
    expect(assessQuality(c).ok).toBe(false);
  });

  it('clean code passes', () => {
    const c = cand({ type: 'existing-helper', reuse: true, meta: { source: 'await page.getByRole("button").click()' } });
    expect(assessQuality(c).ok).toBe(true);
  });

  it('fails open when no source snippet is available', () => {
    expect(assessQuality(cand({ type: 'existing-fixture', reuse: true })).ok).toBe(true);
  });

  it('never gates generated locators', () => {
    expect(assessQuality(cand({ type: 'dom-locator', reuse: false })).ok).toBe(true);
  });
});

describe('confidence — external summary', () => {
  const okQ = { ok: true, issues: [] };
  it('high for compatible, high-engineering, passing', () => {
    expect(deriveConfidence({ engineeringValue: 100, compatibility: 100, quality: okQ, gatePass: true })).toBe('high');
  });
  it('low when the gate fails', () => {
    expect(deriveConfidence({ engineeringValue: 100, compatibility: 20, quality: okQ, gatePass: false })).toBe('low');
  });
  it('medium for a raw DOM fallback', () => {
    expect(deriveConfidence({ engineeringValue: 75, compatibility: 100, quality: okQ, gatePass: true })).toBe('medium');
  });
  it('low when quality fails even if scores are high', () => {
    expect(
      deriveConfidence({ engineeringValue: 100, compatibility: 100, quality: { ok: false, issues: ['sleep'] }, gatePass: false }),
    ).toBe('low');
  });
});

describe('gate', () => {
  it('passes only compatible AND quality-ok reuse', () => {
    expect(passesGate(100, { ok: true, issues: [] })).toBe(true);
    expect(passesGate(20, { ok: true, issues: [] })).toBe(false);
    expect(passesGate(100, { ok: false, issues: ['x'] })).toBe(false);
  });
});

describe('integration — gate reorders ranking (Reuse → Quality Check → Ranking)', () => {
  const CTX: DiscoveryContext = {
    pageObjects: [{ name: 'LoginPage', methods: ['login'], path: 'pages/login.page.ts' }],
    fixtures: [{ name: 'loginFixture', path: 'fixtures/auth.fixture.ts' }],
  };
  const rankedCandidates = (ctx: DiscoveryContext) =>
    rankReport(discoverCandidates(['Click Login'], ctx)).steps[0].candidates;

  it('a DEPRECATED fixture is demoted below generated locators', () => {
    const cs = rankedCandidates({
      ...CTX,
      fixtures: [{ name: 'loginFixture', path: 'fixtures/auth.fixture.ts', deprecated: true }],
    });
    const fixture = cs.find((c) => c.type === 'existing-fixture')!;
    const bestLocator = cs.filter((c) => !c.reuse).sort((a, b) => a.rank! - b.rank!)[0];
    expect(fixture.compatibility!).toBeLessThan(COMPATIBILITY_MIN);
    expect(fixture.rank!).toBeGreaterThan(bestLocator.rank!); // demoted
    expect(fixture.confidence).toBe('low');
  });

  it('a LEGACY page object is demoted below generated locators AND a clean fixture', () => {
    const cs = rankedCandidates({
      pageObjects: [{ name: 'LoginPage', methods: ['login'], path: 'pages/legacy/login.page.ts' }],
      fixtures: [{ name: 'loginFixture', path: 'fixtures/auth.fixture.ts' }],
    });
    const po = cs.find((c) => c.type === 'existing-page-object')!;
    const fixture = cs.find((c) => c.type === 'existing-fixture')!;
    const bestLocator = cs.filter((c) => !c.reuse).sort((a, b) => a.rank! - b.rank!)[0];
    expect(po.compatibility!).toBeLessThan(COMPATIBILITY_MIN);
    // The stale PO fails the gate, so it drops below the clean fixture and below
    // every freshly generated locator — even though its raw engineering value (98)
    // would otherwise place it near the top.
    expect(po.rank!).toBeGreaterThan(fixture.rank!);
    expect(po.rank!).toBeGreaterThan(bestLocator.rank!);
  });

  it('a helper with sleep() is out-ranked by a freshly generated locator', () => {
    const cs = rankedCandidates({
      helpers: [{ name: 'AuthHelper', functions: ['login'], path: 'helpers/auth.ts', source: 'await sleep(5000)' }],
    });
    const helper = cs.find((c) => c.type === 'existing-helper')!;
    const bestLocator = cs.filter((c) => !c.reuse).sort((a, b) => a.rank! - b.rank!)[0];
    expect(helper.quality!.ok).toBe(false);
    expect(helper.rank!).toBeGreaterThan(bestLocator.rank!);
  });

  it('a clean, compatible fixture still beats every generated locator', () => {
    const cs = rankedCandidates(CTX);
    const fixture = cs.find((c) => c.type === 'existing-fixture')!;
    const bestLocator = cs.filter((c) => !c.reuse).sort((a, b) => a.rank! - b.rank!)[0];
    expect(fixture.rank!).toBeLessThan(bestLocator.rank!);
    expect(fixture.confidence).toBe('high');
  });

  it('every candidate carries confidence + reason (external surface)', () => {
    for (const c of rankedCandidates(CTX)) {
      expect(['high', 'medium', 'low']).toContain(c.confidence);
      expect(c.reason.length).toBeGreaterThan(0);
    }
  });
});
