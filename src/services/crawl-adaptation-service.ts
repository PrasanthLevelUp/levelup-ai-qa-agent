/**
 * Crawl Adaptation Service — Loop 2: Test Failures → Crawl Intelligence.
 *
 * This closes the second learning loop in the platform: when generated tests
 * fail in production, the failures are evidence that the original crawl did not
 * capture the page well enough (dynamic content not loaded, animations mid-
 * flight, deeply-nested flows missed). This service turns that evidence into a
 * better crawl configuration for next time:
 *
 *   recordTestFailure(...)   — log a single failed selector against its page.
 *   analyzeFailures(scope)   — aggregate page_failures → upsert crawl_adaptations:
 *                                • flaky page  → raise crawl depth (3 → up to 5)
 *                                • dynamic page → capture loading states +
 *                                  wait for animations (longer wait)
 *                                • volatile elements → suggest alternative
 *                                  selector strategies to retry with
 *   getCrawlAdaptationForUrl — the synchronous-ish provider the script-gen
 *                                engine consults to merge learned params.
 *
 * PRIVACY: every operation respects `learning_scope` (project | company |
 * disabled). When a scope is set to "disabled" the service is a strict no-op —
 * nothing is learned, recorded, or applied. The default "project" scope keeps
 * all learning isolated to a single project (no cross-project leakage), which
 * is what enterprise customers require.
 *
 * Everything is ADDITIVE and FAIL-SAFE: missing tables / empty history simply
 * mean "no adaptation", and the crawler behaves exactly as before.
 */

import { logger } from '../utils/logger';
import {
  recordPageFailure,
  getPageFailureStats,
  upsertCrawlAdaptation,
  getCrawlAdaptation,
  getCrawlAdaptations,
  getLearningScope,
  type LearningScope,
} from '../db/postgres';

const MOD = 'crawl-adapt';

/** Default crawl depth (matches PageCrawler's cap). */
export const DEFAULT_CRAWL_DEPTH = 3;
/** Raised depth applied to flaky pages so deep/dynamic flows get captured. */
export const FLAKY_CRAWL_DEPTH = 5;
/** A page is "flaky" once it accumulates at least this many failures. */
export const FLAKY_FAILURE_THRESHOLD = 3;
/** An element is "volatile" once it breaks at least this many times. */
export const VOLATILE_ELEMENT_THRESHOLD = 2;
/** Longer post-load wait (ms) applied to dynamic pages. */
export const DYNAMIC_WAIT_MS = 4000;

export interface AdaptScope {
  companyId?: number;
  projectId?: number;
}

export interface RecordFailureInput extends AdaptScope {
  pageUrl: string;
  testName?: string | null;
  failedSelector?: string | null;
  elementType?: string | null;
  errorType?: string | null;
  testExecutionId?: number | null;
}

/** Resolved crawl adaptation the script-gen engine merges into its CrawlConfig. */
export interface ResolvedCrawlAdaptation {
  isFlaky: boolean;
  recommendedDepth: number;
  captureLoadingStates: boolean;
  waitForAnimations: boolean;
  recommendedWaitMs: number;
  volatileElements: Array<{ selector: string; count: number }>;
  alternativeStrategies: string[];
}

/**
 * True when learning is permitted for this scope. "disabled" → false.
 * Both "project" and "company" permit learning (they differ only in how widely
 * the learned data may later be shared, which is enforced at read time by the
 * scope used in queries).
 */
async function learningEnabled(scope: AdaptScope): Promise<{ enabled: boolean; mode: LearningScope }> {
  try {
    const mode = await getLearningScope(scope.companyId, scope.projectId);
    return { enabled: mode !== 'disabled', mode };
  } catch {
    // On any error, fall back to the safe default (project-isolated, enabled).
    return { enabled: true, mode: 'project' };
  }
}

/**
 * Record a single test failure against the page it occurred on. Fire-and-forget
 * safe: never throws. Honors `learning_scope` (no-op when disabled).
 */
export async function recordTestFailure(input: RecordFailureInput): Promise<void> {
  if (!input.pageUrl) return;
  const { enabled } = await learningEnabled(input);
  if (!enabled) return; // privacy: learning disabled for this scope

  await recordPageFailure({
    pageUrl: normalizeUrl(input.pageUrl),
    testName: input.testName ?? null,
    failedSelector: input.failedSelector ?? null,
    elementType: input.elementType ?? null,
    errorType: input.errorType ?? null,
    testExecutionId: input.testExecutionId ?? null,
    companyId: input.companyId ?? null,
    projectId: input.projectId ?? null,
  });
}

/**
 * Analyze accumulated failures for a scope and (re)compute the learned crawl
 * adaptation per page. Returns the list of adaptations written.
 *
 * Heuristics:
 *   • failure_count ≥ FLAKY_FAILURE_THRESHOLD          → mark flaky
 *   • flaky                                            → recommendedDepth = 5
 *   • flaky                                            → captureLoadingStates,
 *                                                        waitForAnimations,
 *                                                        recommendedWaitMs ↑
 *   • selectors breaking ≥ VOLATILE_ELEMENT_THRESHOLD  → volatileElements
 *   • volatile selectors                               → alternativeStrategies
 */
