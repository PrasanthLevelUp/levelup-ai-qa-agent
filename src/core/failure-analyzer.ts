/**
 * Failure Analyzer
 * Converts raw failure artifacts into healing-ready failure details.
 */

import { logger } from '../utils/logger';
import type { ArtifactCollection } from './artifact-collector';

const MOD = 'failure-analyzer';

export type FailureType = 'locator' | 'timeout' | 'assertion' | 'navigation' | 'unknown';

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
}

function detectFailureType(errorMessage: string): FailureType {
  const text = errorMessage.toLowerCase();

  // IMPORTANT: Check assertion FIRST, before locator.
  // Playwright assertion errors like `expect(locator('...')).toContainText(...)` contain the word
  // "locator" but are NOT locator failures — the locator FOUND the element, the assertion failed.
  // Assertion keywords: toContainText, toHaveText, toBeVisible, toBeEnabled, toHaveValue,
  // toHaveURL, toHaveTitle, toHaveCount, toHaveAttribute, toHaveCSS, toHaveClass, toBeChecked, etc.
  const assertionPatterns = [
    /\.to(?:contain|have|be|equal|match)/i,
    /expect\(.*\)\.(?:not\.)?to/i,
    /expected.*received/i,
    /expected substring/i,
    /expected string/i,
    /assertion failed/i,
  ];
  if (assertionPatterns.some(p => p.test(errorMessage))) return 'assertion';

  if (text.includes('timeout') || text.includes('timed out')) return 'timeout';

  // "locator" in error context like "waiting for locator('...')" means element not found
  // But "expect(locator('...')).toXxx" is an assertion (caught above)
  if (/waiting for (?:locator|selector)/i.test(text) || text.includes('not found') || text.includes('no element')) return 'locator';
  if (text.includes('selector') && !text.includes('expect(')) return 'locator';

  if (text.includes('navigation') || text.includes('net::') || text.includes('http')) return 'navigation';
  return 'unknown';
}

function isTimingIssue(errorMessage: string): boolean {
  const t = errorMessage.toLowerCase();
  return t.includes('timeout') || t.includes('waiting for') || t.includes('navigation') || t.includes('not visible');
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

    logger.info(MOD, 'Failure analyzed', {
      testName: details.testName,
      failureType: details.failureType,
      failedLocator: details.failedLocator,
      isTimingIssue: details.isTimingIssue,
    });

    return details;
  }
}
