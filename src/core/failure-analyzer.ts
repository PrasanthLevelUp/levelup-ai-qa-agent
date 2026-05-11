/**
 * Failure Analyzer — parses Playwright JSON results, extracts failure details,
 * identifies the failed locator and surrounding code context.
 *
 * CLI: ts-node src/core/failure-analyzer.ts <test-results.json> <test-repo-path>
 * Output (stdout + /tmp/failures.json): structured failure contexts
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

const MOD = 'failure-analyzer';

// ─── Types ─────────────────────────────────────────────────────

export interface TestResult {
  testName: string;
  file: string;
  line: number;
  status: 'passed' | 'failed' | 'timedOut' | 'skipped';
  durationMs: number;
  errors: string[];
  attachments: Array<{ name: string; path?: string; contentType?: string }>;
}

export interface FailureContext {
  testName: string;
  file: string;
  line: number;
  errorMessage: string;
  failedLocator: string | null;
  failedCodeLine: string | null;
  testFileContent: string;
  testFilePath: string;
  siteUrl: string;
  isTimingIssue: boolean;
  attachments: Array<{ name: string; path?: string; contentType?: string }>;
}

export interface AnalysisResult {
  totalTests: number;
  passed: number;
  failed: number;
  tests: TestResult[];
  failures: FailureContext[];
}

// ─── Locator Extraction ────────────────────────────────────────

const LOCATOR_PATTERNS = [
  /locator\('([^']+)'\)/,
  /page\.(fill|click|locator|getByRole|getByText|getByLabel|getByPlaceholder)\(([^)]+)\)/,
  /selector[:\s]+['"]([^'"]+)['"]/,
  /waiting for (?:selector|locator) ['"]([^'"]+)['"]/,
  /Timeout.*?locator\('([^']+)'\)/,
  /page\.locator\('([^']+)'\)/,
  /Error:.*locator\('([^']+)'\)/,
];

export function extractFailedLocator(errorText: string): string | null {
  for (const pat of LOCATOR_PATTERNS) {
    const m = pat.exec(errorText);
    if (m) {
      // Return the last captured group (the actual locator string)
      return m[m.length - 1] ?? null;
    }
  }
  return null;
}

function extractFailedCodeLine(errorText: string, testContent: string): string | null {
  // Try to find the line number from the stack trace
  const lineMatch = /\.spec\.ts:(\d+):(\d+)/.exec(errorText);
  if (lineMatch) {
    const lineNum = parseInt(lineMatch[1]!, 10);
    const lines = testContent.split('\n');
    if (lineNum > 0 && lineNum <= lines.length) {
      return lines[lineNum - 1]!.trim();
    }
  }
  return null;
}

function isTimingRelated(errorText: string): boolean {
  const keywords = ['timeout', 'waiting for', 'not visible', 'timed out', 'navigation'];
  return keywords.some(kw => errorText.toLowerCase().includes(kw));
}

// ─── Main Analysis ─────────────────────────────────────────────

export function analyzeResults(
  resultsPath: string,
  testRepoPath: string,
  siteUrl: string = 'https://opensource-demo.orangehrmlive.com'
): AnalysisResult {
  const raw = JSON.parse(fs.readFileSync(resultsPath, 'utf-8'));
  const tests: TestResult[] = [];
  const failures: FailureContext[] = [];

  for (const suite of raw.suites ?? []) {
    for (const spec of suite.specs ?? []) {
      const testName: string = spec.title ?? 'unknown';
      const file: string = spec.file ?? '';
      const line: number = spec.line ?? 0;

      for (const test of spec.tests ?? []) {
        for (const result of test.results ?? []) {
          const status = result.status as TestResult['status'];
          const errors: string[] = (result.errors ?? []).map(
            (e: { message?: string; stack?: string }) => e.message ?? e.stack ?? ''
          );
          const attachments = result.attachments ?? [];
          const durationMs: number = result.duration ?? 0;

          tests.push({ testName, file, line, status, durationMs, errors, attachments });

          if (status !== 'passed') {
            const fullError = errors.join('\n');
            const testFilePath = path.join(testRepoPath, 'tests', file);
            const testFileContent = fs.existsSync(testFilePath)
              ? fs.readFileSync(testFilePath, 'utf-8')
              : '';

            failures.push({
              testName,
              file,
              line,
              errorMessage: fullError,
              failedLocator: extractFailedLocator(fullError),
              failedCodeLine: extractFailedCodeLine(fullError, testFileContent),
              testFileContent,
              testFilePath,
              siteUrl,
              isTimingIssue: isTimingRelated(fullError),
              attachments,
            });
          }
        }
      }
    }
  }

  const passed = tests.filter(t => t.status === 'passed').length;
  logger.info(MOD, `Analyzed: ${tests.length} tests, ${passed} passed, ${failures.length} failures`);

  return {
    totalTests: tests.length,
    passed,
    failed: failures.length,
    tests,
    failures,
  };
}

// CLI mode
if (require.main === module) {
  const resultsFile = process.argv[2];
  const repoPath = process.argv[3];
  if (!resultsFile || !repoPath) {
    console.error('Usage: failure-analyzer.ts <test-results.json> <test-repo-path>');
    process.exit(1);
  }
  const result = analyzeResults(resultsFile, repoPath);
  const outPath = '/tmp/failures.json';
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
