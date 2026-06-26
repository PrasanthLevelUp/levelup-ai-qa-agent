/**
 * LocalExecutionProvider — the Local Runner expressed as an ExecutionProvider.
 *
 * This is a thin, behavior-preserving wrapper around the SAME steps the healing
 * worker has always performed: clone/pull → install → `ExecutionEngine.runAsync`.
 * It introduces NO new behavior and adds NO new failure modes — it simply puts a
 * stable seam around the existing logic so GitHub Actions (and future providers)
 * can be swapped in below `ExecutionOutcome` without the pipeline noticing.
 *
 * Because the Local Runner's results are already on the local disk, the
 * `downloadArtifacts`/`collectResults` steps are trivial: there is nothing to
 * download, and the results file is exactly where the runner wrote it.
 */
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../../../utils/logger';
import { ExecutionEngine, type RunResult } from '../../execution-engine';
import type {
  ExecutionProvider,
  ExecutionContext,
  ExecutionOutcome,
  ValidationContext,
  ExecutionProviderRef,
  ExecutionSource,
} from '../execution-provider';

const MOD = 'local-execution-provider';

export class LocalExecutionProvider implements ExecutionProvider {
  readonly source: ExecutionSource = 'local';

  /**
   * Clone/pull → install → run the suite locally, exactly as the worker does
   * today. Returns the canonical {@link ExecutionOutcome} pointing at the local
   * test-results.json and repo clone.
   */
  async execute(ctx: ExecutionContext): Promise<ExecutionOutcome> {
    const { repoUrl, branch, repoPath, testFile, profile, collectHealingArtifacts, budgetMs } = ctx;

    // Step 1 — clone/pull (idempotent; ExecutionEngine handles reuse + tenant safety).
    fs.mkdirSync(path.dirname(repoPath), { recursive: true });
    await ExecutionEngine.cloneRepository(repoUrl, repoPath, branch);

    // Step 2 — install dependencies.
    await ExecutionEngine.installDependencies(repoPath);

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

    return {
      resultsFile: run.resultsFile,
      repoPath,
      exitCode: run.exitCode,
      source: this.source,
      startTime: run.startTime,
      endTime: run.endTime,
      durationMs: run.durationMs,
      stdout: run.stdout,
      stderr: run.stderr,
    };
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
  async downloadArtifacts(_ref: ExecutionProviderRef, _destDir: string, _ctx: ExecutionContext): Promise<string | null> {
    return null;
  }

  /** The results file the local runner writes is the repo's `test-results.json`. */
  async collectResults(outcomeDir: string): Promise<string | null> {
    const p = path.join(outcomeDir, 'test-results.json');
    return fs.existsSync(p) ? p : null;
  }
}
