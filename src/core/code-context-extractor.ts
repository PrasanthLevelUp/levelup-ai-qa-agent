/**
 * Code Context Extractor — reads test files and extracts context around failures.
 */

import * as fs from 'fs';
import { logger } from '../utils/logger';

const MOD = 'code-context-extractor';

export interface CodeContext {
  filePath: string;
  lineNumber: number;
  failedLineCode: string | null;
  surroundingCode: string;
  describeName: string | null;
  testName: string | null;
  fullContent: string;
}

/**
 * Extract code context around a specific line number.
 * Returns 5 lines before and 5 lines after the failed line.
 */
export function extractCodeContext(filePath: string, lineNumber: number): CodeContext {
  const result: CodeContext = {
    filePath,
    lineNumber,
    failedLineCode: null,
    surroundingCode: '',
    describeName: null,
    testName: null,
    fullContent: '',
  };

  if (!fs.existsSync(filePath)) {
    logger.warn(MOD, 'Test file not found', { filePath });
    return result;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  result.fullContent = content;

  const lines = content.split('\n');

  if (lineNumber > 0 && lineNumber <= lines.length) {
    result.failedLineCode = lines[lineNumber - 1]?.trim() ?? null;

    const start = Math.max(1, lineNumber - 5);
    const end = Math.min(lines.length, lineNumber + 5);

    result.surroundingCode = lines
      .slice(start - 1, end)
      .map((line, idx) => {
        const ln = start + idx;
        const marker = ln === lineNumber ? ' >' : '  ';
        return `${ln}${marker} | ${line}`;
      })
      .join('\n');
  }

  // Extract describe block name
  const describeMatch = /test\.describe\s*\(\s*['"`]([^'"`]+)['"`]/.exec(content);
  result.describeName = describeMatch?.[1] ?? null;

  // Extract test name around failed line
  if (lineNumber > 0) {
    for (let i = lineNumber - 1; i >= 0; i--) {
      const testMatch = /test\s*\(\s*['"`]([^'"`]+)['"`]/.exec(lines[i] ?? '');
      if (testMatch) {
        result.testName = testMatch[1] ?? null;
        break;
      }
    }
  }

  logger.debug(MOD, 'Code context extracted', {
    filePath,
    lineNumber,
    describeName: result.describeName,
    testName: result.testName,
  });

  return result;
}
