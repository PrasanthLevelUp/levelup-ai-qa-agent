/**
 * Healing Acceptance Engine
 * 
 * Centralized decision authority for ALL healing candidates.
 * Every engine (rule, pattern, AI) MUST go through acceptCandidate().
 * 
 * Decision flow:
 *   1. Static validation (syntax, safety)
 *   2. Live validation (Playwright rerun)
 *   3. Confidence scoring
 *   4. Accept / Reject / PR-fallback
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import type { FailureDetails } from './failure-analyzer';
import type { HealingSuggestion } from './healing-orchestrator';

const MOD = 'healing-acceptance';

/** Selector stability scoring — prefers durable selectors */
const SELECTOR_QUALITY_SCORES: Record<string, number> = {
  'data-testid': 95,
  'role':        90,
  'label':       85,
  'placeholder': 75,
  'text':        70,
  'css':         60,
  'xpath':       40,
  'unknown':     30,
};

export type AcceptanceDecision = 'accept' | 'reject' | 'pr_fallback';

export interface AcceptanceResult {
  decision: AcceptanceDecision;
  reason: string;
  selectorQuality: number;
  adjustedConfidence: number;
  staticValid: boolean;
  liveValid: boolean;
}

export interface LiveValidationInput {
  exitCode: number;
  newFailedLocator: string | null;
  appliedLocator: string;
  originalLocator: string;
  sameTestArtifactCount: number;
}

/**
 * Detect the selector type from a locator string.
 */
