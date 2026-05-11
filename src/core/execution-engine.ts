/**
 * Execution Engine — runs Playwright tests and captures results.
 */

import { execSync } from 'child_process';
import * as path from 'path';
import { logger } from '../utils/logger';

const MOD = 'execution-engine';

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  resultsFile: string;
  startTime: string;
  endTime: string;
  durationMs: number;
}

export class ExecutionEngine {
  static run(repoPath: string, testFile?: string): RunResult {
    const resultsFile = path.join(repoPath, 'test-results.json');
    const startTime = new Date().toISOString();
    const start = Date.now();

    const cmd = testFile
      ? `npx playwright test "${testFile}" --reporter=json --output=test-results`
      : 'npm test';

    logger.info(MOD, 'Executing Playwright tests', { repoPath, cmd });

    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    try {
      stdout = execSync(cmd, {
        cwd: repoPath,
        encoding: 'utf-8',
        env: process.env,
        timeout: 180_000,
        maxBuffer: 10_000_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      exitCode = e.status ?? 1;
      stdout = e.stdout ?? '';
      stderr = e.stderr ?? '';
    }

    const endTime = new Date().toISOString();
    const durationMs = Date.now() - start;

    logger.info(MOD, 'Playwright execution complete', {
      exitCode,
      durationMs,
      resultsFile,
    });

    return {
      exitCode,
      stdout,
      stderr,
      resultsFile,
      startTime,
      endTime,
      durationMs,
    };
  }
}
