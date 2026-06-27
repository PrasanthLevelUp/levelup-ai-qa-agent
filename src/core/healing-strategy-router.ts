/**
 * Healing Strategy Router (Diagnosis → Disposition)  — ADVISOR architecture
 * ------------------------------------------------------------------------
 * This stage sits between the diagnosis ("WHAT failed") and the healing advisors
 * ("HOW to fix"). It consumes a `FailureDiagnosis` and decides the DISPOSITION
 * of the failure — NOT a final verdict.
 *
 * ── Why this was rewritten (Gate → Advisor) ──
 * The previous router was a *gate*: a regex-driven category (`framework`,
 * `unknown`, or a low-confidence guess) could TERMINATE healing at `report_only`
 * — upstream of Repo Intelligence, App Profile, DOM Memory, Reuse Intelligence,
 * Rule Engine and AI. That inverted the product promise ("Repo Intelligence
 * first"): the very intelligence that could disprove a "framework/unknown" guess
 * never ran, because a regex stopped it.
 *
 * In the Advisor architecture the router NEVER lets a weak signal terminate
 * healing. It only recognises a small set of genuine **hard stops** — failures
 * where a locator swap is categorically the wrong tool:
 *   - assertion  (element found, value/state mismatch → product/data finding)
 *   - navigation (page/site failed to load → infra)
 *   - api        (request/response failure → backend)
 *   - environment(missing config/credential/permission)
 *
 * Every other category — `locator`, `framework`, `unknown`, and any
 * low-confidence diagnosis — is dispositioned **`advisor`**: it flows into the
 * grounded advisor pipeline, where each advisor only proposes candidates and
 * ONLY the Validation layer (browser rerun) decides whether a candidate
 * succeeds. `timing` is routed to wait-injection (never a locator change).
 *
 * Pure & deterministic; no side effects.
 */

import type { FailureDiagnosis, FailureCategory, RecommendedStrategy } from './failure-classifier';

export type HealingRemedy = 'locator_swap' | 'inject_wait' | 'report_only';

/**
 * The disposition of a failure in the Advisor architecture:
 *  - `hard_stop`  — categorically not a locator/heal problem; report honestly.
 *  - `advisor`    — route into the grounded advisor pipeline; no single signal
 *                   terminates healing. Only Validation decides pass/fail.
 *  - `inject_wait`— a timing problem; inject/raise a wait, never change the locator.
 */
export type HealingDisposition = 'hard_stop' | 'advisor' | 'inject_wait';

/**
 * Categories where a locator swap is categorically the wrong tool. These — and
 * ONLY these — terminate at `report_only`. Everything else is an advisor case.
 */
const HARD_STOP_CATEGORIES: ReadonlySet<FailureCategory> = new Set<FailureCategory>([
  'assertion',
  'navigation',
  'api',
  'environment',
]);

export interface HealingStrategyPlan {
  /** Whether the locator-swap healing loop (advisors + browser rerun) should run. */
  shouldAttemptLocatorHealing: boolean;
  /** The remedy class chosen for this failure. */
  remedy: HealingRemedy;
  /** Advisor-architecture disposition (hard_stop / advisor / inject_wait). */
  disposition: HealingDisposition;
  /** The diagnostic category this plan was derived from. */
  category: FailureCategory;
  /** The specific evidence-driven strategy from the diagnosis (e.g. wait_for_overlay). */
  recommendedStrategy: RecommendedStrategy;
  /** Plain-language rationale for the routing decision (surfaced in the trail). */
  rationale: string;
  /**
   * When true, the failure is a legitimate finding to surface to humans rather
   * than something the engine should attempt to auto-fix. Only ever true for a
   * `hard_stop` disposition.
   */
  reportOnly: boolean;
}

/** Map a fine-grained recommended strategy onto the coarse remedy class. */
function remedyForStrategy(s: RecommendedStrategy): HealingRemedy {
  switch (s) {
    case 'locator_swap':
      return 'locator_swap';
    case 'wait_for_overlay':
    case 'wait_for_visible':
    case 'wait_for_enabled':
    case 'inject_wait':
      return 'inject_wait';
    default:
      return 'report_only';
  }
}

