/**
 * Playwright JSON Report Adapter
 * Converts Playwright's native JSON reporter output into the unified format.
 */

import type { ProviderAdapter, IngestPayload, UnifiedTestResult, ProviderType } from './types';
import { logger } from '../utils/logger';

const MOD = 'playwright-adapter';

export class PlaywrightAdapter implements ProviderAdapter {
  readonly providerType: ProviderType = 'playwright';

  canHandle(data: any): boolean {
    // Playwright JSON has `config` with `projects` array and top-level `suites`
    return (
      data &&
      typeof data === 'object' &&
      Array.isArray(data.suites) &&
      (data.config !== undefined || data.stats !== undefined)
    );
  }

  parse(data: any, meta?: Record<string, any>): IngestPayload {
    const results: UnifiedTestResult[] = [];
    let passed = 0, failed = 0, skipped = 0, timedOut = 0;

    const walkSuites = (suites: any[], parentFile?: string): void => {
      for (const suite of suites) {
        const suiteFile = suite.file ?? parentFile;

        // Process specs at this level
        for (const spec of suite.specs ?? []) {
          const testName = spec.title ?? 'unknown';

          for (const test of spec.tests ?? []) {
            for (const result of test.results ?? []) {
              const status = mapStatus(result.status);
              if (status === 'passed') { passed++; continue; }
              if (status === 'skipped') { skipped++; continue; }

              if (status === 'timedOut') timedOut++;
              else failed++;

              const errorMessage = [
                result.error?.message,
                ...(result.errors ?? []).map((e: any) => e.message || ''),
              ].filter(Boolean).join('\n\n');

              const stackTrace = [
                result.error?.stack,
                ...(result.errors ?? []).map((e: any) => e.stack || ''),
              ].filter(Boolean).join('\n\n');

              const locator = extractLocator(errorMessage + '\n' + stackTrace);
              const url = extractUrl(errorMessage);
              const lineInfo = extractLineInfo(stackTrace, suiteFile);

              results.push({
                testName,
                suiteName: suite.title,
                filePath: suiteFile,
                status,
                duration: result.duration,
                errorMessage,
                stackTrace,
                failedLocator: locator || undefined,
                lineNumber: lineInfo?.line,
                failedLineCode: lineInfo?.code || undefined,
                url: url || undefined,
                screenshotUrl: result.attachments?.find((a: any) => a.contentType?.startsWith('image/'))?.path,
                videoUrl: result.attachments?.find((a: any) => a.contentType?.startsWith('video/'))?.path,
                traceUrl: result.attachments?.find((a: any) => a.name === 'trace')?.path,
                retries: (test.results?.length ?? 1) - 1,
                browser: test.projectName,
              });
            }
          }
        }

        // Recurse into nested suites (test.describe blocks)
        if (suite.suites?.length) {
          walkSuites(suite.suites, suiteFile);
        }
      }
    };

    walkSuites(data.suites ?? []);

    // Count passed from stats if available
    const statsTotal = data.stats?.expected ?? 0;
    const totalFromScan = passed + failed + skipped + timedOut;
    const total = Math.max(statsTotal, totalFromScan, results.length + passed + skipped);

    logger.info(MOD, `Parsed Playwright report`, {
      total, passed, failed: failed + timedOut, skipped,
      failures: results.length,
    });

    return {
      provider: 'playwright',
      repoUrl: meta?.repoUrl,
      repoName: meta?.repoName,
      branch: meta?.branch,
      commit: meta?.commit,
      buildId: meta?.buildId,
      triggerSource: meta?.triggerSource || 'api',
      totalTests: total,
      passedTests: passed,
      failedTests: failed + timedOut,
      skippedTests: skipped,
      totalDuration: data.stats?.duration,
      timestamp: new Date().toISOString(),
      results,
    };
  }
}

function mapStatus(status: string): UnifiedTestResult['status'] {
  switch (status) {
    case 'passed': case 'expected': return 'passed';
    case 'failed': case 'unexpected': return 'failed';
    case 'timedOut': case 'timedout': return 'timedOut';
    case 'skipped': return 'skipped';
    case 'flaky': return 'flaky';
    default: return 'failed';
  }
}

function extractLocator(text: string): string | null {
  // Playwright locator patterns
  const patterns = [
    /locator\('([^']+)'\)/,
    /getByRole\('([^']+)'[^)]*\)/,
    /getByText\('([^']+)'[^)]*\)/,
    /getByTestId\('([^']+)'\)/,
    /getByLabel\('([^']+)'[^)]*\)/,
    /getByPlaceholder\('([^']+)'[^)]*\)/,
    /selector\s*[=:]\s*["']([^"']+)["']/,
    /waiting for\s+(?:locator\()?["']?([^"')\n]+)/,
  ];
  for (const p of patterns) {
    const m = p.exec(text);
    if (m?.[1]) return m[1];
  }
  return null;
}

function extractUrl(text: string): string | null {
  const navMatch = /navigated to "([^"]+)"/.exec(text);
  if (navMatch?.[1]) return navMatch[1];
  const waitMatch = /waiting for.*?(https?:\/\/[^\s"']+)/.exec(text);
  if (waitMatch?.[1]) return waitMatch[1];
  return null;
}

function extractLineInfo(stack: string, file?: string): { line: number; code?: string } | null {
  if (!stack || !file) return null;
  const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}:(\\d+):(\\d+)`);
  const m = re.exec(stack);
  if (m?.[1]) return { line: parseInt(m[1], 10) };
  return null;
}
