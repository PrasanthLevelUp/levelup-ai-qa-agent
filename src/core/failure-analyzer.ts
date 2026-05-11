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
  if (text.includes('timeout') || text.includes('timed out')) return 'timeout';
  if (text.includes('locator') || text.includes('selector') || text.includes('element') || text.includes('not found')) return 'locator';
  if (text.includes('expect(') || text.includes('assert')) return 'assertion';
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
