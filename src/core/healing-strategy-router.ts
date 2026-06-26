/**
 * Healing Strategy Router (Diagnosis → Strategy)
 * ----------------------------------------------
 * This is the explicit stage that sits between the diagnosis ("WHAT failed") and
 * the healing advisors ("HOW to fix"). It consumes a `FailureDiagnosis` and
 * decides which remedy pipeline — if any — should run.
 *
 * Crucially, it is the gate that fixes the false "broken locator" behaviour:
 * only a diagnosis that is genuinely a *locator* problem is routed to
 * locator-swap healing. Timing failures are routed to wait-injection. Everything
 * else (assertion, navigation, api, environment, framework, unknown) is routed to
 * `report_only` — the engine reports an honest finding instead of guessing a new
 * selector.
 *
 * Pure & deterministic; no side effects.
 */

import type { FailureDiagnosis, FailureCategory } from './failure-classifier';

export type HealingRemedy = 'locator_swap' | 'inject_wait' | 'report_only';

export interface HealingStrategyPlan {
  /** Whether the locator-swap healing loop (advisors + browser rerun) should run. */
  shouldAttemptLocatorHealing: boolean;
  /** The remedy class chosen for this failure. */
  remedy: HealingRemedy;
  /** The diagnostic category this plan was derived from. */
  category: FailureCategory;
  /** Plain-language rationale for the routing decision (surfaced in the trail). */
  rationale: string;
  /**
   * When true, the failure is a legitimate finding to surface to humans rather
   * than something the engine should attempt to auto-fix.
   */
  reportOnly: boolean;
}

/**
 * Minimum diagnosis confidence required before we will route to an *active*
 * remedy (locator_swap / inject_wait). Below this we degrade to report_only so
 * the engine never acts on a shaky diagnosis. Env-overridable.
 */
function minActionConfidence(): number {
  const v = Number(process.env.HEALING_ROUTER_MIN_CONFIDENCE);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : 0.5;
}

export function routeHealingStrategy(diagnosis: FailureDiagnosis): HealingStrategyPlan {
  const { category, confidence } = diagnosis;

  const reportOnlyPlan = (rationale: string): HealingStrategyPlan => ({
    shouldAttemptLocatorHealing: false,
    remedy: 'report_only',
    category,
    rationale,
    reportOnly: true,
  });

  // Guard 1: never act on a low-confidence diagnosis.
  if (confidence < minActionConfidence() && category !== 'locator') {
    return reportOnlyPlan(
      `Diagnosis confidence ${confidence.toFixed(
        2,
      )} below action threshold — reporting for human review instead of auto-healing.`,
    );
  }

  switch (category) {
    case 'locator':
      // Guard 2: only swap a locator when we actually diagnosed a locator
      // problem AND have a concrete locator to work from. This is the core fix
      // for the false-positive: no locator ⇒ no swap.
      if (diagnosis.healableByLocatorSwap && diagnosis.locator) {
        return {
          shouldAttemptLocatorHealing: true,
          remedy: 'locator_swap',
          category,
          rationale: diagnosis.locatorResolvedFromPageObject
            ? `Locator ${diagnosis.locator} (resolved from the Page Object) was not found — route to grounded locator healing.`
            : `Locator ${diagnosis.locator} was not found — route to grounded locator healing.`,
          reportOnly: false,
        };
      }
      return reportOnlyPlan(
        'Locator-type failure but no concrete locator could be resolved — cannot safely swap a selector. Reporting instead of guessing.',
      );

    case 'timing':
      return {
        shouldAttemptLocatorHealing: false,
        remedy: 'inject_wait',
        category,
        rationale:
          'Timing failure — inject/raise an explicit wait and rerun; the locator is not changed.',
        reportOnly: false,
      };

    case 'assertion':
      return reportOnlyPlan(
        'Assertion failure — element found but value/state did not match. This is a product/data finding, not a locator issue.',
      );

    case 'navigation':
      return reportOnlyPlan(
        'Navigation/network failure — environment/infra issue, out of scope for locator healing.',
      );

    case 'api':
      return reportOnlyPlan(
        'API/network failure — inspect request/response and backend; out of scope for locator healing.',
      );

    case 'environment':
      return reportOnlyPlan(
        'Environment/config failure — fix configuration; out of scope for locator healing.',
      );

    case 'framework':
      return reportOnlyPlan(
        'Framework/runner failure — check Playwright/browser setup; out of scope for locator healing.',
      );

    case 'unknown':
    default:
      return reportOnlyPlan(
        'Unclassified failure — insufficient evidence to prescribe a fix. Reporting for human review instead of guessing a locator.',
      );
  }
}
