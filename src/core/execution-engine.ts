/**
 * Execution Engine — runs Playwright tests and captures results.
 *
 * CLI: ts-node src/core/execution-engine.ts <test-repo-path> [test-file]
 * Output: { exitCode, stdout, stderr, resultsFile, startTime, endTime }
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
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

export function runTests(repoPath: string, testFile?: string): RunResult {
  const resultsFile = path.join(repoPath, 'test-results.json');
  const startTime = new Date().toISOString();
  const start = Date.now();

  // Build the command — target specific file or whole suite
  const testCmd = testFile
    ? `npx playwright test "${testFile}"`
    : 'npm test';

  const env = {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH: process.env['PLAYWRIGHT_BROWSERS_PATH'] || `${process.env['HOME']}/.cache/ms-playwright`,
  };

  logger.info(MOD, `Running tests in ${repoPath}`, { cmd: testCmd, testFile: testFile ?? 'all' });

  let stdout = '';
  let stderr = '';
  let exitCode = 0;

  try {
    const output = execSync(testCmd, {
      cwd: repoPath,
      env,
      timeout: 120_000,     // 2 min max
      maxBuffer: 5_000_000, // 5 MB
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    stdout = output;
  } catch (err: unknown) {
    const execErr = err as { status?: number; stdout?: string; stderr?: string };
    exitCode = execErr.status ?? 1;
    stdout = execErr.stdout ?? '';
    stderr = execErr.stderr ?? '';
  }

  const endTime = new Date().toISOString();
  const durationMs = Date.now() - start;

  logger.info(MOD, `Tests finished`, { exitCode, durationMs, resultsFile });

  return { exitCode, stdout, stderr, resultsFile, startTime, endTime, durationMs };
}

// CLI mode
if (require.main === module) {
  const repoPath = process.argv[2];
  const testFile = process.argv[3];
  if (!repoPath) {
    console.error('Usage: execution-engine.ts <test-repo-path> [test-file]');
    process.exit(1);
  }
  const result = runTests(repoPath, testFile);
  // Write result to a temp file for the daemon to pick up
  const outPath = '/tmp/run_result.json';
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