export async function analyzeFailures(scope: AdaptScope = {}, windowDays = 30): Promise<ResolvedCrawlAdaptation[]> {
  const { enabled } = await learningEnabled(scope);
  if (!enabled) {
    logger.info(MOD, '🔒 Learning disabled for scope — skipping failure analysis', { scope });
    return [];
  }

  const stats = await getPageFailureStats(windowDays, scope.companyId, scope.projectId);
  const results: ResolvedCrawlAdaptation[] = [];

  for (const page of stats) {
    const isFlaky = page.failure_count >= FLAKY_FAILURE_THRESHOLD;
    const volatileElements = (page.volatile_selectors || []).filter(
      (v) => v.selector && v.count >= VOLATILE_ELEMENT_THRESHOLD
    );
    const alternativeStrategies = suggestAlternativeStrategies(volatileElements.map((v) => v.selector));

    const adaptation: ResolvedCrawlAdaptation = {
      isFlaky,
      recommendedDepth: isFlaky ? FLAKY_CRAWL_DEPTH : DEFAULT_CRAWL_DEPTH,
      captureLoadingStates: isFlaky,
      waitForAnimations: isFlaky,
      recommendedWaitMs: isFlaky ? DYNAMIC_WAIT_MS : 2000,
      volatileElements,
      alternativeStrategies,
    };

    await upsertCrawlAdaptation({
      pageUrl: page.page_url,
      failureCount: page.failure_count,
      isFlaky: adaptation.isFlaky,
      recommendedDepth: adaptation.recommendedDepth,
      captureLoadingStates: adaptation.captureLoadingStates,
      waitForAnimations: adaptation.waitForAnimations,
      recommendedWaitMs: adaptation.recommendedWaitMs,
      volatileElements: adaptation.volatileElements,
      alternativeStrategies: adaptation.alternativeStrategies,
      companyId: scope.companyId ?? null,
      projectId: scope.projectId ?? null,
    });

    results.push(adaptation);
  }

  logger.info(MOD, `🧭 Analyzed ${stats.length} pages → ${results.filter((r) => r.isFlaky).length} flagged flaky`, { scope });
  return results;
}

/**
 * Resolve the learned crawl adaptation for a single page URL, ready to be merged
 * into a CrawlConfig. Returns null when nothing has been learned or when
 * learning is disabled for the scope.
 */
export async function getCrawlAdaptationForUrl(
  pageUrl: string, scope: AdaptScope = {}
): Promise<ResolvedCrawlAdaptation | null> {
  if (!pageUrl) return null;
  const { enabled } = await learningEnabled(scope);
  if (!enabled) return null; // privacy: don't apply learned data when disabled

  const row = await getCrawlAdaptation(normalizeUrl(pageUrl), scope.companyId, scope.projectId);
  if (!row) return null;

  return {
    isFlaky: !!row.is_flaky,
    recommendedDepth: Number(row.recommended_depth) || DEFAULT_CRAWL_DEPTH,
    captureLoadingStates: !!row.capture_loading_states,
    waitForAnimations: !!row.wait_for_animations,
    recommendedWaitMs: Number(row.recommended_wait_ms) || 2000,
    volatileElements: Array.isArray(row.volatile_elements) ? row.volatile_elements : [],
    alternativeStrategies: Array.isArray(row.alternative_strategies) ? row.alternative_strategies : [],
  };
}

/** List all learned adaptations for a scope (for the crawl-intelligence API). */
export async function listCrawlAdaptations(scope: AdaptScope = {}): Promise<any[]> {
  const { enabled } = await learningEnabled(scope);
  if (!enabled) return [];
  return getCrawlAdaptations(scope.companyId, scope.projectId);
}

/** Per-page failure report for a scope (for the crawl-intelligence API). */
export async function getFailureReport(scope: AdaptScope = {}, windowDays = 30): Promise<any[]> {
  const { enabled } = await learningEnabled(scope);
  if (!enabled) return [];
  return getPageFailureStats(windowDays, scope.companyId, scope.projectId);
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Suggest alternative selector strategies to retry with, given the strategies
 * that have proven volatile. We prefer the most resilient strategies (test-id,
 * role, label) and exclude whatever broke.
 */
export function suggestAlternativeStrategies(volatileSelectors: string[]): string[] {
  const RESILIENCE_ORDER = ['data-testid', 'role', 'label', 'placeholder', 'text', 'name-attr', 'css-combined'];
  const broken = new Set(volatileSelectors.map(inferStrategy));
  const suggestions = RESILIENCE_ORDER.filter((s) => !broken.has(s));
  // Always keep at least the top resilient strategies as a fallback ladder.
  return suggestions.slice(0, 4);
}

/** Trimmed strategy inference (mirrors the DB-layer heuristic). */
function inferStrategy(selector: string): string {
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

/** Normalize a URL to a stable key (strip query/hash, trailing slash). */
export function normalizeUrl(url: string): string {
  if (!url) return url;
  try {
    const u = new URL(url);
    let path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.origin}${path}`;
  } catch {
    // Not an absolute URL — strip query/hash best-effort.
    return url.split('?')[0].split('#')[0].replace(/\/+$/, '') || url;
  }
}
