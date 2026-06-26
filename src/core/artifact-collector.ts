/**
 * Artifact Collector (Orchestrator)
 * Coordinates specialized extractors to collect failure artifacts from Playwright JSON results.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { extractLocator, buildLocatorInfo, type LocatorInfo } from './locator-extractor';
import { normalizeError, extractErrorPattern, type NormalizedError } from './error-normalizer';
import { extractCodeContext, type CodeContext } from './code-context-extractor';
import { resolvePageObjectLocator, type PageObjectResolution } from './page-object-resolver';

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
  /** Path to the Playwright trace.zip attachment, when captured (Failure Replay). */
  trace_path: string | null;
  /** Path to the failure video attachment, when captured (Failure Replay). */
  video_path: string | null;
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
  /**
   * When the failing line referenced a Page Object field (e.g. `this.loginBtn`)
   * rather than an inline locator, this holds the field→selector resolution so
   * the diagnosis/healing layers are not starved of a `failed_locator`.
   */
  page_object_resolution: PageObjectResolution | null;
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
              let locatorInfo =
                extractLocator(errorMessage) || extractLocator(codeContext.failedLineCode || '');

              // Page Object fallback: when the failing line is a field reference
              // (e.g. `await this.loginBtn.click()`) there is no inline selector,
              // so the extractors above return null. Resolve the field back to
              // its concrete locator using the failing file's full source (which
              // contains both the field declaration and the method that used it).
              // Without this the healer is starved of a `failed_locator` and
              // misdiagnoses a perfectly valid selector as a "broken locator".
              let pageObjectResolution: PageObjectResolution | null = null;
              if (!locatorInfo && codeContext.failedLineCode) {
                pageObjectResolution = resolvePageObjectLocator(
                  codeContext.failedLineCode,
                  codeContext.fullContent || '',
                );
                if (pageObjectResolution) {
                  locatorInfo = buildLocatorInfo(
                    pageObjectResolution.resolvedLocator,
                    errorMessage,
                  );
                  logger.info(MOD, 'Resolved locator from Page Object field', {
                    testName,
                    fieldName: pageObjectResolution.fieldName,
                    resolvedLocator: pageObjectResolution.resolvedLocator,
                    builder: pageObjectResolution.builder,
                  });
                }
              }

              const attachments = (result.attachments ?? []) as any[];
              const screenshotPath = attachments.find((a: any) =>
                a.name === 'screenshot' || a.contentType?.startsWith('image/')
              )?.path ?? null;
              const tracePath = attachments.find((a: any) =>
                a.name === 'trace' ||
                a.contentType === 'application/zip' ||
                (typeof a.path === 'string' && /trace.*\.zip$/i.test(a.path)) ||
                (typeof a.path === 'string' && /\.zip$/i.test(a.path) && /trace/i.test(a.path))
              )?.path ?? null;
              const videoPath = attachments.find((a: any) =>
                a.name === 'video' || a.contentType?.startsWith('video/')
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
                trace_path: tracePath,
                video_path: videoPath,
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
                page_object_resolution: pageObjectResolution,
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

/**
 * A single enumerated test from a Playwright run — EVERY spec/test that ran or was
 * skipped, regardless of outcome. Unlike `ArtifactCollector.collect` (which only
 * returns failures), this is the complete "universe" of the run so the worker can
 * create exactly one ExecutionRecord per test (passes included) and prove the
 * 1-test = 1-record invariant.
 */
export interface EnumeratedTest {
  testName: string;
  file: string | null;
  /** Concrete Playwright result status, normalized to lowercase. */
  status: 'passed' | 'failed' | 'timedout' | 'skipped' | 'interrupted';
  durationMs: number;
}

/** Reduce several raw result statuses for one spec into a single outcome. */
function reduceSpecStatus(
  statuses: string[],
): 'passed' | 'failed' | 'timedout' | 'skipped' | 'interrupted' {
  const norm = statuses.map((s) => String(s).toLowerCase());
  if (norm.some((s) => s === 'timedout')) return 'timedout';
  if (norm.some((s) => s === 'interrupted')) return 'interrupted';
  if (norm.some((s) => s === 'failed')) return 'failed';
  if (norm.some((s) => s === 'passed')) return 'passed';
  if (norm.length > 0 && norm.every((s) => s === 'skipped')) return 'skipped';
  return 'failed';
}

/**
 * Enumerate EVERY test in a Playwright results file (passes, failures, skips),
 * deduplicated by test name. This is the run universe the ExecutionRecord store is
 * reconciled against — each test here must map to exactly one record.
 *
 * Pure read of the results JSON; safe to call alongside `collect`.
 */
export function enumerateAllTests(resultsFilePath: string): EnumeratedTest[] {
  if (!fs.existsSync(resultsFilePath)) return [];
  let raw: { suites?: any[] };
  try {
    raw = JSON.parse(fs.readFileSync(resultsFilePath, 'utf-8')) as { suites?: any[] };
  } catch {
    return [];
  }

  // Aggregate per test name: a spec can produce multiple `tests` (projects) and
  // multiple `results` (retries). We take the final result status per test and a
  // single reduced status per spec title.
  type SpecAgg = { file: string | null; statuses: string[]; durationMs: number };
  const byName = new Map<string, SpecAgg>();

  const walk = (suites: any[], parentFile?: string): void => {
    for (const suite of suites ?? []) {
      const suiteFile = suite.file ?? parentFile;
      for (const spec of suite.specs ?? []) {
        const testName = spec.title ?? 'unknown test';
        const entry: SpecAgg = byName.get(testName) ?? { file: spec.file ?? suiteFile ?? null, statuses: [], durationMs: 0 };
        for (const test of spec.tests ?? []) {
          const results = test.results ?? [];
          // Final result (retries are appended in order); fall back to last.
          const finalResult = results[results.length - 1];
          if (finalResult?.status) {
            entry.statuses.push(String(finalResult.status));
            entry.durationMs += Number(finalResult.duration ?? 0) || 0;
          } else if (typeof test.status === 'string') {
            entry.statuses.push(test.status);
          }
        }
        byName.set(testName, entry);
      }
      if (suite.suites?.length > 0) walk(suite.suites, suiteFile);
    }
  };

  walk(raw.suites ?? []);

  const out: EnumeratedTest[] = [];
  for (const [testName, entry] of byName) {
    out.push({
      testName,
      file: entry.file,
      status: reduceSpecStatus(entry.statuses),
      durationMs: entry.durationMs,
    });
  }
  return out;
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
