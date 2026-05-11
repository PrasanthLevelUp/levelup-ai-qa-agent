/**
 * Execution Engine — runs Playwright tests asynchronously with streaming logs.
 * Refactored from synchronous execSync to async spawn for non-blocking execution.
 */

import { spawn } from 'child_process';
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

export class ExecutionEngine {
  /**
   * Clone or pull latest code from a repository.
   */
  static async cloneRepository(repoUrl: string, targetDir: string, branch = 'main'): Promise<void> {
    if (fs.existsSync(path.join(targetDir, '.git'))) {
      logger.info(MOD, 'Repository exists, pulling latest', { targetDir, branch });
      await ExecutionEngine.spawnAsync('git', ['checkout', branch], { cwd: targetDir });
      await ExecutionEngine.spawnAsync('git', ['pull', 'origin', branch], { cwd: targetDir });
    } else {
      logger.info(MOD, 'Cloning repository', { repoUrl, targetDir, branch });
      fs.mkdirSync(targetDir, { recursive: true });
      await ExecutionEngine.spawnAsync('git', ['clone', '-b', branch, repoUrl, targetDir]);
    }
  }

  /**
   * Install dependencies with streaming logs.
   */
  static async installDependencies(repoPath: string): Promise<void> {
    logger.info(MOD, 'Installing dependencies', { repoPath });
    await ExecutionEngine.spawnAsync('npm', ['install'], { cwd: repoPath });
    // Ensure Playwright browsers are installed
    try {
      await ExecutionEngine.spawnAsync('npx', ['playwright', 'install', 'chromium'], { cwd: repoPath });
    } catch {
      logger.warn(MOD, 'Playwright browser install skipped or failed');
    }
  }

  /**
   * Run Playwright tests asynchronously with streaming output.
   */
  static async runTests(repoPath: string, testFile?: string): Promise<RunResult> {
    const resultsFile = path.join(repoPath, 'test-results.json');
    const startTime = new Date().toISOString();
    const start = Date.now();

    const args = testFile
      ? ['playwright', 'test', testFile, '--reporter=json', '--output=test-results']
      : ['test'];

    const cmd = testFile ? 'npx' : 'npm';

    logger.info(MOD, 'Executing Playwright tests (async)', { repoPath, cmd, args: args.join(' ') });

    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    try {
      const result = await ExecutionEngine.spawnAsync(cmd, args, {
        cwd: repoPath,
        timeout: 180_000,
        captureOutput: true,
      });
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = result.exitCode;
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string; exitCode?: number };
      stdout = e.stdout ?? '';
      stderr = e.stderr ?? '';
      exitCode = e.exitCode ?? 1;
    }

    const endTime = new Date().toISOString();
    const durationMs = Date.now() - start;

    logger.info(MOD, 'Playwright execution complete', {
      exitCode,
      durationMs,
      resultsFile,
    });

    return { exitCode, stdout, stderr, resultsFile, startTime, endTime, durationMs };
  }

  /**
   * Parse test results from the JSON file.
   */
  static async getTestResults(resultsFilePath: string): Promise<any> {
    if (!fs.existsSync(resultsFilePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(resultsFilePath, 'utf-8'));
  }

  /**
   * Synchronous run method (backward compatible for orchestrator).
   */
  static run(repoPath: string, testFile?: string): RunResult {
    const { execSync } = require('child_process');
    const resultsFile = path.join(repoPath, 'test-results.json');
    const startTime = new Date().toISOString();
    const start = Date.now();

    const cmd = testFile
      ? `npx playwright test "${testFile}" --reporter=json --output=test-results`
      : 'npm test';

    logger.info(MOD, 'Executing Playwright tests (sync)', { repoPath, cmd });

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

    logger.info(MOD, 'Playwright execution complete', { exitCode, durationMs, resultsFile });

    return { exitCode, stdout, stderr, resultsFile, startTime, endTime, durationMs };
  }

  /**
   * Generic async spawn with streaming and capture.
   */
  private static spawnAsync(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      timeout?: number;
      captureOutput?: boolean;
    } = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: process.env,
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const timer = options.timeout
        ? setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
          }, options.timeout)
        : null;

      child.stdout?.on('data', (data: Buffer) => {
        const text = data.toString();
        stdout += text;
        logger.debug(MOD, 'stdout', { data: text.trim().slice(0, 200) });
      });

      child.stderr?.on('data', (data: Buffer) => {
        const text = data.toString();
        stderr += text;
        logger.debug(MOD, 'stderr', { data: text.trim().slice(0, 200) });
      });

      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        const exitCode = code ?? (timedOut ? 124 : 1);

        if (exitCode !== 0) {
          const err = Object.assign(new Error(`Process exited with code ${exitCode}`), {
            stdout,
            stderr,
            exitCode,
          });
          reject(err);
        } else {
          resolve({ stdout, stderr, exitCode });
        }
      });

      child.on('error', (error) => {
        if (timer) clearTimeout(timer);
        reject(Object.assign(error, { stdout, stderr, exitCode: 1 }));
      });
    });
  }
}
