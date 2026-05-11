/**
 * Artifact Collector (Orchestrator)
 * Coordinates specialized extractors to collect failure artifacts from Playwright JSON results.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { extractLocator, type LocatorInfo } from './locator-extractor';
import { normalizeError, extractErrorPattern, type NormalizedError } from './error-normalizer';
import { extractCodeContext, type CodeContext } from './code-context-extractor';

const MOD = 'artifact-collector';

export interface ArtifactCollection {
  test_name: string;
  error_message: string;
  error_pattern: string;
  failed_locator: string | null;
  file_path: string;
  line_number: number;
  failed_line_code: string | null;
  screenshot_path: string | null;
  url: string | null;
  timestamp: string;
  test_results_json: string;
  test_results_json_path: string;
  surrounding_code: string;
  test_file_full: string;
  // Enhanced fields from modular extractors
  locator_info: LocatorInfo | null;
  normalized_error: NormalizedError | null;
  code_context: CodeContext | null;
}

function extractUrl(errorMessage: string): string | null {
  const navMatch = /navigated to \"([^\"]+)\"/.exec(errorMessage);
  if (navMatch?.[1]) return navMatch[1];
  const waitingMatch = /waiting for\"\s*(https?:\/\/[^\"\s]+)\"/.exec(errorMessage);
  if (waitingMatch?.[1]) return waitingMatch[1];
  return null;
}

export class ArtifactCollector {
  collect(resultsFilePath: string, testRepoPath: string): ArtifactCollection[] {
    if (!fs.existsSync(resultsFilePath)) {
      throw new Error(`test-results.json not found: ${resultsFilePath}`);
    }

    const rawText = fs.readFileSync(resultsFilePath, 'utf-8');
    const raw = JSON.parse(rawText) as {
      suites?: Array<{
        specs?: Array<{
          title?: string;
          file?: string;
          tests?: Array<{
            results?: Array<{
              status?: string;
              startTime?: string;
              error?: { message?: string; location?: { file?: string; line?: number } };
              errors?: Array<{ message?: string; location?: { file?: string; line?: number } }>;
              errorLocation?: { file?: string; line?: number };
              attachments?: Array<{ name?: string; contentType?: string; path?: string }>;
            }>;
          }>;
        }>;
      }>;
    };

    const artifacts: ArtifactCollection[] = [];

    for (const suite of raw.suites ?? []) {
      for (const spec of suite.specs ?? []) {
        const testName = spec.title ?? 'unknown test';

        for (const test of spec.tests ?? []) {
          for (const result of test.results ?? []) {
            if (result.status === 'passed' || result.status === 'skipped') continue;

            const errorMessage = [
              result.error?.message,
              ...(result.errors ?? []).map((e) => e.message || ''),
            ].filter(Boolean).join('\n\n');

            const location = result.errorLocation
              ?? result.error?.location
              ?? result.errors?.[0]?.location;

            const filePath = location?.file
              ?? path.join(testRepoPath, 'tests', spec.file ?? '');

            const lineNumber = location?.line ?? 0;

            // Use modular extractors
            const locatorInfo = extractLocator(errorMessage);
            const normalizedError = normalizeError(errorMessage);
            const codeContext = extractCodeContext(filePath, lineNumber);

            const screenshotPath = (result.attachments ?? []).find((a) =>
              a.name === 'screenshot' || a.contentType?.startsWith('image/')
            )?.path ?? null;

            const artifact: ArtifactCollection = {
              test_name: testName,
              error_message: errorMessage,
              error_pattern: extractErrorPattern(errorMessage),
              failed_locator: locatorInfo?.rawLocator ?? null,
              file_path: filePath,
              line_number: lineNumber,
              failed_line_code: codeContext.failedLineCode,
              screenshot_path: screenshotPath,
              url: extractUrl(errorMessage),
              timestamp: result.startTime ?? new Date().toISOString(),
              test_results_json: rawText,
              test_results_json_path: resultsFilePath,
              surrounding_code: codeContext.surroundingCode,
              test_file_full: codeContext.fullContent,
              // Enhanced fields
              locator_info: locatorInfo,
              normalized_error: normalizedError,
              code_context: codeContext,
            };

            artifacts.push(artifact);
          }
        }
      }
    }

    logger.info(MOD, `Collected ${artifacts.length} failure artifact(s)`, {
      resultsFilePath,
      testRepoPath,
    });

    return artifacts;
  }
}
