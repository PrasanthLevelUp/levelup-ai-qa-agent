import {
  DEFAULT_RERUN_BUDGET_CONFIG,
  minTrustworthyRerunMs,
  canStartTrustworthyRerun,
  rerunTimeoutMs,
  type RerunBudgetConfig,
} from '../../src/core/rerun-budget';

const cfg: RerunBudgetConfig = DEFAULT_RERUN_BUDGET_CONFIG; // 30s action + 15s buffer, 120s ceiling
const REPO_ACTION = cfg.repoActionTimeoutMs; // 30000

describe('rerun-budget — validation rerun must outlast the repo action timeout', () => {
  it('minimum trustworthy rerun = repo action timeout + buffer (45s by default)', () => {
    expect(minTrustworthyRerunMs(cfg)).toBe(45_000);
  });

  describe('INVARIANT: rerunTimeoutMs() is ALWAYS >= repoActionTimeout + buffer', () => {
    // The exact regression: old code floored at 15s (< 30s action timeout), so a
    // rerun could be killed before Playwright emitted its located locator error.
    const budgets = [0, 1_000, 14_999, 15_000, 15_001, 29_999, 30_000, 45_000, 90_000, 120_000, 600_000];
    for (const remaining of budgets) {
      it(`remaining=${remaining}ms → rerunTimeout >= ${minTrustworthyRerunMs(cfg)} AND >= repo action (${REPO_ACTION})`, () => {
        const t = rerunTimeoutMs(remaining, cfg);
        expect(t).toBeGreaterThanOrEqual(minTrustworthyRerunMs(cfg));
        expect(t).toBeGreaterThanOrEqual(REPO_ACTION); // never killed before the located error can fire
        expect(t).toBeLessThanOrEqual(cfg.ceilingMs);
      });
    }
  });

  it('regression guard: old 15s floor would have violated the rule — new floor does not', () => {
    // Simulate the previous formula explicitly to document the bug.
    const oldFormula = (remaining: number) => Math.max(15_000, Math.min(120_000, remaining));
    expect(oldFormula(20_000)).toBeLessThan(REPO_ACTION);          // 15000–20000 < 30000  (BUG)
    expect(rerunTimeoutMs(20_000, cfg)).toBeGreaterThanOrEqual(REPO_ACTION); // fixed
  });

  it('scales with budget between floor and ceiling', () => {
    expect(rerunTimeoutMs(60_000, cfg)).toBe(60_000);
    expect(rerunTimeoutMs(200_000, cfg)).toBe(120_000); // capped
    expect(rerunTimeoutMs(10_000, cfg)).toBe(45_000);   // floored to min trustworthy
  });

  describe('canStartTrustworthyRerun — never START a rerun we cannot honor', () => {
    it('false when remaining < min trustworthy budget (don\'t start a doomed rerun)', () => {
      expect(canStartTrustworthyRerun(0, cfg)).toBe(false);
      expect(canStartTrustworthyRerun(29_999, cfg)).toBe(false);
      expect(canStartTrustworthyRerun(44_999, cfg)).toBe(false);
    });
    it('true once at least min trustworthy budget remains', () => {
      expect(canStartTrustworthyRerun(45_000, cfg)).toBe(true);
      expect(canStartTrustworthyRerun(120_000, cfg)).toBe(true);
    });
  });

  it('respects a larger repo action timeout (e.g. repo sets test timeout = 60s)', () => {
    const big: RerunBudgetConfig = { repoActionTimeoutMs: 60_000, bufferMs: 15_000, ceilingMs: 120_000 };
    expect(minTrustworthyRerunMs(big)).toBe(75_000);
    expect(rerunTimeoutMs(10_000, big)).toBe(75_000);
    expect(canStartTrustworthyRerun(74_999, big)).toBe(false);
    expect(canStartTrustworthyRerun(75_000, big)).toBe(true);
  });
});
