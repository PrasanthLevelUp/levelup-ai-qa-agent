/**
 * Artifact Collector
 * Collects critical failure artifacts from Playwright JSON results.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

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
}

const LOCATOR_PATTERNS = [
  /locator\('([^']+)'\)/,
  /waiting for locator\('([^']+)'\)/,
  /page\.(?:click|fill|locator|getByRole|getByText|getByLabel|getByPlaceholder)\(([^)]+)\)/,
  /selector[:\s]+['"]([^'"]+)['"]/,
];

function normalizeErrorPattern(errorMessage: string): string {
  return errorMessage
    .replace(/\x1b\[[0-9;]*m/g, '')
    .replace(/\d+ms/g, 'Xms')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\s+/g, ' ')
    .slice(0, 240)
    .trim();
}

function extractFailedLocator(errorMessage: string): string | null {
  for (const pattern of LOCATOR_PATTERNS) {
    const match = pattern.exec(errorMessage);
    if (match) {
      return (match[match.length - 1] || '').replace(/^['"]|['"]$/g, '');
    }
  }
  return null;
}

function extractUrl(errorMessage: string): string | null {
  const navMatch = /navigated to \"([^\"]+)\"/.exec(errorMessage);
  if (navMatch?.[1]) return navMatch[1];
  const waitingMatch = /waiting for\"\s*(https?:\/\/[^\"\s]+)\"/.exec(errorMessage);
  if (waitingMatch?.[1]) return waitingMatch[1];
  return null;
}

function extractLineContext(fileContent: string, lineNumber: number): { failedLine: string | null; surroundingCode: string } {
  if (!fileContent || lineNumber <= 0) {
    return { failedLine: null, surroundingCode: '' };
  }

  const lines = fileContent.split('\n');
  const start = Math.max(1, lineNumber - 5);
  const end = Math.min(lines.length, lineNumber + 5);

  const surrounding = lines
    .slice(start - 1, end)
    .map((line, idx) => `${start + idx}${start + idx === lineNumber ? ' >' : ' '} | ${line}`)
    .join('\n');

  return {
    failedLine: lines[lineNumber - 1]?.trim() ?? null,
    surroundingCode: surrounding,
  };
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
            const fileContent = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
            const context = extractLineContext(fileContent, lineNumber);

            const screenshotPath = (result.attachments ?? []).find((a) =>
              a.name === 'screenshot' || a.contentType?.startsWith('image/')
            )?.path ?? null;

            const artifact: ArtifactCollection = {
              test_name: testName,
              error_message: errorMessage,
              error_pattern: normalizeErrorPattern(errorMessage),
              failed_locator: extractFailedLocator(errorMessage),
              file_path: filePath,
              line_number: lineNumber,
              failed_line_code: context.failedLine,
              screenshot_path: screenshotPath,
              url: extractUrl(errorMessage),
              timestamp: result.startTime ?? new Date().toISOString(),
              test_results_json: rawText,
              test_results_json_path: resultsFilePath,
              surrounding_code: context.surroundingCode,
              test_file_full: fileContent,
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
