/**
 * Intelligence Learning Service — the cross-system learning flywheel (Priority 1).
 *
 * This service closes the highest-impact learning loop in the platform:
 *
 *   Loop L1  Healing → Script Generation (selector priority)
 *   ─────────────────────────────────────────────────────────
 *   Every heal is an admission that a selector broke in production. This
 *   service mines healing history (`healing_actions`, `learned_patterns`),
 *   converts it into a per-(selector, strategy) **stability score**, and exposes
 *   a synchronous provider that `SelectorQualityEngine` consults at GENERATION
 *   time — so selectors that break get demoted before a script is ever emitted.
 *
 * It also publishes two lighter loops:
 *   Loop L2  Test failures → crawl depth recommendations (`crawl_improvements`)
 *   Loop L3 (seed)  Recurring break patterns → healing hints (`healing_patterns`)
 *
 * Everything here is ADDITIVE and FAIL-SAFE: if the DB tables are empty or a
 * query fails, the provider treats every selector as fully stable (multiplier
 * 1.0) and generation behaves exactly as before this feature existed.
 */

import { logger } from '../utils/logger';
import {
  getSelectorStability,
  getStrategyStability,
  getStabilitySummary,
  recordSelectorBreak,
  recordSelectorUsage,
  upsertInsight,
  getInsights,
  getPool,
} from '../db/postgres';

const MOD = 'intel-learning';

/** How much a fully-broken selector is allowed to drag its score down. */
export const STABILITY_FLOOR = 0.5;

export interface LearningScope {
  companyId?: number | null;
  projectId?: number | null;
}

/**
 * A synchronous lookup the SelectorQualityEngine can call while ranking.
 * Returns a stability score in (0,1], or `undefined` when nothing is known
 * (the engine treats `undefined` as fully stable → no score change).
 */
export type SelectorStabilityProvider = (selector: string, strategy: string) => number | undefined;

/* -------------------------------------------------------------------------- */
/*  Strategy inference                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Infer which selector STRATEGY a raw selector string used. Healing records the
 * broken selector text (`failed_locator`) but not its strategy, so we recover it
 * heuristically. Mirrors the strategies emitted by SelectorQualityEngine.
 */
