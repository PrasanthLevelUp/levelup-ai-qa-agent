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
      logger.info(MOD, 'Repository exists, resetting and pulling latest', { targetDir, branch });
      // Always reset to clean state to discard any leftover healing patches
      await ExecutionEngine.spawnAsync('git', ['checkout', branch], { cwd: targetDir });
      await ExecutionEngine.spawnAsync('git', ['reset', '--hard', `origin/${branch}`], { cwd: targetDir });
      await ExecutionEngine.spawnAsync('git', ['clean', '-fd'], { cwd: targetDir });
      await ExecutionEngine.spawnAsync('git', ['pull', 'origin', branch], { cwd: targetDir });
    } else {
      logger.info(MOD, 'Cloning repository', { repoUrl, targetDir, branch });
      fs.mkdirSync(targetDir, { recursive: true });
      await ExecutionEngine.spawnAsync('git', ['clone', '-b', branch, repoUrl, targetDir]);
    }
  }

  /**
   * Install dependencies with streaming logs.
   * NOTE: Playwright is expected to be available globally in the Docker image
   * (mcr.microsoft.com/playwright), so we do NOT require it in node_modules.
   */
  static async installDependencies(repoPath: string): Promise<void> {
    logger.info(MOD, 'Installing dependencies', { repoPath });

    // Check if package.json exists
    const pkgPath = path.join(repoPath, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      throw new Error(`No package.json found at ${repoPath} — cannot install dependencies`);
    }

    // Run npm install with retry
    // IMPORTANT: Use --include=dev because test repos have @playwright/test in devDependencies
    // and NODE_ENV=production (from Dockerfile) would skip them
    let installSuccess = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await ExecutionEngine.spawnAsync('npm', ['install', '--include=dev'], { cwd: repoPath, timeout: 120_000 });
        installSuccess = true;
        break;
      } catch (error) {
        logger.warn(MOD, `npm install attempt ${attempt} failed`, {
          error: (error as Error).message,
          repoPath,
        });
        if (attempt < 2) {
          // Clean node_modules and retry
          const nmPath = path.join(repoPath, 'node_modules');
          if (fs.existsSync(nmPath)) {
            fs.rmSync(nmPath, { recursive: true, force: true });
          }
          logger.info(MOD, 'Retrying npm install after cleanup...');
        }
      }
    }

    if (!installSuccess) {
      throw new Error(`npm install failed after 2 attempts in ${repoPath}`);
    }

    // Verify node_modules exists (basic sanity check)
    const nmPath = path.join(repoPath, 'node_modules');
    if (!fs.existsSync(nmPath)) {
      throw new Error(`node_modules not found at ${repoPath} after npm install`);
    }

    // Check playwright availability — local node_modules OR global
    const localBin = path.join(repoPath, 'node_modules', '.bin', 'playwright');
    const hasLocal = fs.existsSync(localBin);

    logger.info(MOD, 'Dependencies installed', {
      repoPath,
      hasLocalPlaywright: hasLocal,
      nodeModulesExists: true,
    });

    // If playwright is not in local node_modules, that's OK — the Docker image
    // (mcr.microsoft.com/playwright:v1.52.0-jammy) has it globally installed.
    // The run() method uses `npx playwright test` which resolves global binaries.
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
   * Always uses `npx playwright test` to resolve both local and global playwright.
   *
   * IMPORTANT: We do NOT pass --reporter=json on the CLI because that overrides
   * the playwright.config's reporters and sends JSON to stdout instead of a file.
   * Instead, we rely on the config's ['json', { outputFile: 'test-results.json' }].
   * If the config doesn't produce the file, we write stdout as a fallback.
   */
  static run(repoPath: string, testFile?: string, grepFilter?: string): RunResult {
    const { execSync } = require('child_process');
    const resultsFile = path.join(repoPath, 'test-results.json');
    const startTime = new Date().toISOString();
    const start = Date.now();

    // Do NOT pass --reporter — let playwright.config.ts handle it
    // The config should have: reporter: [['json', { outputFile: 'test-results.json' }]]
    let cmd = testFile
      ? `npx playwright test "${testFile}"`
      : `npx playwright test`;

    // --grep isolates a single test by name for efficient per-test reruns
    if (grepFilter) {
      cmd += ` --grep "${grepFilter.replace(/"/g, '\\"')}"`;
    }

    logger.info(MOD, 'Executing Playwright tests (sync)', { repoPath, cmd });

    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    try {
      stdout = execSync(cmd, {
        cwd: repoPath,
        encoding: 'utf-8',
        env: process.env,
        timeout: 600_000, // 10 minutes — tests run against live sites
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

    // If the config's JSON reporter didn't create the file, try writing stdout as fallback
    if (!fs.existsSync(resultsFile)) {
      logger.warn(MOD, 'test-results.json not found from config reporter', {
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
      });
      // If stdout contains JSON (from --reporter=json or stdout capture), write it
      const trimmed = stdout.trim();
      if (trimmed.startsWith('{')) {
        try {
          JSON.parse(trimmed);
          fs.writeFileSync(resultsFile, trimmed, 'utf-8');
          logger.info(MOD, 'Wrote test-results.json from stdout');
        } catch {
          logger.warn(MOD, 'stdout is not valid JSON');
        }
      }
    }

    // Exit code 127 = command not found
    if (exitCode === 127) {
      logger.error(MOD, 'EXIT CODE 127: Command not found', {
        repoPath, cmd,
        nodeModulesExists: fs.existsSync(path.join(repoPath, 'node_modules')),
        playwrightBinExists: fs.existsSync(path.join(repoPath, 'node_modules', '.bin', 'playwright')),
        stderr: stderr.slice(0, 500),
      });
    }

    logger.info(MOD, 'Playwright execution complete', {
      exitCode, durationMs, resultsFile,
      resultsFileExists: fs.existsSync(resultsFile),
    });

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
