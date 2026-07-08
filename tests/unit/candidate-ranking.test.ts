/**
 * Unit tests — Candidate Ranking (Sprint 2, Milestone 2B · PR 2B)
 * ===============================================================
 * Verifies deterministic, engineering-value-first ranking and its boundaries:
 *   • Reuse beats generation — a fixture outranks even a higher-locator-quality
 *     new locator (the decisive product rule).
 *   • Ranking ORDERS + scores but NEVER selects (report.selected === false) and
 *     never changes generated code.
 *   • Pure (no input mutation), deterministic, fail-open, and every candidate
 *     keeps its `reason`.
 */
import {
  discoverCandidates,
  rankReport,
  CANDIDATE_PRIORITY,
  type DiscoveryContext,
  type CandidateDiscoveryReport,
  type ImplementationCandidate,
} from '../../src/script-gen/candidate-discovery';

const CTX: DiscoveryContext = {
  pageObjects: [{ name: 'LoginPage', methods: ['login', 'logout'], path: 'pages/login.page.ts' }],
  helpers: [{ name: 'AuthHelper', functions: ['loginAs'], path: 'helpers/auth.ts' }],
  fixtures: [{ name: 'loginFixture', path: 'fixtures/auth.fixture.ts' }],
  components: [{ name: 'LoginForm', path: 'components/login-form.ts' }],
};

function rankedFor(step: string, ctx: DiscoveryContext = CTX): CandidateDiscoveryReport {
  return rankReport(discoverCandidates([step], ctx));
}
function candidatesOf(step: string, ctx: DiscoveryContext = CTX): ImplementationCandidate[] {
  return rankedFor(step, ctx).steps[0].candidates;
}

describe('rankReport — flags & shape', () => {
  it('sets ranked=true and keeps selected=false', () => {
    const r = rankedFor('Click Login');
    expect(r.ranked).toBe(true);
    expect(r.selected).toBe(false);
  });

  it('assigns a 1-based contiguous rank to every candidate', () => {
    const cs = candidatesOf('Click Login');
    expect(cs.map((c) => c.rank)).toEqual(cs.map((_, i) => i + 1));
  });

  it('scores every candidate with both dimensions', () => {
    for (const c of candidatesOf('Click Login')) {
      expect(typeof c.engineeringValue).toBe('number');
      expect(typeof c.locatorQuality).toBe('number');
      expect(c.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('engineering-value-first ordering', () => {
  it('reuse (fixture) OUTRANKS a higher-locator-quality new locator', () => {
    const cs = candidatesOf('Click Login');
    const fixture = cs.find((c) => c.type === 'existing-fixture')!;
    const appLoc = cs.find((c) => c.type === 'app-profile-locator')!;
    // The fixture has LOWER locator quality but wins on engineering value…
    expect(fixture.locatorQuality!).toBeLessThan(appLoc.locatorQuality!);
    expect(fixture.engineeringValue!).toBeGreaterThan(appLoc.engineeringValue!);
    // …so it ranks ahead of the locator.
    expect(fixture.rank!).toBeLessThan(appLoc.rank!);
  });

  it('orders reuse families fixture > page-object > helper > component', () => {
    const cs = candidatesOf('Click Login');
    const rankOf = (t: string) => cs.find((c) => c.type === t)?.rank ?? Infinity;
    expect(rankOf('existing-fixture')).toBeLessThan(rankOf('existing-page-object'));
    expect(rankOf('existing-page-object')).toBeLessThan(rankOf('existing-helper'));
    expect(rankOf('existing-helper')).toBeLessThan(rankOf('existing-component'));
  });

  it('places every reuse candidate ahead of every generated locator', () => {
    const cs = candidatesOf('Click Login');
    const worstReuseRank = Math.max(...cs.filter((c) => c.reuse).map((c) => c.rank!));
    const bestLocatorRank = Math.min(...cs.filter((c) => !c.reuse).map((c) => c.rank!));
    expect(worstReuseRank).toBeLessThan(bestLocatorRank);
  });

  it('rank #1 is a reuse candidate when any reuse asset matched', () => {
    expect(candidatesOf('Click Login')[0].reuse).toBe(true);
  });

  it('orders locator families app-profile > accessibility > dom when no reuse exists', () => {
    const cs = candidatesOf('Click Login', {}); // no repo assets → locators only
    expect(cs[0].type).toBe('app-profile-locator');
    expect(cs.map((c) => c.type)).toEqual(['app-profile-locator', 'accessibility-locator', 'dom-locator']);
  });
});

describe('priority table', () => {
  it('engineering value is reuse-first (all reuse types >= every locator type)', () => {
    const p = CANDIDATE_PRIORITY;
    const reuseMin = Math.min(
      p['existing-fixture'].engineering,
      p['existing-page-object'].engineering,
      p['existing-helper'].engineering,
      p['existing-component'].engineering,
    );
    const locatorMax = Math.max(
      p['app-profile-locator'].engineering,
      p['accessibility-locator'].engineering,
      p['dom-locator'].engineering,
    );
    expect(reuseMin).toBeGreaterThanOrEqual(locatorMax);
  });

  it('encodes the deliberate inversion: app-profile locator quality > fixture locator quality', () => {
    expect(CANDIDATE_PRIORITY['app-profile-locator'].locator)
      .toBeGreaterThan(CANDIDATE_PRIORITY['existing-fixture'].locator);
  });
});

describe('invariants', () => {
  const STEPS = ['Navigate to login', 'Enter username', 'Click Login', 'Verify dashboard'];

  it('is PURE — does not mutate the discovery report it ranks', () => {
    const disc = discoverCandidates(STEPS, CTX);
    const snapshot = JSON.parse(JSON.stringify(disc));
    rankReport(disc);
    expect(disc).toEqual(snapshot);
  });

  it('is DETERMINISTIC — identical output across runs', () => {
    const disc = discoverCandidates(STEPS, CTX);
    expect(rankReport(disc)).toEqual(rankReport(disc));
  });

  it('NEVER selects — selected stays false and no winner field is added', () => {
    const r = rankReport(discoverCandidates(STEPS, CTX));
    expect(r.selected).toBe(false);
    expect(r).not.toHaveProperty('winner');
    expect(r).not.toHaveProperty('selectedCandidate');
  });

  it('FAILS OPEN — ranking an empty report is safe', () => {
    const empty = discoverCandidates([], CTX);
    const r = rankReport(empty);
    expect(r.totalCandidates).toBe(0);
    expect(() => rankReport(empty)).not.toThrow();
  });

  it('preserves totals (ranking reorders, never adds/drops candidates)', () => {
    const disc = discoverCandidates(STEPS, CTX);
    const r = rankReport(disc);
    expect(r.totalCandidates).toBe(disc.totalCandidates);
    expect(r.reuseCandidates).toBe(disc.reuseCandidates);
    for (let i = 0; i < disc.steps.length; i++) {
      expect(r.steps[i].candidates).toHaveLength(disc.steps[i].candidates.length);
    }
  });
});