export function inferStrategyFromSelector(selector: string): string {
  const s = (selector || '').trim();
  if (!s) return 'unknown';
  if (/getByTestId|data-testid|data-test=|data-cy/i.test(s)) return 'data-testid';
  if (/getByRole|\brole=/i.test(s)) return 'role';
  if (/getByLabel/i.test(s)) return 'label';
  if (/getByPlaceholder|placeholder=/i.test(s)) return 'placeholder';
  if (/getByText|\btext=/i.test(s)) return 'text';
  if (/\[name=|getByName/i.test(s)) return 'name-attr';
  if (/^\/\/|xpath=/i.test(s)) return 'xpath';
  if (/^#|#[\w-]+/.test(s) || /\bid=/.test(s)) return 'id';
  if (/\.[a-zA-Z][\w-]*/.test(s)) return 'css-class';
  return 'css-combined';
}

/* -------------------------------------------------------------------------- */
/*  Selector stability scorer (the L1 read path)                              */
/* -------------------------------------------------------------------------- */

/**
 * Build a stability provider for a scope. Pre-fetches per-selector and
 * per-strategy stability ONCE (two cheap queries) and returns a closure that
 * resolves stability in O(1):
 *   1. exact (selector, strategy) match  → most specific
 *   2. per-strategy average               → fallback for unseen selectors
 *   3. undefined                          → unknown → engine leaves score as-is
 */
export async function buildStabilityProvider(scope: LearningScope = {}): Promise<SelectorStabilityProvider> {
  let exact = new Map<string, number>();
  let byStrategy = new Map<string, number>();

  try {
    const [rows, strategies] = await Promise.all([
      getSelectorStability(scope),
      getStrategyStability(scope),
    ]);
    for (const r of rows) {
      exact.set(`${r.strategy}::${r.selector}`, r.stability_score);
    }
    for (const s of strategies) {
      // Only treat a per-strategy average as meaningful once we have signal
      // (at least one observed break across a few samples). Otherwise leave it
      // unset so untested strategies are not penalized.
      if (s.total_broken > 0 && s.samples >= 1) {
        byStrategy.set(s.strategy, s.avg_stability);
      }
    }
    logger.info(MOD, 'Stability provider built', {
      scope,
      exactSelectors: exact.size,
      strategiesWithSignal: byStrategy.size,
    });
  } catch (err: any) {
    logger.warn(MOD, 'buildStabilityProvider failed — provider will be a no-op', { error: err.message });
    exact = new Map();
    byStrategy = new Map();
  }

  return (selector: string, strategy: string): number | undefined => {
    const direct = exact.get(`${strategy}::${selector}`);
    if (direct !== undefined) return direct;
    return byStrategy.get(strategy);
  };
}

/**
 * Pure scoring helper (exported for testing + reuse): blend a base quality score
 * with a learned stability score.
 *
 *   adjusted = base × (FLOOR + (1 − FLOOR) × stability)
 *
 * stability === undefined → no change (multiplier 1.0). stability === 1 → no
 * change. stability === 0 → multiplier === FLOOR (max demotion).
 */
export function applyStability(baseScore: number, stability: number | undefined, floor = STABILITY_FLOOR): number {
  if (stability === undefined || stability === null || Number.isNaN(stability)) return baseScore;
  const clamped = Math.max(0, Math.min(1, stability));
  const multiplier = floor + (1 - floor) * clamped;
  return parseFloat((baseScore * multiplier).toFixed(4));
}

/* -------------------------------------------------------------------------- */
/*  Healing-history analyzer (the L1 write path)                              */
/* -------------------------------------------------------------------------- */

export interface AnalyzeResult {
  healsAnalyzed: number;
  selectorsPenalized: number;
  strategyBreakdown: Array<{ strategy: string; breaks: number }>;
  crawlImprovements: number;
}

/**
 * Mine healing history into stability signal + insights. Idempotent enough to
 * run on a schedule or after each healing job. Reads `healing_actions` (the
 * authoritative record of what broke) and records a break for each failed
 * locator, then publishes rollup insights for the dashboard.
 */
export async function analyzeHealingHistory(scope: LearningScope = {}, opts: { sinceDays?: number } = {}): Promise<AnalyzeResult> {
  const sinceDays = opts.sinceDays ?? 90;
  const result: AnalyzeResult = { healsAnalyzed: 0, selectorsPenalized: 0, strategyBreakdown: [], crawlImprovements: 0 };

  let rows: Array<{ failed_locator: string; test_name: string; company_id: number | null; project_id: number | null }> = [];
  try {
    const params: any[] = [];
    const where: string[] = [`failed_locator IS NOT NULL`, `created_at >= NOW() - INTERVAL '${sinceDays} days'`];
    if (scope.companyId != null) { params.push(scope.companyId); where.push(`company_id = $${params.length}`); }
    if (scope.projectId != null) { params.push(scope.projectId); where.push(`project_id = $${params.length}`); }
    const res = await getPool().query(
      `SELECT failed_locator, test_name, company_id, project_id
       FROM healing_actions
       WHERE ${where.join(' AND ')}`,
      params,
    );
    rows = res.rows;
  } catch (err: any) {
    logger.warn(MOD, 'analyzeHealingHistory: could not read healing_actions (non-fatal)', { error: err.message });
    return result;
  }

  const strategyBreaks = new Map<string, number>();
  const testBreaks = new Map<string, number>();

  for (const row of rows) {
    const strategy = inferStrategyFromSelector(row.failed_locator);
    strategyBreaks.set(strategy, (strategyBreaks.get(strategy) || 0) + 1);
    testBreaks.set(row.test_name, (testBreaks.get(row.test_name) || 0) + 1);
    await recordSelectorBreak({
      selector: row.failed_locator,
      strategy,
      companyId: row.company_id ?? scope.companyId ?? null,
      projectId: row.project_id ?? scope.projectId ?? null,
    });
    result.selectorsPenalized++;
  }
  result.healsAnalyzed = rows.length;
  result.strategyBreakdown = Array.from(strategyBreaks.entries())
    .map(([strategy, breaks]) => ({ strategy, breaks }))
    .sort((a, b) => b.breaks - a.breaks);

  // ── Publish per-strategy stability rollup insight (selector_stability type) ──
  for (const { strategy, breaks } of result.strategyBreakdown) {
    await upsertInsight({
      insightType: 'selector_stability',
      scopeKey: strategy,
      payload: { strategy, observed_breaks: breaks, demote: breaks >= 3 },
      confidence: Math.min(1, breaks / 10),
      companyId: scope.companyId ?? null,
      projectId: scope.projectId ?? null,
    });
  }

  // ── Loop L3 seed: recurring break strategies become healing hints ──
  const worstStrategy = result.strategyBreakdown[0];
  if (worstStrategy && worstStrategy.breaks >= 3) {
    await upsertInsight({
      insightType: 'healing_patterns',
      scopeKey: worstStrategy.strategy,
      payload: {
        mutation: `${worstStrategy.strategy}_instability`,
        anti_patterns: [worstStrategy.strategy],
        recommended_strategy: worstStrategy.strategy === 'css-class' || worstStrategy.strategy === 'id' ? 'role' : 'data-testid',
        note: `${worstStrategy.strategy} selectors broke ${worstStrategy.breaks}× — prefer more robust strategies.`,
      },
      confidence: Math.min(1, worstStrategy.breaks / 10),
      companyId: scope.companyId ?? null,
      projectId: scope.projectId ?? null,
    });
  }

  // ── Loop L2 (lightweight): test/flow instability → crawl depth recs ──
  for (const [testName, breaks] of testBreaks.entries()) {
    if (breaks < 2) continue; // only flag repeat offenders
    const recommendedDepth = breaks >= 5 ? 3 : 2;
    const recommendedFrequency = breaks >= 5 ? 'daily' : 'every_other_day';
    await upsertInsight({
      insightType: 'crawl_improvements',
      scopeKey: testName,
      payload: {
        target: testName,
        instability_index: breaks,
        recommended_depth: recommendedDepth,
        recommended_frequency: recommendedFrequency,
        reason: `${breaks} heals observed — crawl deeper/more often to catch drift before tests run.`,
      },
      confidence: Math.min(1, breaks / 8),
      companyId: scope.companyId ?? null,
      projectId: scope.projectId ?? null,
    });
    result.crawlImprovements++;
  }

  logger.info(MOD, 'Healing history analyzed', {
    scope,
    healsAnalyzed: result.healsAnalyzed,
    strategies: result.strategyBreakdown.length,
    crawlImprovements: result.crawlImprovements,
  });
  return result;
}

/* -------------------------------------------------------------------------- */
/*  "Getting smarter over time" metrics                                       */
/* -------------------------------------------------------------------------- */

export interface LearningMetrics {
  stability: Awaited<ReturnType<typeof getStabilitySummary>>;
  strategyStability: Awaited<ReturnType<typeof getStrategyStability>>;
  healRate: { runs: number; heals: number; rate: number };
  insightCounts: Record<string, number>;
  flywheelHealth: 'cold-start' | 'learning' | 'compounding';
}

/**
 * Snapshot of the flywheel for the dashboard. Shows the platform getting
 * smarter: rising stability + falling heal rate + growing insight library.
 */
export async function getLearningMetrics(scope: LearningScope = {}): Promise<LearningMetrics> {
  const [stability, strategyStability, insights] = await Promise.all([
    getStabilitySummary(scope),
    getStrategyStability(scope),
    getInsights({ companyId: scope.companyId ?? null, projectId: scope.projectId ?? null, limit: 500 }),
  ]);

  // Heal rate = heals ÷ runs over the trailing window.
  let runs = 0;
  let heals = 0;
  try {
    const params: any[] = [];
    const w: string[] = [`created_at >= NOW() - INTERVAL '30 days'`];
    if (scope.companyId != null) { params.push(scope.companyId); w.push(`company_id = $${params.length}`); }
    if (scope.projectId != null) { params.push(scope.projectId); w.push(`project_id = $${params.length}`); }
    const [runRes, healRes] = await Promise.all([
      getPool().query(`SELECT COUNT(*) AS c FROM test_executions WHERE ${w.join(' AND ')}`, params),
      getPool().query(`SELECT COUNT(*) AS c FROM healing_actions WHERE ${w.join(' AND ')}`, params),
    ]);
    runs = parseInt(runRes.rows[0].c, 10);
    heals = parseInt(healRes.rows[0].c, 10);
  } catch (err: any) {
    logger.warn(MOD, 'getLearningMetrics: heal-rate query failed (non-fatal)', { error: err.message });
  }

  const insightCounts: Record<string, number> = {};
  for (const i of insights) insightCounts[i.insight_type] = (insightCounts[i.insight_type] || 0) + 1;

  const totalInsights = insights.length;
  const flywheelHealth: LearningMetrics['flywheelHealth'] =
    stability.trackedSelectors === 0 ? 'cold-start'
      : totalInsights >= 10 && stability.avgStability >= 0.7 ? 'compounding'
        : 'learning';

  return {
    stability,
    strategyStability,
    healRate: { runs, heals, rate: runs > 0 ? parseFloat(((heals / runs) * 100).toFixed(1)) : 0 },
    insightCounts,
    flywheelHealth,
  };
}

/**
 * Convenience re-export so callers (e.g. ScriptGenEngine) can record that a
 * selector was emitted during generation without importing the DB layer
 * directly. Fire-and-forget; never blocks generation.
 */
export function trackGeneratedSelector(input: {
  selector: string;
  strategy: string;
  pageUrl?: string | null;
  companyId?: number | null;
  projectId?: number | null;
}): void {
  void recordSelectorUsage(input);
}
