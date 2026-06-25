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
      suites?: any[];
      errors?: any[];
    };

    const artifacts: ArtifactCollection[] = [];

    /**
     * Recursively walk nested suites to find all specs.
     * Playwright JSON nests suites when test.describe() is used:
     *   suites[file].suites[describe].specs[test]
     * We must walk ALL levels, not just the first.
     */
    const walkSuites = (suites: any[], parentFile?: string): void => {
      for (const suite of suites) {
        const suiteFile = suite.file ?? parentFile;

        // Process specs at this level
        for (const spec of suite.specs ?? []) {
          const testName = spec.title ?? 'unknown test';

          for (const test of spec.tests ?? []) {
            for (const result of test.results ?? []) {
              if (result.status === 'passed' || result.status === 'skipped') continue;

              const errorMessage = [
                result.error?.message,
                ...(result.errors ?? []).map((e: any) => e.message || ''),
              ].filter(Boolean).join('\n\n');

              const location = result.errorLocation
                ?? result.error?.location
                ?? result.errors?.[0]?.location;

              const filePath = location?.file
                ?? path.join(testRepoPath, 'tests', spec.file ?? suiteFile ?? '');

              const lineNumber = location?.line ?? 0;

              // Use modular extractors
              const normalizedError = normalizeError(errorMessage);
              const codeContext = extractCodeContext(filePath, lineNumber);
              // Extract the failing locator from the error message first. Modern
              // Playwright errors don't always echo the locator in a parseable
              // form, so fall back to the failing source line (which always
              // contains the locator, e.g. `await page.getByRole(...).click()`).
              // Without this fallback, failed_locator ends up empty and ALL
              // healing layers (rule / pattern / validation / DOM) are starved.
              const locatorInfo =
                extractLocator(errorMessage) || extractLocator(codeContext.failedLineCode || '');

              const screenshotPath = (result.attachments ?? []).find((a: any) =>
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

        // Recurse into nested suites (test.describe blocks create nesting)
        if (suite.suites?.length > 0) {
          walkSuites(suite.suites, suiteFile);
        }
      }
    };

    walkSuites(raw.suites ?? []);

    logger.info(MOD, `Collected ${artifacts.length} failure artifact(s)`, {
      resultsFilePath,
      testRepoPath,
      totalSuites: raw.suites?.length ?? 0,
    });

    return artifacts;
  }
}

/** Strip ANSI colour codes Playwright embeds in error text. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * Extract Playwright's TOP-LEVEL errors from a results file.
 *
 * Playwright records two distinct failure shapes:
 *   - per-test failures live under `suites[].specs[].tests[].results[]`
 *   - load-time / global errors (a spec file that throws while being imported,
 *     a global-setup failure, a config error) live under the top-level
 *     `errors[]` array, and in that case `suites` is usually EMPTY.
 *
 * The artifact collector only walks `suites`, so a load-time error would
 * otherwise surface as "0 failures collected" with an empty stderr — a silent,
 * un-actionable failure. This helper lets callers detect and report them.
 */
export function extractTopLevelErrors(resultsFilePath: string): string[] {
  if (!fs.existsSync(resultsFilePath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(resultsFilePath, 'utf-8')) as {
      errors?: Array<{ message?: string } | string>;
    };
    return (raw.errors ?? [])
      .map((e) => (typeof e === 'string' ? e : e?.message ?? ''))
      .map((m) => stripAnsi(m).trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
