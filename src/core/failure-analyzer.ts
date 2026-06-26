/**
 * Failure Analyzer
 * Converts raw failure artifacts into healing-ready failure details.
 */

import { logger } from '../utils/logger';
import type { ArtifactCollection } from './artifact-collector';
import { classifyFailure, type FailureDiagnosis } from './failure-classifier';

const MOD = 'failure-analyzer';

export type FailureType = 'locator' | 'locator_timeout' | 'timeout' | 'assertion' | 'navigation' | 'unknown';

export interface FailureDetails {
  testName: string;
  failureType: FailureType;
  failedLocator: string;
  errorMessage: string;
  errorPattern: string;
  filePath: string;
  lineNumber: number;
  failedLineCode: string;
  surroundingCode: string;
  screenshotPath: string | null;
  url: string | null;
  timestamp: string;
  isTimingIssue: boolean;
  /**
   * Diagnosis-first structured classification of WHAT failed. Populated by the
   * Failure Classifier so downstream stages (strategy router, advisors, trail,
   * UI) reason about a real diagnosis instead of jumping to a locator swap.
   */
  diagnosis?: FailureDiagnosis;
}

/**
 * Classify failures into precise categories:
 *
 * 1. 'assertion'        — Element WAS found, but assertion failed (toContainText, toHaveURL, etc.)
 *                         Action: Add waits (timing fix), do NOT change locator.
 *
 * 2. 'locator_timeout'  — Timeout while WAITING for a specific locator/selector.
 *                         This is the most common "broken locator" symptom in Playwright.
 *                         Action: Change locator AND increase timeout/add waits.
 *
 * 3. 'locator'          — Explicit "not found" / "no element" without timeout context.
 *                         Action: Change locator AND add waits.
 *
 * 4. 'timeout'          — Generic timeout NOT tied to a specific locator (page load, navigation).
 *                         Action: Only increase waits/timeouts.
 *
 * 5. 'navigation'       — Network/navigation errors (net::ERR_*, HTTP errors).
 *                         Action: Environment issue, not healable via locators.
 */
function detectFailureType(errorMessage: string): FailureType {
  const text = errorMessage.toLowerCase();

  // STEP 1: Assertion check — but many assertion-looking errors are actually locator issues.
  //
  // Key insight: In Playwright, expect(locator).toBeVisible() with a WRONG selector
  // produces "expect(locator).toBeVisible() failed" + "timeout exceeded" but does NOT
  // say "not found". The element simply never appeared because the locator is wrong.
  //
  // We classify as assertion ONLY when:
  // - It matches assertion patterns AND
  // - The element was NOT "not found" AND
  // - It's NOT toBeVisible/toBeHidden with a timeout (those are locator issues)
  const isElementNotFound = text.includes('not found') || text.includes('no element');
  const isTimeout = text.includes('timeout') || text.includes('timed out');
  const isVisibilityCheck = /\.to(?:be)(?:visible|hidden)/i.test(errorMessage);
  const hasLocatorRef = /locator\(['"][^'"]+['"]\)/i.test(text) || /waiting for/i.test(text);

  const assertionPatterns = [
    /\.to(?:contain|have|be|equal|match)(?:text|url|title|value|count|attribute|css|class|checked|enabled|visible|hidden|empty|focused)/i,
    /expect\(.*\)\.(?:not\.)?to(?:contain|have|be)/i,
    /expected substring/i,
    /expected string/i,
    /expected.*received/i,
    /assertion failed/i,
  ];

  if (assertionPatterns.some(p => p.test(errorMessage))) {
    // These are real assertion failures (element found but wrong content):
    // - toContainText, toHaveURL, toHaveValue, etc. WITHOUT timeout → true assertion
    // These are locator issues disguised as assertions:
    // - toBeVisible + timeout → element never found because locator is wrong
    // - toBeVisible + "not found" → element not in DOM
    // - Any assertion + "not found" → locator wrong
    if (isElementNotFound) {
      // Element explicitly not found — it's a locator issue
    } else if (isVisibilityCheck && isTimeout && hasLocatorRef) {
      // toBeVisible/toBeHidden timed out waiting for a locator — locator is wrong
    } else {
      return 'assertion';
    }
  }

  // STEP 2: Locator-timeout — timeout while waiting for a SPECIFIC locator.
  // This is the #1 symptom of a broken locator in Playwright.
  // Pattern: "Timeout Xms exceeded." + "waiting for locator('...')" or "locator('...')"
  // (isTimeout already computed in Step 1)
  const hasLocatorContext = /waiting for (?:locator|selector)/i.test(text)
    || /locator\(['"][^'"]+['"]\)/i.test(text)
    || /page\.(?:click|fill|waitForSelector|locator)\(/i.test(text);

  if (isTimeout && hasLocatorContext) return 'locator_timeout';

  // STEP 3: Pure locator failure (no timeout wrapper).
  if (/waiting for (?:locator|selector)/i.test(text)
    || text.includes('not found')
    || text.includes('no element')
    || (text.includes('selector') && !text.includes('expect('))) {
    return 'locator';
  }

  // STEP 4: Pure timeout (page load, navigation, generic).
  if (isTimeout) return 'timeout';

  // STEP 5: Navigation errors.
  if (text.includes('navigation') || text.includes('net::') || /err_[a-z]+/i.test(text)) return 'navigation';

  return 'unknown';
}

function isTimingIssue(errorMessage: string): boolean {
  const t = errorMessage.toLowerCase();
  return t.includes('timeout') || t.includes('timed out') || t.includes('waiting for') || t.includes('navigation') || t.includes('not visible');
}

export class FailureAnalyzer {
  analyze(artifact: ArtifactCollection): FailureDetails {
    const failureType = detectFailureType(artifact.error_message);

    const details: FailureDetails = {
      testName: artifact.test_name,
      failureType,
      failedLocator: artifact.failed_locator ?? '',
      errorMessage: artifact.error_message,
      errorPattern: artifact.error_pattern,
      filePath: artifact.file_path,
      lineNumber: artifact.line_number,
      failedLineCode: artifact.failed_line_code ?? '',
      surroundingCode: artifact.surrounding_code,
      screenshotPath: artifact.screenshot_path,
      url: artifact.url,
      timestamp: artifact.timestamp,
      isTimingIssue: isTimingIssue(artifact.error_message),
    };

    // Diagnosis-first: classify WHAT failed before anything downstream decides
    // HOW (or whether) to heal. Pass any Page-Object locator resolution so a
    // field-reference failure is diagnosed against its real selector.
    const po = artifact.page_object_resolution;
    details.diagnosis = classifyFailure({
      failure: details,
      pageObject: po
        ? {
            resolvedLocator: po.resolvedLocator,
            fieldName: po.fieldName,
            action: po.action,
            builder: po.builder,
          }
        : null,
    });

    // If the inline locator was empty but we resolved one from the Page Object,
    // surface it as the failed locator so grounded healing layers aren't starved.
    if (!details.failedLocator && details.diagnosis.locator) {
      details.failedLocator = details.diagnosis.locator;
    }

    logger.info(MOD, 'Failure analyzed', {
      testName: details.testName,
      failureType: details.failureType,
      failedLocator: details.failedLocator,
      isTimingIssue: details.isTimingIssue,
      diagnosisCategory: details.diagnosis.category,
      diagnosisConfidence: details.diagnosis.confidence,
      healableByLocatorSwap: details.diagnosis.healableByLocatorSwap,
    });

    return details;
  }
}
