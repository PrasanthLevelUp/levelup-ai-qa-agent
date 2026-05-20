/**
 * JUnit XML Adapter
 * Parses JUnit/xUnit XML reports (TestNG, pytest, JUnit, Mocha, etc.)
 * into the unified format.
 */

import type { ProviderAdapter, IngestPayload, UnifiedTestResult, ProviderType } from './types';
import { logger } from '../utils/logger';

const MOD = 'junit-adapter';

/**
 * Lightweight XML-to-object parser for JUnit XML.
 * Avoids heavy dependencies — JUnit XML has a simple, well-known structure.
 */
function parseJUnitXml(xml: string): JUnitReport {
  const report: JUnitReport = { testsuites: [] };

  // Extract <testsuite> blocks
  const suiteRegex = /<testsuite\s([^>]*)>(.*?)<\/testsuite>/gs;
  let suiteMatch: RegExpExecArray | null;

  while ((suiteMatch = suiteRegex.exec(xml)) !== null) {
    const attrs = parseAttributes(suiteMatch[1]);
    const body = suiteMatch[2];
    const suite: JUnitTestSuite = {
      name: attrs['name'] || 'unknown',
      tests: parseInt(attrs['tests'] || '0', 10),
      failures: parseInt(attrs['failures'] || '0', 10),
      errors: parseInt(attrs['errors'] || '0', 10),
      skipped: parseInt(attrs['skipped'] || '0', 10),
      time: parseFloat(attrs['time'] || '0'),
      timestamp: attrs['timestamp'],
      testcases: [],
    };

    // Extract <testcase> elements
    const caseRegex = /<testcase\s([^>]*?)(\/?>)(.*?)(?:<\/testcase>|(?=<testcase|<\/testsuite))/gs;
    let caseMatch: RegExpExecArray | null;

    while ((caseMatch = caseRegex.exec(body)) !== null) {
      const caseAttrs = parseAttributes(caseMatch[1]);
      const caseBody = caseMatch[3] || '';
      const tc: JUnitTestCase = {
        name: caseAttrs['name'] || 'unknown',
        classname: caseAttrs['classname'],
        time: parseFloat(caseAttrs['time'] || '0'),
      };

      // Check for failure
      const failMatch = /<failure([^>]*)>(.*?)<\/failure>/s.exec(caseBody);
      if (failMatch) {
        const fAttrs = parseAttributes(failMatch[1]);
        tc.failure = {
          message: fAttrs['message'] || '',
          type: fAttrs['type'] || '',
          text: failMatch[2]?.trim() || '',
        };
      }

      // Check for error
      const errMatch = /<error([^>]*)>(.*?)<\/error>/s.exec(caseBody);
      if (errMatch) {
        const eAttrs = parseAttributes(errMatch[1]);
        tc.error = {
          message: eAttrs['message'] || '',
          type: eAttrs['type'] || '',
          text: errMatch[2]?.trim() || '',
        };
      }

      // Check for skipped
      if (/<skipped/.test(caseBody)) {
        tc.skipped = true;
      }

      // System-out / system-err
      const sysOut = /<system-out>(.*?)<\/system-out>/s.exec(caseBody);
      if (sysOut) tc.systemOut = sysOut[1]?.trim();
      const sysErr = /<system-err>(.*?)<\/system-err>/s.exec(caseBody);
      if (sysErr) tc.systemErr = sysErr[1]?.trim();

      suite.testcases.push(tc);
    }

    report.testsuites.push(suite);
  }

  // Handle single <testsuite> without wrapping <testsuites>
  if (report.testsuites.length === 0) {
    // Try to find testcases directly (some formats skip testsuite wrapper)
    const directCases = /<testcase\s/g;
    if (directCases.test(xml)) {
      const syntheticSuite: JUnitTestSuite = {
        name: 'default',
        tests: 0,
        failures: 0,
        errors: 0,
        skipped: 0,
        time: 0,
        testcases: [],
      };
      // Re-run case extraction on full XML
      const caseRegex2 = /<testcase\s([^>]*?)(\/?>)(.*?)(?:<\/testcase>|(?=<testcase|$))/gs;
      let cm: RegExpExecArray | null;
      while ((cm = caseRegex2.exec(xml)) !== null) {
        const ca = parseAttributes(cm[1]);
        const cb = cm[3] || '';
        const tc2: JUnitTestCase = { name: ca['name'] || 'unknown', classname: ca['classname'], time: parseFloat(ca['time'] || '0') };
        const fm = /<failure([^>]*)>(.*?)<\/failure>/s.exec(cb);
        if (fm) { const fa = parseAttributes(fm[1]); tc2.failure = { message: fa['message'] || '', type: fa['type'] || '', text: fm[2]?.trim() || '' }; }
        const em = /<error([^>]*)>(.*?)<\/error>/s.exec(cb);
        if (em) { const ea = parseAttributes(em[1]); tc2.error = { message: ea['message'] || '', type: ea['type'] || '', text: em[2]?.trim() || '' }; }
        if (/<skipped/.test(cb)) tc2.skipped = true;
        syntheticSuite.testcases.push(tc2);
      }
      syntheticSuite.tests = syntheticSuite.testcases.length;
      report.testsuites.push(syntheticSuite);
    }
  }

  return report;
}

