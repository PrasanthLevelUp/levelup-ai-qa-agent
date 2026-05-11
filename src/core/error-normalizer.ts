/**
 * Error Normalizer — standardizes error messages and categorizes error types.
 */

import { logger } from '../utils/logger';

const MOD = 'error-normalizer';

export type ErrorCategory =
  | 'LOCATOR_NOT_FOUND'
  | 'TIMEOUT'
  | 'ASSERTION_FAILED'
  | 'NAVIGATION_ERROR'
  | 'ELEMENT_NOT_VISIBLE'
  | 'ELEMENT_NOT_INTERACTABLE'
  | 'FRAME_DETACHED'
  | 'NETWORK_ERROR'
  | 'UNKNOWN';

export interface NormalizedError {
  category: ErrorCategory;
  originalMessage: string;
  normalizedMessage: string;
  actionableInfo: string;
  isRetryable: boolean;
  isTimingRelated: boolean;
}

const CATEGORY_PATTERNS: Array<{ pattern: RegExp; category: ErrorCategory }> = [
  { pattern: /locator.*resolved to \d+ element|no element.*found|waiting for locator/i, category: 'LOCATOR_NOT_FOUND' },
  { pattern: /timeout|timed out|exceeded.*ms/i, category: 'TIMEOUT' },
  { pattern: /expect\(.*\)\.to|assert|expected.*to.*be/i, category: 'ASSERTION_FAILED' },
  { pattern: /navigation.*failed|net::|ERR_/i, category: 'NAVIGATION_ERROR' },
  { pattern: /not visible|hidden|display:\s*none/i, category: 'ELEMENT_NOT_VISIBLE' },
  { pattern: /not interactable|disabled|readonly/i, category: 'ELEMENT_NOT_INTERACTABLE' },
  { pattern: /frame.*detached|frame.*navigated/i, category: 'FRAME_DETACHED' },
  { pattern: /fetch|network|ECONNREFUSED|ENOTFOUND/i, category: 'NETWORK_ERROR' },
];

const ACTIONABLE_INFO: Record<ErrorCategory, string> = {
  LOCATOR_NOT_FOUND: 'Replace with semantic locator (getByRole, getByLabel, etc.)',
  TIMEOUT: 'Add explicit wait or increase timeout',
  ASSERTION_FAILED: 'Check expected value or update assertion',
  NAVIGATION_ERROR: 'Verify URL accessibility and network conditions',
  ELEMENT_NOT_VISIBLE: 'Add waitForSelector with state: "visible"',
  ELEMENT_NOT_INTERACTABLE: 'Wait for element to be enabled or use force option',
  FRAME_DETACHED: 'Re-locate frame reference after navigation',
  NETWORK_ERROR: 'Check network connectivity and API endpoints',
  UNKNOWN: 'Manual inspection required',
};

export function normalizeError(errorMessage: string): NormalizedError {
  // Strip ANSI codes
  const cleaned = errorMessage
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  let category: ErrorCategory = 'UNKNOWN';
  for (const { pattern, category: cat } of CATEGORY_PATTERNS) {
    if (pattern.test(cleaned)) {
      category = cat;
      break;
    }
  }

  const normalizedMessage = cleaned
    .replace(/\d+ms/g, 'Xms')
    .replace(/https?:\/\/\S+/g, '<url>')
    .slice(0, 500);

  const isTimingRelated = ['TIMEOUT', 'ELEMENT_NOT_VISIBLE', 'NAVIGATION_ERROR'].includes(category);
  const isRetryable = ['TIMEOUT', 'NETWORK_ERROR', 'ELEMENT_NOT_VISIBLE'].includes(category);

  const result: NormalizedError = {
    category,
    originalMessage: errorMessage.slice(0, 1000),
    normalizedMessage,
    actionableInfo: ACTIONABLE_INFO[category],
    isRetryable,
    isTimingRelated,
  };

  logger.debug(MOD, 'Error normalized', {
    category: result.category,
    isTimingRelated: result.isTimingRelated,
  });

  return result;
}

/**
 * Extract a pattern suitable for database matching.
 */
export function extractErrorPattern(errorMessage: string): string {
  return errorMessage
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\d+ms/g, 'Xms')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\s+/g, ' ')
    .slice(0, 240)
    .trim();
}
