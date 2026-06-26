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
import * as TraceParser from './playwright/trace-parser';

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

              // Parse the full error stack to find the ACTUAL source file where the
              // broken code lives. When a Page Object method fails (e.g. LoginPage.login()),
              // Playwright's top-of-stack location points to the TEST FILE that CALLED
              // the method, not the PO file where the broken locator is. Healing then
              // searches the test spec for the locator string, finds nothing, and rejects
              // every fix with "Original locator not found in file."
              //
              // Solution: walk the stack frames and prefer files in known PO directories
              // (pages/, page-objects/, pom/, src/pages/) over test specs. If no PO is
              // found, fall back to the top frame (original behavior for inline tests).
              const stack = result.error?.stack ?? result.errors?.[0]?.stack;
              const resolvedLocation = this.findActualSourceLocation(stack, location, testRepoPath);

              const filePath = resolvedLocation.file
                ?? path.join(testRepoPath, 'tests', spec.file ?? suiteFile ?? '');

              const lineNumber = resolvedLocation.line ?? 0;

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

              // Resolve the REAL page URL from this result's trace.zip via the
              // TraceParser (Playwright records the rendered frame URL natively in
              // frame-snapshot events). No fixture injection or config edits needed.
              // Falls back to legacy regex extraction if no trace/URL is found.
              const tracePath = (result.attachments ?? []).find((a: any) =>
                a.name === 'trace' || (typeof a.path === 'string' && a.path.endsWith('trace.zip'))
              )?.path ?? null;
              const executionContext = tracePath ? TraceParser.parse(tracePath) : null;
              const finalUrl = executionContext?.pageUrl ?? extractUrl(errorMessage);

              const artifact: ArtifactCollection = {
                test_name: testName,
                error_message: errorMessage,
                error_pattern: extractErrorPattern(errorMessage),
                failed_locator: locatorInfo?.rawLocator ?? null,
                file_path: filePath,
                line_number: lineNumber,
                failed_line_code: codeContext.failedLineCode,
                screenshot_path: screenshotPath,
                url: finalUrl,
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

  /**
   * Parse a Playwright error stack to find the ACTUAL source file where the broken
   * code lives. When a Page Object method fails, the top-of-stack location points
   * to the test file that called it, not the PO where the locator is.
   *
   * Strategy:
   * 1. Parse all stack frames from the error
   * 2. Skip test specs (tests/*.spec.ts)
   * 3. Prefer frames in known Page Object directories (pages/, page-objects/, pom/, src/pages/)
   * 4. Fall back to the original location if no PO frame is found
   */
  private findActualSourceLocation(
    stack: string | undefined,
    originalLocation: { file?: string; line?: number } | null | undefined,
    testRepoPath: string,
  ): { file: string | null; line: number } {
    // Default: use the original location if present
    if (!stack) {
      return {
        file: originalLocation?.file ?? null,
        line: originalLocation?.line ?? 0,
      };
    }

    // Parse stack frames. Common formats:
    // "    at LoginPage.login (/path/pages/LoginPage.ts:12:34)"
    // "    at /path/pages/LoginPage.ts:12:34"
    const frameRegex = /^\s*at\s+(?:.*?\s+)?\(?([^)]+\.ts):(\d+):\d+\)?/gm;
    const frames: Array<{ file: string; line: number }> = [];
    let match: RegExpExecArray | null;

    while ((match = frameRegex.exec(stack)) !== null) {
      frames.push({
        file: match[1],
        line: parseInt(match[2], 10),
      });
    }

    if (frames.length === 0) {
      return {
        file: originalLocation?.file ?? null,
        line: originalLocation?.line ?? 0,
      };
    }

    // Known Page Object directory patterns
    const poPatterns = [
      /[/\\]pages[/\\]/i,
      /[/\\]page-objects?[/\\]/i,
      /[/\\]pom[/\\]/i,
      /[/\\]src[/\\]pages[/\\]/i,
      /[/\\]e2e[/\\]pom[/\\]/i,
    ];

    // Filter out test specs and prefer PO files
    const nonSpecFrames = frames.filter(f => !/(tests?[/\\].*\.spec\.ts|\.test\.ts)$/i.test(f.file));
    const poFrames = nonSpecFrames.filter(f => poPatterns.some(p => p.test(f.file)));

    // Priority: PO frames > non-spec frames > original location
    const best = poFrames[0] ?? nonSpecFrames[0];
    if (best) {
      // Normalize to absolute path if relative
      const absFile = path.isAbsolute(best.file)
        ? best.file
        : path.join(testRepoPath, best.file);
      return { file: absFile, line: best.line };
    }

    return {
      file: originalLocation?.file ?? null,
      line: originalLocation?.line ?? 0,
    };
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
