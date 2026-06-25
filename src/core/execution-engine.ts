/**
 * Execution Engine — runs Playwright tests asynchronously with streaming logs.
 * Refactored from synchronous execSync to async spawn for non-blocking execution.
 */

import { spawn } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../utils/logger';

const MOD = 'execution-engine';

/**
 * Per-test-run timeout (ms). A single Playwright rerun is a per-test, isolated
 * run during healing — it must NOT be allowed to hang for many minutes. The old
 * hard-coded 600_000 (10 min) per rerun, multiplied across the nested healing
 * retry loops, was the primary cause of healing jobs running for hours.
 * Override with HEALING_RERUN_TIMEOUT_MS. Default: 120s.
 */
const DEFAULT_RERUN_TIMEOUT_MS = (() => {
  const v = Number(process.env['HEALING_RERUN_TIMEOUT_MS']);
  return Number.isFinite(v) && v > 0 ? v : 120_000;
})();

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
   * SECURITY: Verifies the remote URL before reusing existing directories to prevent tenant isolation breaches.
   */
  static async cloneRepository(repoUrl: string, targetDir: string, branch = 'main'): Promise<void> {
    if (fs.existsSync(path.join(targetDir, '.git'))) {
      logger.info(MOD, 'Repository exists, verifying remote URL before reuse', { targetDir, branch });

      // SECURITY: Verify the existing repo's remote URL matches the expected repoUrl
      // This prevents cross-tenant contamination if directory paths collide
      try {
        const { stdout: existingRemote } = await ExecutionEngine.spawnAsync('git', ['remote', 'get-url', 'origin'], { cwd: targetDir });
        const normalizedExpected = repoUrl.replace(/\.git$/, '').toLowerCase();
        const normalizedExisting = existingRemote.trim().replace(/\.git$/, '').toLowerCase();

        if (normalizedExisting !== normalizedExpected) {
          logger.warn(MOD, 'Remote URL mismatch detected — wiping directory and cloning fresh', {
            expected: normalizedExpected,
            existing: normalizedExisting,
            targetDir,
          });
          fs.rmSync(targetDir, { recursive: true, force: true });
          fs.mkdirSync(targetDir, { recursive: true });
          await ExecutionEngine.spawnAsync('git', ['clone', '-b', branch, repoUrl, targetDir]);
          return;
        }
      } catch (err) {
        logger.warn(MOD, 'Failed to verify remote URL — treating as corrupted, wiping and cloning fresh', { err, targetDir });
        fs.rmSync(targetDir, { recursive: true, force: true });
        fs.mkdirSync(targetDir, { recursive: true });
        await ExecutionEngine.spawnAsync('git', ['clone', '-b', branch, repoUrl, targetDir]);
        return;
      }

      // Remote URL matches — safe to reuse
      logger.info(MOD, 'Remote URL verified, resetting and pulling latest', { targetDir, branch });
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
   * Detect whether `xvfb-run` is available on the host. When present we wrap the
   * Playwright command with it so customer configs that use `headless: false`
   * (no `$DISPLAY` in a CI/Docker runner) still launch a browser instead of
   * crashing at startup with "Missing X server or $DISPLAY".
   */
  private static hasXvfb(): boolean {
    try {
      const { execSync } = require('child_process');
      execSync('command -v xvfb-run', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Synchronous run method (backward compatible for orchestrator).
   * Always uses `npx playwright test` to resolve both local and global playwright.
   *
   * ROBUSTNESS: We MUST NOT rely on the customer's playwright.config providing a
   * JSON reporter or headless mode — arbitrary repos won't. So we:
   *   1. Force `--reporter=json` and point its output at `test-results.json` via
   *      `PLAYWRIGHT_JSON_OUTPUT_NAME` (writes a FILE, not stdout). This overrides
   *      whatever reporters the repo configured (e.g. html-only) so artifact
   *      collection always has a results file to parse.
   *   2. Wrap the command in `xvfb-run -a` when available, so configs that set
   *      `headless: false` still run under a virtual X server instead of failing
   *      to launch the browser in a headless runner.
   */
  static run(repoPath: string, testFile?: string, grepFilter?: string, timeoutMs: number = DEFAULT_RERUN_TIMEOUT_MS): RunResult {
    const { execSync } = require('child_process');
    const resultsFile = path.join(repoPath, 'test-results.json');
    const startTime = new Date().toISOString();
    const start = Date.now();

    // Force the JSON reporter to a known file regardless of the repo's config.
    // PLAYWRIGHT_JSON_OUTPUT_NAME makes the json reporter write to a file (it
    // would otherwise stream JSON to stdout when invoked via --reporter=json).
    let cmd = testFile
      ? `npx playwright test "${testFile}" --reporter=json`
      : `npx playwright test --reporter=json`;

    // --grep isolates a single test by name for efficient per-test reruns
    if (grepFilter) {
      cmd += ` --grep "${grepFilter.replace(/"/g, '\\"')}"`;
    }

    // Wrap with xvfb-run so `headless: false` configs work without a real display.
    const useXvfb = ExecutionEngine.hasXvfb();
    if (useXvfb) {
      cmd = `xvfb-run -a ${cmd}`;
    }

    logger.info(MOD, 'Executing Playwright tests (sync)', { repoPath, cmd, useXvfb });

    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    try {
      stdout = execSync(cmd, {
        cwd: repoPath,
        encoding: 'utf-8',
        env: {
          ...process.env,
          // Write the JSON report to repoPath/test-results.json (relative to cwd).
          PLAYWRIGHT_JSON_OUTPUT_NAME: 'test-results.json',
        },
        timeout: timeoutMs, // configurable per-test rerun timeout (default 120s)
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

    // Defensive fallback: if the forced JSON reporter still didn't create the
    // file (e.g. a fatal startup crash before the reporter initialised), try to
    // recover JSON that may have been streamed to stdout instead.
    if (!fs.existsSync(resultsFile)) {
      logger.warn(MOD, 'test-results.json not found after forced json reporter', {
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
        stderrSample: stderr.slice(0, 300),
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
   * Non-blocking async variant of {@link run}. Behaves identically (forced JSON
   * reporter, optional --grep isolation, xvfb wrapping, stdout-JSON fallback) but
   * uses `spawn` instead of `execSync` so it NEVER blocks the Node event loop.
   *
   * Why this matters: the healing worker reruns a single test many times inside
   * nested retry loops. With the old blocking execSync, the entire server (status
   * polling, the Cancel endpoint, health checks) froze for the duration of every
   * rerun, and a hung test held the loop hostage for the full timeout. Running the
   * rerun async keeps the API responsive and lets the worker honor cancellation
   * and wall-clock budgets between reruns.
   *
   * On timeout the child is killed (SIGTERM → SIGKILL) and exitCode 124 is
   * returned, matching shell timeout semantics.
   */
  static async runAsync(
    repoPath: string,
    testFile?: string,
    grepFilter?: string,
    timeoutMs: number = DEFAULT_RERUN_TIMEOUT_MS,
  ): Promise<RunResult> {
    const { spawn } = require('child_process');
    const resultsFile = path.join(repoPath, 'test-results.json');
    const startTime = new Date().toISOString();
    const start = Date.now();

    let cmd = testFile
      ? `npx playwright test "${testFile}" --reporter=json`
      : `npx playwright test --reporter=json`;
    if (grepFilter) {
      cmd += ` --grep "${grepFilter.replace(/"/g, '\\"')}"`;
    }
    if (ExecutionEngine.hasXvfb()) {
      cmd = `xvfb-run -a ${cmd}`;
    }

    logger.info(MOD, 'Executing Playwright tests (async/non-blocking)', { repoPath, cmd, timeoutMs });

    const { exitCode, stdout, stderr } = await new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve) => {
      // `detached: true` puts the child (the `sh -c` wrapper) into its OWN process
      // group. Playwright spawns its own child processes (browsers, workers); if we
      // only SIGTERM the shell, those grandchildren survive AND keep the stdout pipe
      // open, so the 'close' event never fires until they finish on their own — i.e.
      // the timeout would not actually free the slot. Signalling the whole process
      // group (negative PID) tears down the entire tree promptly.
      const child = spawn(cmd, {
        cwd: repoPath,
        shell: true,
        detached: true,
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: 'test-results.json' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let out = '';
      let err = '';
      let timedOut = false;
      let settled = false;

      const killGroup = (sig: NodeJS.Signals) => {
        try {
          if (child.pid) process.kill(-child.pid, sig); // negative PID = whole group
          else child.kill(sig);
        } catch {
          try { child.kill(sig); } catch { /* noop */ }
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        logger.warn(MOD, 'Async rerun timed out — killing process group', { timeoutMs, cmd });
        killGroup('SIGTERM');
        // Hard-kill the group if it ignores SIGTERM.
        setTimeout(() => killGroup('SIGKILL'), 5_000);
      }, timeoutMs);

      child.stdout?.on('data', (d: Buffer) => {
        const t = d.toString();
        // Cap captured stdout to ~10MB to avoid unbounded memory growth.
        if (out.length < 10_000_000) out += t;
      });
      child.stderr?.on('data', (d: Buffer) => {
        const t = d.toString();
        if (err.length < 2_000_000) err += t;
      });

      const finish = (code: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ exitCode: timedOut ? 124 : code, stdout: out, stderr: err });
      };

      child.on('close', (code: number | null) => finish(code ?? (timedOut ? 124 : 1)));
      child.on('error', (e: Error) => {
        err += `\n${e.message}`;
        finish(1);
      });
    });

    const endTime = new Date().toISOString();
    const durationMs = Date.now() - start;

    // Same stdout-JSON fallback as the sync path.
    if (!fs.existsSync(resultsFile)) {
      const trimmed = stdout.trim();
      if (trimmed.startsWith('{')) {
        try {
          JSON.parse(trimmed);
          fs.writeFileSync(resultsFile, trimmed, 'utf-8');
          logger.info(MOD, 'Wrote test-results.json from stdout (async)');
        } catch {
          logger.warn(MOD, 'Async stdout is not valid JSON');
        }
      }
    }

    if (exitCode === 124) {
      logger.warn(MOD, 'Async Playwright run hit timeout', { repoPath, durationMs, timeoutMs });
    }

    logger.info(MOD, 'Playwright execution complete (async)', {
      exitCode, durationMs, resultsFile, resultsFileExists: fs.existsSync(resultsFile),
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