function detectSelectorType(locator: string): string {
  if (/data-testid|testid/i.test(locator)) return 'data-testid';
  if (/getByRole/i.test(locator)) return 'role';
  if (/getByLabel/i.test(locator)) return 'label';
  if (/getByPlaceholder/i.test(locator)) return 'placeholder';
  if (/getByText/i.test(locator)) return 'text';
  if (/^\/\//.test(locator) || /xpath/i.test(locator)) return 'xpath';
  if (/^\.|^#|^\[|^[a-z]+[\[.#\s>+~]/.test(locator)) return 'css';
  return 'unknown';
}

/**
 * Static validation — checks the candidate without running Playwright.
 */
function staticValidation(
  suggestion: HealingSuggestion,
  failure: FailureDetails,
  fileContent: string,
): { valid: boolean; reason: string } {
  const loc = suggestion.newLocator;

  // 1. Must not be empty
  if (!loc || loc.trim().length === 0) {
    return { valid: false, reason: 'Empty locator' };
  }

  // 2. Must not be identical to the failed locator
  if (loc === failure.failedLocator) {
    return { valid: false, reason: 'Identical to failed locator' };
  }

  // 3. Must not contain obvious syntax errors
  if (/\bundefined\b|\bnull\b|\bNaN\b|\[object/.test(loc)) {
    return { valid: false, reason: 'Contains invalid tokens' };
  }

  // NOTE: We intentionally do NOT check fileContent.includes(failure.failedLocator) here.
  // The failedLocator extracted from Playwright errors (e.g. "input[name='user']") often
  // differs from the source file representation (e.g. "page.locator('input[name=\"user\"]')").
  // The validation layer handles the actual text replacement check.

  // 4. Must not be a trivially generic locator (only exact matches)
  const genericPatterns = [
    /^page\.getByRole\('[^']+'\s*\)$/,  // getByRole('role') without name filter — no comma means no options
    /^page\.getByText\(''\)$/,
    /^div$/,
    /^\*$/,
    /^body$/,
  ];
  if (genericPatterns.some(p => p.test(loc))) {
    return { valid: false, reason: 'Trivially generic locator' };
  }

  return { valid: true, reason: 'Static validation passed' };
}

/**
 * Live validation — interprets Playwright rerun results.
 * Determines if the fix actually worked by analyzing what failed next.
 */
function liveValidation(input: LiveValidationInput): { valid: boolean; reason: string; progressed: boolean } {
  const { exitCode, newFailedLocator, appliedLocator, originalLocator, sameTestArtifactCount } = input;

  // 1. Test passes completely
  if (exitCode === 0) {
    return { valid: true, reason: 'Test passes', progressed: true };
  }

  // 2. No more failures for this test
  if (sameTestArtifactCount === 0) {
    return { valid: true, reason: 'No failures remaining for this test', progressed: true };
  }

  // 3. Check if the failure moved to a DIFFERENT locator (our fix worked)
  if (newFailedLocator) {
    // Normalize for comparison (trim, collapse whitespace)
    const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
    const nNew = norm(newFailedLocator);
    const nOrig = norm(originalLocator);
    const nApplied = norm(appliedLocator);

    const isSame =
      nNew === nOrig ||
      nNew === nApplied ||
      // Only use substring if the shorter string is substantial (>10 chars)
      (nApplied.length > 10 && nNew.length > 10 && (nApplied.includes(nNew) || nNew.includes(nApplied)));

    if (!isSame) {
      return { valid: true, reason: 'Test progressed to next locator', progressed: true };
    }
  }

  // 4. Same locator still failing — fix did NOT work
  return { valid: false, reason: 'Same locator still failing after fix', progressed: false };
}

/**
 * Central acceptance decision — THE single source of truth.
 * All engines must call this.
 */
export function acceptCandidate(
  suggestion: HealingSuggestion,
  failure: FailureDetails,
  fileContent: string,
  liveInput?: LiveValidationInput,
): AcceptanceResult {
  // Step 1: Static validation
  const staticResult = staticValidation(suggestion, failure, fileContent);
  if (!staticResult.valid) {
    logger.info(MOD, 'Rejected (static)', { reason: staticResult.reason, locator: suggestion.newLocator });
    return {
      decision: 'reject',
      reason: staticResult.reason,
      selectorQuality: 0,
      adjustedConfidence: 0,
      staticValid: false,
      liveValid: false,
    };
  }

  // Step 2: Selector quality scoring
  const selectorType = detectSelectorType(suggestion.newLocator);
  const selectorQuality = SELECTOR_QUALITY_SCORES[selectorType] || 30;

  // Step 3: Adjusted confidence = engine confidence * selector quality weight
  const qualityWeight = selectorQuality / 100;
  const adjustedConfidence = suggestion.confidence * (0.5 + 0.5 * qualityWeight);

  // Step 4: Live validation (if available)
  let liveValid = false;
  let liveReason = 'Not yet validated live';
  if (liveInput) {
    const liveResult = liveValidation(liveInput);
    liveValid = liveResult.valid;
    liveReason = liveResult.reason;
  }

  // Step 5: Decision
  let decision: AcceptanceDecision;
  let reason: string;

  if (liveInput && !liveValid) {
    decision = 'reject';
    reason = `Live validation failed: ${liveReason}`;
  } else if (liveInput && liveValid && adjustedConfidence >= 0.60) {
    decision = 'accept';
    reason = `Accepted: ${liveReason} (confidence=${adjustedConfidence.toFixed(2)}, quality=${selectorType}:${selectorQuality})`;
  } else if (liveInput && liveValid && adjustedConfidence < 0.60) {
    decision = 'pr_fallback';
    reason = `Low confidence PR: ${liveReason} (confidence=${adjustedConfidence.toFixed(2)})`;
  } else {
    // No live validation yet — static-only pre-check
    if (adjustedConfidence >= 0.50) {
      decision = 'accept'; // Tentative — will be overridden by live validation
      reason = `Static pass, pending live validation (confidence=${adjustedConfidence.toFixed(2)})`;
    } else {
      decision = 'reject';
      reason = `Confidence too low: ${adjustedConfidence.toFixed(2)}`;
    }
  }

  logger.info(MOD, 'Acceptance decision', {
    decision, reason, locator: suggestion.newLocator,
    selectorType, selectorQuality, adjustedConfidence: +adjustedConfidence.toFixed(2),
    staticValid: true, liveValid,
  });

  return {
    decision,
    reason,
    selectorQuality,
    adjustedConfidence,
    staticValid: true,
    liveValid,
  };
}
