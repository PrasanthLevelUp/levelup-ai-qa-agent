/**
 * LocalExecutionProvider — the Local Runner expressed as an ExecutionProvider
 * that owns the WHOLE execution lifecycle.
 *
 * It performs the SAME steps the healing worker has always performed —
 * clone/pull → install → `ExecutionEngine.runAsync` — and then assembles a
 * canonical {@link ExecutionResult}: it parses failure artifacts and builds the
 * finalized pass/skip ExecutionRecords, so the worker receives a complete,
 * source-agnostic result. It introduces NO new behavior and adds NO new failure
 * modes; setup-level failures are raised as {@link ExecutionSetupError} carrying
 * the SAME exit codes the worker surfaced inline before (clone ⇒ 128,
 * install ⇒ 127), preserving the exact operator-facing messages.
 *
 * Because the Local Runner's results are already on the local disk, the
 * `downloadArtifacts`/`collectResults` steps are trivial: there is nothing to
 * download, and the results file is exactly where the runner wrote it.
 */
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../../../utils/logger';
import { ExecutionEngine, type RunResult } from '../../execution-engine';
import {
  assembleExecutionResult,
  ExecutionSetupError,
  type ExecutionResult,
  type ProviderInfo,
} from '../execution-result';
import type {
  ExecutionProvider,
  ExecutionContext,
  ValidationContext,
  ExecutionSource,
} from '../execution-provider';

const MOD = 'local-execution-provider';

export class LocalExecutionProvider implements ExecutionProvider {
  readonly source: ExecutionSource = 'local';

  /**
   * Clone/pull → install → run the suite locally, then assemble the canonical
   * {@link ExecutionResult} (artifacts + finalized pass/skip records included),
   * exactly as the worker did inline before.
   */
  async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
    const { repoUrl, branch, repoPath, testFile, profile, collectHealingArtifacts, budgetMs } = ctx;

    // Step 1 — clone/pull. MUST succeed unless a usable clone already exists on
    // disk, mirroring the worker's original behavior byte-for-byte: a clone
    // failure is fatal ONLY when there is no package.json to fall back to.
    fs.mkdirSync(path.dirname(repoPath), { recursive: true });
    try {
      await ExecutionEngine.cloneRepository(repoUrl, repoPath, branch);
      const testsDir = path.join(repoPath, 'tests');
      const pkgFile = path.join(repoPath, 'package.json');
      const testFiles = fs.existsSync(testsDir)
        ? fs.readdirSync(testsDir).filter((f) => f.endsWith('.spec.ts') || f.endsWith('.test.ts'))
        : [];
      logger.info(MOD, 'Repository ready', {
        repoPath,
        hasTestsDir: fs.existsSync(testsDir),
        testFileCount: testFiles.length,
        testFiles: testFiles.slice(0, 10),
        hasPackageJson: fs.existsSync(pkgFile),
      });
    } catch (error) {
      const errMsg = (error as Error).message;
      logger.error(MOD, 'Clone/pull FAILED', { error: errMsg, repoUrl, repoPath });
      if (!fs.existsSync(path.join(repoPath, 'package.json'))) {
        throw new ExecutionSetupError(
          'clone', 128,
          `Repository clone/pull failed: ${errMsg}. Verify the repo URL is accessible and the branch exists.`,
        );
      }
      logger.warn(MOD, 'Clone failed but repo directory exists, continuing with existing code', { repoPath });
    }

    // Step 2 — install dependencies. MUST succeed before running tests.
    try {
      await ExecutionEngine.installDependencies(repoPath);
    } catch (error) {
      const errMsg = (error as Error).message;
      logger.error(MOD, 'Dependency install FAILED — cannot proceed with test execution', { error: errMsg, repoPath });
      throw new ExecutionSetupError(
        'install', 127,
        `Dependency installation failed: ${errMsg}. Check that the repository has a valid package.json and npm install can succeed.`,
      );
    }

    // Step 3 — run the suite (non-blocking, budget-bounded). Initial run is NOT a
    // healing run, mirroring the worker's original call exactly.
    const run = await ExecutionEngine.runAsync(
      repoPath,
      testFile,
      undefined,
      budgetMs,
      profile,
      collectHealingArtifacts,
      false,
    );

    logger.info(MOD, 'Local execution complete', {
      repoPath, exitCode: run.exitCode, resultsFile: run.resultsFile,
    });

    // Step 4 — assemble the canonical result (parse artifacts + build records).
    const providerInfo: ProviderInfo = { source: this.source };
    return assembleExecutionResult({
      resultsFile: run.resultsFile,
      repoPath,
      exitCode: run.exitCode,
      jobId: ctx.jobId ?? 'local',
      profile,
      metadata: {
        startTime: run.startTime ?? new Date().toISOString(),
        endTime: run.endTime ?? new Date().toISOString(),
        durationMs: run.durationMs ?? 0,
        exitCode: run.exitCode,
        stdout: run.stdout,
        stderr: run.stderr,
      },
      providerInfo,
    });
  }

  /**
   * Re-run a single test locally to confirm a fix. This is the canonical fast
   * validation path the Hybrid model uses for ALL providers.
   */
  async validate(ctx: ValidationContext): Promise<RunResult> {
    return ExecutionEngine.runAsync(
      ctx.repoPath,
      ctx.testFile,
      ctx.grepFilter,
      ctx.budgetMs,
      ctx.profile,
      ctx.collectHealingArtifacts ?? true,
      ctx.isHealingRun ?? true,
    );
  }

  /** No-op: local artifacts are already on disk. */
  async downloadArtifacts(_info: ProviderInfo, _destDir: string, _ctx: ExecutionContext): Promise<string | null> {
    return null;
  }

  /** The results file the local runner writes is the repo's `test-results.json`. */
  async collectResults(outcomeDir: string): Promise<string | null> {
    const p = path.join(outcomeDir, 'test-results.json');
    return fs.existsSync(p) ? p : null;
  }
}
