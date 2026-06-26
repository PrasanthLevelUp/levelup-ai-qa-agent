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

              // A broken locator almost always manifests as a TEST TIMEOUT (the
              // action — e.g. fill('#username') — waits the full timeout then fails).
              // In that case Playwright emits TWO errors on the result:
              //   errors[0] = "Test timeout of Nms exceeded."  (NO location, NO stack)
              //   errors[1] = the real action error            (location → Page Object)
              // The generic timeout error is also surfaced as `result.error`. Reading
              // only `result.error`/`errors[0]` therefore yields an undefined location,
              // the stack parse finds zero frames, and filePath falls back to the test
              // spec — so validation searches the spec for the locator, finds nothing,
              // and rejects every candidate with "Original locator not found in file."
              //
              // Fix: gather EVERY candidate location Playwright provides and prefer the
              // one that points at the actual source (Page Object) over the generic
              // timeout error (which has none) and over the test spec. Playwright hands
              // us the precise PO location in errors[1] — we just have to read it.
              const candidateLocations: Array<{ file?: string; line?: number }> = [
                result.errorLocation,
                result.error?.location,
                ...((result.errors ?? []).map((e: any) => e?.location)),
              ].filter((l: any): l is { file?: string; line?: number } => !!l && !!l.file);

              // Stack frames are still useful for inline failures where errors carry a
              // real stack (no precise location). Concatenate every available stack.
              const stack = [
                result.error?.stack,
                ...((result.errors ?? []).map((e: any) => e?.stack)),
              ].filter(Boolean).join('\n') || undefined;

              const resolvedLocation = this.findActualSourceLocation(stack, candidateLocations, testRepoPath);

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

              // Resolve the REAL page URL from this result's trace.zip via the
              // TraceParser (Playwright records the rendered frame URL natively in
              // frame-snapshot events). No fixture injection or config edits needed.
              // Falls back to legacy regex extraction if no trace/URL is found.
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
                trace_path: tracePath,
                video_path: videoPath,
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

  /**
   * Resolve the ACTUAL source file where the broken code lives. When a Page Object
   * method fails, the generic/top-of-stack location points to the test file that
   * called it (or to nothing at all for timeouts), not the PO where the locator is.
   *
   * Strategy (in priority order):
   * 1. Among the explicit candidate locations Playwright provides, prefer one that is
   *    NOT a test spec — that is the Page Object source (e.g. errors[1].location).
   * 2. Otherwise parse the error stack, skipping test specs, preferring known PO
   *    directories (pages/, page-objects/, pom/, src/pages/).
   * 3. Otherwise fall back to the first available candidate location.
   */
  private findActualSourceLocation(
    stack: string | undefined,
    candidateLocations: Array<{ file?: string; line?: number }> | { file?: string; line?: number } | null | undefined,
    testRepoPath: string,
  ): { file: string | null; line: number } {
    const candidates = Array.isArray(candidateLocations)
      ? candidateLocations
      : (candidateLocations ? [candidateLocations] : []);
    const withFile = candidates.filter((l) => !!l && !!l.file) as Array<{ file: string; line?: number }>;

    const isSpec = (file: string): boolean =>
      /(tests?[/\\].*\.spec\.ts|\.test\.ts)$/i.test(file);

    // Normalize a file path (from Playwright error locations or stack frames) to an
    // absolute path in the healing agent's environment. Playwright locations often
    // carry absolute paths from the CI runner (e.g. /home/runner/work/repo/repo/pages/X.ts)
    // which don't exist in the healing agent's clone. Extract the repo-relative part
    // (e.g. pages/X.ts) and join it with the agent's testRepoPath.
    const toAbs = (file: string): string => {
      if (!path.isAbsolute(file)) {
        // Already relative (e.g. "pages/LoginPage.ts") → join with testRepoPath
        return path.join(testRepoPath, file);
      }
      // Absolute path from a different environment (CI runner, local dev, etc.).
      // Try using it as-is first (works when healing agent and test runner share the same FS).
      if (fs.existsSync(file)) {
        return file;
      }
      // Path doesn't exist locally → extract the repo-relative part.
      // Common CI patterns: /home/runner/work/{repo}/{repo}/pages/X.ts (GitHub Actions),
      //                     /builds/{org}/{repo}/pages/X.ts (GitLab CI),
      //                     /home/ubuntu/github_repos/{repo}/pages/X.ts (local).
      // Strategy: look for known repo-relative directories (pages/, tests/, src/, e2e/, pom/)
      // and take everything from that point onward.
      const repoRelativeDirs = ['pages/', 'page-objects/', 'pom/', 'tests/', 'test/', 'src/', 'e2e/', 'specs/'];
      for (const dir of repoRelativeDirs) {
        const idx = file.indexOf(dir);
        if (idx !== -1) {
          const relative = file.slice(idx); // e.g. "pages/LoginPage.ts"
          return path.join(testRepoPath, relative);
        }
      }
      // Fallback: use the file basename in testRepoPath (may not work if there are duplicates)
      logger.warn(MOD, 'Could not extract repo-relative path from absolute location; using basename fallback', { file });
      return path.join(testRepoPath, path.basename(file));
    };

    // 1. Prefer an explicit candidate location that points at non-spec source (the PO).
    const nonSpecCandidate = withFile.find((l) => !isSpec(l.file));
    if (nonSpecCandidate) {
      return { file: toAbs(nonSpecCandidate.file), line: nonSpecCandidate.line ?? 0 };
    }

    const firstCandidate = withFile[0];

    // No stack to parse → fall back to the first available candidate (may be a spec).
    if (!stack) {
      return {
        file: firstCandidate ? toAbs(firstCandidate.file) : null,
        line: firstCandidate?.line ?? 0,
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
        file: firstCandidate ? toAbs(firstCandidate.file) : null,
        line: firstCandidate?.line ?? 0,
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
    const nonSpecFrames = frames.filter(f => !isSpec(f.file));
    const poFrames = nonSpecFrames.filter(f => poPatterns.some(p => p.test(f.file)));

    // Priority: PO frames > non-spec frames > first candidate location
    const best = poFrames[0] ?? nonSpecFrames[0];
    if (best) {
      return { file: toAbs(best.file), line: best.line };
    }

    return {
      file: firstCandidate ? toAbs(firstCandidate.file) : null,
      line: firstCandidate?.line ?? 0,
    };
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
