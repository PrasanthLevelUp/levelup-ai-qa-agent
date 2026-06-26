/**
 * Failure Classifier (Diagnosis-first)
 * ------------------------------------
 * Core principle of this stage:
 *
 *   "LevelUp AI should never ask 'How do I fix this?' until it has confidently
 *    answered 'What actually failed?'"
 *
 * The historical pipeline jumped straight to a *prescription* (swap the locator)
 * before producing a *diagnosis*. That is what made the engine report a perfectly
 * valid `#login-button` as a "broken locator failure": the only tool it reached
 * for was locator-swapping, so every failure looked like a locator problem.
 *
 * This module is a pure, deterministic, browser-free **diagnostician**. It takes
 * the analyzed failure (and any Page-Object locator resolution) and produces a
 * structured `FailureDiagnosis` describing WHAT failed, with what evidence and
 * confidence — explicitly separating that from the downstream decision of HOW
 * (or whether) to heal, which the `healing-strategy-router` owns.
 *
 * It deliberately reuses the existing `FailureType` taxonomy from the analyzer
 * (so nothing downstream breaks) but enriches it into the richer diagnosis shape
 * described in the Healing Classifier spec.
 */

import type { FailureDetails, FailureType } from './failure-analyzer';
import type { EvidenceBundle } from './evidence-collector';

/**
 * Diagnostic failure categories from the Healing Classifier spec. These map onto
 * the existing `FailureType` values but are the vocabulary the diagnosis speaks.
 */
export type FailureCategory =
  | 'locator'
  | 'timing'
  | 'assertion'
  | 'navigation'
  | 'api'
  | 'environment'
  | 'framework'
  | 'unknown';

/**
 * The concrete remedy the diagnosis recommends. This is the single field that
 * downstream RCA, the Learning Engine, the dashboard and analytics all key off.
 */
export type RecommendedStrategy =
  | 'locator_swap'
  | 'wait_for_overlay'
  | 'wait_for_visible'
  | 'wait_for_enabled'
  | 'inject_wait'
  | 'report_only'
  | 'none';

export interface DiagnosisEvidence {
  /** Short machine label, e.g. `failed_line`, `resolved_locator`, `error_signal`. */
  kind: string;
  /** Human-readable evidence detail. */
  detail: string;
}

export interface FailureDiagnosis {
  /** WHAT failed — the diagnostic category. */
  category: FailureCategory;
  /** 0..1 confidence in the category determination. */
  confidence: number;
  /** The concrete locator involved, when one could be determined/resolved. */
  locator: string | null;
  /** True when the locator was recovered via Page Object resolution (not inline). */
  locatorResolvedFromPageObject: boolean;
  /** Source file where the failure occurred. */
  file: string | null;
  /** 1-based line number of the failing statement. */
  line: number | null;
  /** The action being performed (click/fill/goto/...) when known. */
  action: string | null;
  /** For timing failures: what the test was waiting for. */
  waitingFor: string | null;
  /** For assertion failures: the expected value. */
  expected: string | null;
  /** For assertion failures: the actual/received value. */
  actual: string | null;
  /** Plain-language root cause statement. */
  rootCause: string;
  /** Plain-language recommended action (diagnosis-level, not a patch). */
  recommendedAction: string;
  /** Machine-readable strategy that downstream RCA/learning/dashboard key off. */
  recommendedStrategy: RecommendedStrategy;
  /** True once the diagnosis was corroborated by observed evidence (not just regex). */
  evidenceBased: boolean;
  /**
   * Whether this failure is even a candidate for locator-swap healing. This is
   * the single most important field for fixing the false-positive bug: a valid
   * locator whose element simply isn't there for a functional reason, or an
   * `unknown` failure with no locator, must NOT be "healed" by guessing a new
   * selector.
   */
  healableByLocatorSwap: boolean;
  /** Ordered evidence the diagnosis was built from (for the Evidence panel UI). */
  evidence: DiagnosisEvidence[];
}