export function routeHealingStrategy(diagnosis: FailureDiagnosis): HealingStrategyPlan {
  const { category } = diagnosis;

  const reportOnlyPlan = (rationale: string): HealingStrategyPlan => ({
    shouldAttemptLocatorHealing: false,
    remedy: 'report_only',
    disposition: 'hard_stop',
    category,
    recommendedStrategy: 'report_only',
    rationale,
    reportOnly: true,
  });

  /**
   * Route into the grounded advisor pipeline. NO single signal (regex category,
   * low confidence, missing inline locator) is allowed to terminate healing here
   * — that is the whole point of the Advisor architecture. The advisors (Repo
   * Intelligence, App Profile, DOM Memory, Reuse Intelligence, Rule, AI) each
   * propose candidates from real evidence; if none survive, the Validation layer
   * (browser rerun) — not this router — declares the failure unhealed.
   */
  const advisorPlan = (rationale: string): HealingStrategyPlan => ({
    shouldAttemptLocatorHealing: true,
    remedy: 'locator_swap',
    disposition: 'advisor',
    category,
    recommendedStrategy: 'locator_swap',
    rationale,
    reportOnly: false,
  });

  // ── Hard stops ──────────────────────────────────────────────────────────
  // These four categories are categorically NOT locator/heal problems. They are
  // the only failures the router is allowed to terminate. (Confidence does not
  // matter here: an assertion is an assertion regardless of how confident we are.)
  if (HARD_STOP_CATEGORIES.has(category)) {
    return reportOnlyPlan(hardStopRationale(category));
  }

  switch (category) {
    case 'locator':
      // A concrete, grounded locator → high-signal locator healing.
      if (diagnosis.healableByLocatorSwap && diagnosis.locator) {
        return {
          shouldAttemptLocatorHealing: true,
          remedy: 'locator_swap',
          disposition: 'advisor',
          category,
          recommendedStrategy: 'locator_swap',
          rationale: diagnosis.locatorResolvedFromPageObject
            ? `Locator ${diagnosis.locator} (resolved from the Page Object) was not found — route to grounded locator healing.`
            : `Locator ${diagnosis.locator} was not found — route to grounded locator healing.`,
          reportOnly: false,
        };
      }
      // ADVISOR (was: report_only). Even without a concrete inline locator, the
      // grounded advisors can still ground a selector from the failing line, the
      // URL, the Page Object, or the App Profile crawl. Refusing here is exactly
      // the "regex starves the advisors" inversion we removed.
      return advisorPlan(
        'Locator-type failure with no concrete inline locator — routing to the grounded ' +
          'advisor pipeline (App Profile / Repo Intelligence may still ground a selector). ' +
          'No selector is swapped unless an advisor produces one and Validation confirms it.',
      );

    case 'timing': {
      // Honor the specific evidence-driven wait strategy when present
      // (wait_for_overlay / wait_for_visible / wait_for_enabled). Any other
      // strategy (locator_swap/report_only/none) is never valid for a timing
      // failure, so fall back to a generic wait injection — a timing failure
      // must never change the locator.
      const isWaitStrategy =
        diagnosis.recommendedStrategy === 'wait_for_overlay' ||
        diagnosis.recommendedStrategy === 'wait_for_visible' ||
        diagnosis.recommendedStrategy === 'wait_for_enabled' ||
        diagnosis.recommendedStrategy === 'inject_wait';
      const strat: RecommendedStrategy = isWaitStrategy ? diagnosis.recommendedStrategy : 'inject_wait';
      return {
        shouldAttemptLocatorHealing: false,
        remedy: remedyForStrategy(strat),
        disposition: 'inject_wait',
        category,
        recommendedStrategy: strat,
        rationale:
          diagnosis.evidenceBased && strat !== 'inject_wait'
            ? `Timing failure (evidence-based: ${strat}) — ${diagnosis.rootCause} Inject the appropriate wait and rerun; the locator is not changed.`
            : 'Timing failure — inject/raise an explicit wait and rerun; the locator is not changed.',
        reportOnly: false,
      };
    }

    // ── Advisor cases (was: terminal report_only) ──────────────────────────
    // `framework` and `unknown` are the regex-driven categories that previously
    // STOPPED healing before any grounded advisor ran. A framework/unclassified
    // signal is now treated as exactly that — a signal, not a verdict. We route
    // to the advisor pipeline so Repo Intelligence / App Profile can disprove the
    // guess and ground a real selector. If they cannot, Validation (not the
    // router) declares the failure unhealed, and an untrustworthy run is reported
    // as `inconclusive` (see execution-trust), never as a "framework" verdict.
    case 'framework':
      return advisorPlan(
        'Framework/runner signal detected, but a regex must not terminate healing. ' +
          'Routing to the grounded advisor pipeline (Repo Intelligence / App Profile first); ' +
          'only Validation decides whether a candidate succeeds.',
      );

    case 'unknown':
    default:
      return advisorPlan(
        'Unclassified failure — "unknown" is not "unhealable". Routing to the grounded ' +
          'advisor pipeline so Repo Intelligence / App Profile / DOM Memory can attempt a ' +
          'grounded selector; nothing is changed unless an advisor produces a candidate that ' +
          'Validation confirms.',
      );
  }
}

/** Rationale text for each terminal hard-stop category. */
function hardStopRationale(category: FailureCategory): string {
  switch (category) {
    case 'assertion':
      return 'Assertion failure — element found but value/state did not match. This is a product/data finding, not a locator issue.';
    case 'navigation':
      return 'Navigation/network failure — environment/infra issue, out of scope for locator healing.';
    case 'api':
      return 'API/network failure — inspect request/response and backend; out of scope for locator healing.';
    case 'environment':
      return 'Environment/config failure — fix configuration; out of scope for locator healing.';
    default:
      return 'Out of scope for locator healing — reporting for human review.';
  }
}