function parseAttributes(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w[\w-]*)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrStr)) !== null) {
    attrs[m[1]] = decodeXmlEntities(m[2]);
  }
  return attrs;
}

function decodeXmlEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

export class JUnitAdapter implements ProviderAdapter {
  readonly providerType: ProviderType = 'junit';

  canHandle(data: any): boolean {
    if (typeof data === 'string') {
      return data.trim().startsWith('<?xml') || /<testsuites?[\s>]/.test(data) || /<testcase[\s>]/.test(data);
    }
    return false;
  }

  parse(data: any, meta?: Record<string, any>): IngestPayload {
    const xml = typeof data === 'string' ? data : String(data);
    const report = parseJUnitXml(xml);

    const results: UnifiedTestResult[] = [];
    let totalPassed = 0, totalFailed = 0, totalSkipped = 0;

    for (const suite of report.testsuites) {
      for (const tc of suite.testcases) {
        if (tc.skipped) {
          totalSkipped++;
          continue;
        }

        if (tc.failure || tc.error) {
          totalFailed++;
          const fail = tc.failure || tc.error!;
          const errorMsg = fail.message || fail.text || 'Unknown failure';
          const stackTrace = fail.text || '';
          const locator = extractLocatorFromError(errorMsg + '\n' + stackTrace);

          results.push({
            testName: tc.name,
            suiteName: suite.name,
            filePath: tc.classname,
            status: 'failed',
            duration: tc.time ? tc.time * 1000 : undefined, // JUnit uses seconds
            errorMessage: errorMsg,
            stackTrace,
            failedLocator: locator || undefined,
            logs: [tc.systemOut, tc.systemErr].filter(Boolean).join('\n'),
          });
        } else {
          totalPassed++;
        }
      }
    }

    const total = totalPassed + totalFailed + totalSkipped;

    logger.info(MOD, `Parsed JUnit XML report`, {
      suites: report.testsuites.length,
      total, passed: totalPassed, failed: totalFailed, skipped: totalSkipped,
      failures: results.length,
    });

    return {
      provider: 'junit',
      repoUrl: meta?.repoUrl,
      repoName: meta?.repoName,
      branch: meta?.branch,
      commit: meta?.commit,
      buildId: meta?.buildId,
      triggerSource: meta?.triggerSource || 'api',
      totalTests: total,
      passedTests: totalPassed,
      failedTests: totalFailed,
      skippedTests: totalSkipped,
      timestamp: new Date().toISOString(),
      results,
    };
  }
}

function extractLocatorFromError(text: string): string | null {
  // Common Selenium/WebDriver locator patterns
  const patterns = [
    /By\.(\w+):\s*([^\]\n]+)/,
    /css selector\s*["']([^"']+)["']/,
    /xpath\s*["']([^"']+)["']/,
    /id\s*[=:]\s*["']([^"']+)["']/,
    /Unable to locate element:\s*\{[^}]*"using":\s*"([^"]+)",\s*"value":\s*"([^"]+)"/,
    /NoSuchElementException.*?([#.\[][\w\-=\[\]"'#.>\s]+)/,
    // Playwright patterns (in case JUnit wraps Playwright)
    /locator\('([^']+)'\)/,
    /getByRole\('([^']+)'[^)]*\)/,
    /getByTestId\('([^']+)'\)/,
  ];
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) return m[2] || m[1];
  }
  return null;
}

// Internal types
interface JUnitReport { testsuites: JUnitTestSuite[]; }
interface JUnitTestSuite { name: string; tests: number; failures: number; errors: number; skipped: number; time: number; timestamp?: string; testcases: JUnitTestCase[]; }
interface JUnitTestCase { name: string; classname?: string; time?: number; failure?: JUnitFailure; error?: JUnitFailure; skipped?: boolean; systemOut?: string; systemErr?: string; }
interface JUnitFailure { message: string; type: string; text: string; }