export interface ClassifierInput {
  failure: FailureDetails;
  /** Optional Page-Object resolution recovered for the failing line. */
  pageObject?: {
    resolvedLocator: string;
    fieldName: string;
    action: string | null;
    builder: string;
  } | null;
}

/** Map the analyzer's FailureType onto the diagnostic category vocabulary. */
function baseCategoryFromFailureType(ft: FailureType): FailureCategory {
  switch (ft) {
    case 'locator':
    case 'locator_timeout':
      return 'locator';
    case 'assertion':
      return 'assertion';
    case 'navigation':
      return 'navigation';
    case 'timeout':
      return 'timing';
    case 'unknown':
    default:
      return 'unknown';
  }
}

/** Detect API/network-layer failures (request/response, status codes). */
function looksLikeApiFailure(msg: string): boolean {
  const t = msg.toLowerCase();
  return (
    /\brequest\b.*\bfailed\b/.test(t) ||
    /\bresponse\b.*\b(status|code)\b/.test(t) ||
    /\bhttp\b.*\b(4\d\d|5\d\d)\b/.test(t) ||
    /\bapi(?:request|response)context\b/.test(t) ||
    /\b(econnrefused|enotfound|etimedout|socket hang up)\b/.test(t)
  );
}

/** Detect environment/config failures (missing env, auth, permissions). */
function looksLikeEnvironmentFailure(msg: string): boolean {
  const t = msg.toLowerCase();
  return (
    /\b(environment variable|env var|process\.env)\b/.test(t) ||
    /\b(missing|undefined).*\b(config|credential|token|secret|api key)\b/.test(t) ||
    /\b(permission denied|unauthorized|forbidden|401|403)\b/.test(t)
  );
}

/** Detect Playwright/framework-level failures (not the app under test). */
function looksLikeFrameworkFailure(msg: string): boolean {
  const t = msg.toLowerCase();
  return (
    /\bbrowsertype\.launch\b/.test(t) ||
    /\bexecutable doesn'?t exist\b/.test(t) ||
    /\bplaywright.*\b(install|version)\b/.test(t) ||
    /\btarget (page|frame|context).*\b(closed|crashed)\b/.test(t) ||
    /\bprotocol error\b/.test(t)
  );
}

/** Pull "waiting for X" target out of a Playwright timeout message. */
function extractWaitingFor(msg: string): string | null {
  const m =
    /waiting for\s+(?:locator\s+)?(['"][^'"]+['"]|[^\n]+?)(?:\s+to\b|\n|$)/i.exec(msg);
  return m ? m[1].trim() : null;
}

/** Pull expected/received values out of an assertion message. */
function extractExpectedActual(msg: string): { expected: string | null; actual: string | null } {
  const expected =
    /(?:expected(?: string| substring| pattern| value)?:?)\s*(.+)/i.exec(msg)?.[1]?.split('\n')[0]?.trim() ??
    null;
  const actual =
    /(?:received|actual):?\s*(.+)/i.exec(msg)?.[1]?.split('\n')[0]?.trim() ?? null;
  return { expected, actual };
}

/**
 * Produce a structured diagnosis for a failure. Pure & deterministic.
 */
export function classifyFailure(input: ClassifierInput): FailureDiagnosis {
  const { failure, pageObject } = input;
  const msg = failure.errorMessage || '';
  const evidence: DiagnosisEvidence[] = [];

  // ---- Resolve the locator (inline first, then Page Object) --------------
  let locator: string | null = failure.failedLocator?.trim() || null;
  let locatorResolvedFromPageObject = false;
  let action: string | null = null;

  if (!locator && pageObject?.resolvedLocator) {
    locator = pageObject.resolvedLocator;
    locatorResolvedFromPageObject = true;
    action = pageObject.action ?? null;
    evidence.push({
      kind: 'resolved_locator',
      detail: `Page Object field "${pageObject.fieldName}" resolves to ${pageObject.builder}(${JSON.stringify(
        pageObject.resolvedLocator,
      )}).`,
    });
  } else if (locator) {
    evidence.push({ kind: 'failed_locator', detail: `Failed locator: ${locator}` });
  }

  if (failure.failedLineCode) {
    evidence.push({ kind: 'failed_line', detail: failure.failedLineCode.trim() });
  }
  if (msg) {
    evidence.push({ kind: 'error_signal', detail: msg.split('\n')[0].slice(0, 240) });
  }

  // ---- Determine the diagnostic category --------------------------------
  // Start from the analyzer's taxonomy, then refine using richer signals.
  let category = baseCategoryFromFailureType(failure.failureType);
  let confidence = 0.6;
  let waitingFor: string | null = null;
  let expected: string | null = null;
  let actual: string | null = null;

  // Higher-priority specialized categories override only when the base type is
  // ambiguous (unknown/timing/navigation), never when we already have a clear
  // assertion/locator signal.
  const refinable = category === 'unknown' || category === 'timing' || category === 'navigation';

  if (refinable && looksLikeFrameworkFailure(msg)) {
    category = 'framework';
    confidence = 0.8;
  } else if (refinable && looksLikeApiFailure(msg)) {
    category = 'api';
    confidence = 0.75;
  } else if (refinable && looksLikeEnvironmentFailure(msg)) {
    category = 'environment';
    confidence = 0.72;
  }

  // Category-specific enrichment + confidence shaping.
  switch (category) {
    case 'locator': {
      waitingFor = extractWaitingFor(msg);
      // Confidence is higher when we actually have a locator to talk about.
      confidence = locator ? (failure.failureType === 'locator_timeout' ? 0.82 : 0.85) : 0.5;
      if (waitingFor) {
        evidence.push({ kind: 'waiting_for', detail: `Waiting for ${waitingFor}` });
      }
      break;
    }
    case 'timing': {
      waitingFor = extractWaitingFor(msg);
      confidence = 0.7;
      if (waitingFor) {
        evidence.push({ kind: 'waiting_for', detail: `Waiting for ${waitingFor}` });
      }
      break;
    }
    case 'assertion': {
      const ea = extractExpectedActual(msg);
      expected = ea.expected;
      actual = ea.actual;
      confidence = 0.85;
      if (expected || actual) {
        evidence.push({
          kind: 'assertion_values',
          detail: `expected=${expected ?? '?'} actual=${actual ?? '?'}`,
        });
      }
      break;
    }
    case 'navigation':
      confidence = 0.8;
      break;
    case 'unknown':
      confidence = 0.4;
      break;
  }

  // ---- Decide healability (diagnosis-level guard, NOT a remedy) ----------
  // The crucial correctness rule: a failure is only a locator-swap candidate
  // when the diagnosis is actually a *locator* problem. Assertion, navigation,
  // api, environment, framework and unknown failures are NOT — even though the
  // old engine would have tried to swap a selector for all of them.
  const healableByLocatorSwap = category === 'locator' && !!locator;

  const { rootCause, recommendedAction } = describe(
    category,
    locator,
    locatorResolvedFromPageObject,
    waitingFor,
    expected,
    actual,
  );

  return {
    category,
    confidence,
    locator,
    locatorResolvedFromPageObject,
    file: failure.filePath || null,
    line: failure.lineNumber || null,
    action: action ?? deriveActionFromLine(failure.failedLineCode),
    waitingFor,
    expected,
    actual,
    rootCause,
    recommendedAction,
    recommendedStrategy: strategyForCategory(category, healableByLocatorSwap),
    evidenceBased: false,
    healableByLocatorSwap,
    evidence,
  };
}

/** Default recommended strategy from category alone (parser-based first pass). */
function strategyForCategory(
  category: FailureCategory,
  healableByLocatorSwap: boolean,
): RecommendedStrategy {
  switch (category) {
    case 'locator':
      return healableByLocatorSwap ? 'locator_swap' : 'report_only';
    case 'timing':
      return 'inject_wait';
    default:
      return 'report_only';
  }
}

/**
 * Upgrade a parser-based diagnosis with OBSERVED evidence. This is what makes
 * the diagnosis evidence-based rather than inference-based. The canonical case:
 *
 *   exists ✔ visible ✔ enabled ✔ clickable ✖ (overlay)
 *     → category = timing, rootCause "overlay intercepts click",
 *       recommendedStrategy = wait_for_overlay, confidence ↑
 *
 * Pure & deterministic. Returns a NEW diagnosis (does not mutate the input).
 */
export function refineDiagnosisWithEvidence(
  diagnosis: FailureDiagnosis,
  evidence: EvidenceBundle,
): FailureDiagnosis {
  const next: FailureDiagnosis = {
    ...diagnosis,
    evidence: [...diagnosis.evidence],
  };
  const ls = evidence.locatorState;

  // Fold observed evidence summaries into the evidence list for the UI.
  for (const line of evidence.summary) {
    next.evidence.push({ kind: 'observed', detail: line });
  }

  // ── Network/console signals can re-categorise an ambiguous diagnosis ──
  if (evidence.networkErrors.length > 0 && (next.category === 'unknown' || next.category === 'navigation' || next.category === 'timing')) {
    next.category = 'api';
    next.recommendedStrategy = 'report_only';
    next.healableByLocatorSwap = false;
    next.evidenceBased = true;
    next.confidence = Math.max(next.confidence, 0.8);
    next.rootCause = `API/network failure observed (${evidence.networkErrors
      .map((n) => n.detail)
      .join(', ')}).`;
    next.recommendedAction = 'Inspect the failing request/response and backend availability. Out of scope for locator healing.';
    return next;
  }

  // ── Locator-state facts are the strongest evidence we have ──
  if (ls && ls.source !== 'unknown') {
    next.evidenceBased = true;

    if (!ls.exists) {
      // The element genuinely isn't in the DOM → a real locator problem.
      next.category = 'locator';
      next.healableByLocatorSwap = !!next.locator;
      next.recommendedStrategy = next.locator ? 'locator_swap' : 'report_only';
      next.confidence = Math.max(next.confidence, 0.9);
      next.rootCause = next.locator
        ? `Observed: no element matching ${next.locator} exists in the DOM — the locator is genuinely broken/changed.`
        : 'Observed: the target element does not exist in the DOM, and no concrete locator could be resolved.';
      next.recommendedAction = next.locator
        ? 'Propose a grounded replacement locator from the DOM evidence and validate by rerun.'
        : 'Resolve the element from the DOM/Page Object before attempting any locator change.';
      return next;
    }

    // Element EXISTS — so it is NOT a broken locator, regardless of what the
    // error string looked like. Now explain WHY the interaction failed.
    if (ls.exists && ls.visible && ls.enabled && ls.receivesPointerEvents === false) {
      next.category = 'timing';
      next.healableByLocatorSwap = false;
      next.recommendedStrategy = 'wait_for_overlay';
      next.confidence = 0.95;
      next.rootCause = `Element exists, is visible and enabled, but does not receive pointer events${
        ls.interceptedBy ? ` — intercepted by ${ls.interceptedBy}` : ''
      }. The locator is correct; the click is being blocked.`;
      next.recommendedAction = 'Wait for the intercepting overlay/loader to disappear, then retry the click. Do NOT change the locator.';
      return next;
    }

    if (ls.exists && !ls.visible) {
      next.category = 'timing';
      next.healableByLocatorSwap = false;
      next.recommendedStrategy = 'wait_for_visible';
      next.confidence = 0.9;
      next.rootCause = 'Element exists in the DOM but is not yet visible — likely a rendering/timing race. The locator is correct.';
      next.recommendedAction = 'Wait for the element to become visible (expect(...).toBeVisible) before interacting. Do NOT change the locator.';
      return next;
    }

    if (ls.exists && ls.visible && !ls.enabled) {
      next.category = 'timing';
      next.healableByLocatorSwap = false;
      next.recommendedStrategy = 'wait_for_enabled';
      next.confidence = 0.88;
      next.rootCause = 'Element exists and is visible but is disabled — the app has not enabled it yet. The locator is correct.';
      next.recommendedAction = 'Wait for the element to become enabled before interacting. Do NOT change the locator.';
      return next;
    }

    // Element exists and is fully interactable, yet the test still failed → the
    // problem is functional/data (assertion), not a locator.
    if (ls.exists && ls.clickable && next.category === 'locator') {
      next.category = 'assertion';
      next.healableByLocatorSwap = false;
      next.recommendedStrategy = 'report_only';
      next.confidence = Math.max(next.confidence, 0.8);
      next.rootCause = 'Observed: the element exists and is fully interactable, so this is not a broken locator — the failure is functional/assertion-level.';
      next.recommendedAction = 'Report as a functional finding for human review. Do NOT swap the locator.';
      return next;
    }
  }

  return next;
}

/** Best-effort action extraction from the failing source line. */
function deriveActionFromLine(line: string | undefined): string | null {
  if (!line) return null;
  const m = /\.\s*(click|fill|type|press|check|uncheck|selectOption|hover|goto|waitFor|isVisible|textContent)\s*\(/.exec(
    line,
  );
  return m ? m[1] : null;
}

/** Compose human-readable root cause + recommended action per category. */
function describe(
  category: FailureCategory,
  locator: string | null,
  resolvedFromPO: boolean,
  waitingFor: string | null,
  expected: string | null,
  actual: string | null,
): { rootCause: string; recommendedAction: string } {
  switch (category) {
    case 'locator':
      return {
        rootCause: locator
          ? `Element for locator ${locator} was not found in the DOM${
              resolvedFromPO ? ' (locator resolved from the Page Object field).' : '.'
            }`
          : 'A locator-related failure occurred but no concrete locator could be resolved.',
        recommendedAction: locator
          ? 'Verify the element exists/visible in the captured DOM; if the selector drifted, propose a grounded replacement and validate by rerun.'
          : 'Resolve the failing element from the Page Object / DOM before attempting any locator change.',
      };
    case 'timing':
      return {
        rootCause: waitingFor
          ? `Test timed out waiting for ${waitingFor}; the element/state likely appears after the current wait window.`
          : 'A generic timeout occurred that is not tied to a specific locator.',
        recommendedAction:
          'Inject/raise an explicit wait (e.g. waitForLoadState / expect(...).toBeVisible timeout) and rerun; do NOT change the locator.',
      };
    case 'assertion':
      return {
        rootCause: `Element was found but the assertion did not match (expected ${
          expected ?? '?'
        }, actual ${actual ?? '?'}). This indicates a product/data behaviour, not a broken locator.`,
        recommendedAction:
          'Report as a functional finding for human review. Do NOT swap the locator or auto-heal.',
      };
    case 'navigation':
      return {
        rootCause: 'Navigation/network error — the page or site failed to load.',
        recommendedAction:
          'Treat as an environment/infra issue; retry or check connectivity. Out of scope for locator healing.',
      };
    case 'api':
      return {
        rootCause: 'An API/network request failed (bad status, refused connection, or timeout).',
        recommendedAction:
          'Inspect the request/response and backend availability. Out of scope for locator healing.',
      };
    case 'environment':
      return {
        rootCause: 'A configuration/environment problem (missing env var, credential, or permission).',
        recommendedAction:
          'Fix the environment/config. Out of scope for locator healing.',
      };
    case 'framework':
      return {
        rootCause: 'A Playwright/framework-level error (browser launch, target closed/crashed, protocol error).',
        recommendedAction:
          'Check the test runner/browser setup. Out of scope for locator healing.',
      };
    case 'unknown':
    default:
      return {
        rootCause: 'The failure could not be confidently classified from the available evidence.',
        recommendedAction:
          'Collect more evidence (DOM, trace, logs) before prescribing any fix. Do NOT guess a locator.',
      };
  }
}
