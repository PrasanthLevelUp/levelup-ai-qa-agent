/**
 * GitHubActionsExecutionProvider — runs the customer's EXISTING GitHub Actions
 * workflow as a first-class execution source, then materializes the same
 * canonical {@link ExecutionResult} a Local Runner execution produces.
 *
 * ── Flow (execute) ─────────────────────────────────────────────────────────
 *   1. dispatch the chosen workflow via `workflow_dispatch`
 *   2. correlate the dispatch to its run, then poll until the run completes
 *   3. download + extract the run's uploaded artifacts (Playwright results)
 *   4. clone the repo locally (diagnosis reads source; Hybrid validation reruns
 *      here) and drop the CI `test-results.json` into the clone as the canonical
 *      results file
 *   5. assemble an ExecutionResult whose exitCode reflects the run's conclusion
 *      and whose records/artifacts are parsed from the CI results
 *
 * From step 5 onward the rest of LevelUp AI behaves IDENTICALLY to a local run —
 * the source is an implementation detail below ExecutionResult.
 *
 * ── Hybrid validation ──────────────────────────────────────────────────────
 * `validate()` delegates to the Local Runner (via LocalExecutionProvider) so a
 * locator fix confirms in seconds rather than a multi-minute CI round-trip. The
 * seam is deliberately designed so a future "validate remotely" mode is a
 * provider-internal change with no impact on the healing pipeline.
 */
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../../utils/logger';
import { ExecutionEngine, type RunResult } from '../../execution-engine';
import { GitHubService, parseGitHubRepoUrl } from '../../../integrations/github-service';
import { LocalExecutionProvider } from './local-execution-provider';
import { ingestRunArtifacts, type RemoteArtifact } from './artifact-ingestion';
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

const MOD = 'github-actions-execution-provider';

/** How long to wait for a dispatched run to complete before giving up. */
const DEFAULT_RUN_POLL_ATTEMPTS = Number(process.env['GHA_RUN_POLL_ATTEMPTS'] || 120); // 120 × 5s = 10 min
const DEFAULT_RUN_POLL_INTERVAL_MS = Number(process.env['GHA_RUN_POLL_INTERVAL_MS'] || 5000);

/** Provider-specific config carried in ExecutionContext.providerConfig. */
interface GitHubActionsConfig {
  workflowId: string | number;
  /** Optional dispatch inputs forwarded to the workflow. */
  inputs?: Record<string, string>;
}

export class GitHubActionsExecutionProvider implements ExecutionProvider {
  readonly source: ExecutionSource = 'github_actions';
  private readonly github: GitHubService;
  private readonly local: LocalExecutionProvider;

  constructor(github?: GitHubService, local?: LocalExecutionProvider) {
    this.github = github ?? new GitHubService();
    this.local = local ?? new LocalExecutionProvider();
  }

  async execute(ctx: ExecutionContext): Promise<ExecutionResult> {
    const cfg = (ctx.providerConfig ?? {}) as Partial<GitHubActionsConfig>;
    if (cfg.workflowId === undefined || cfg.workflowId === null || cfg.workflowId === '') {
      throw new ExecutionSetupError('dispatch', 1, 'GitHubActionsExecutionProvider requires providerConfig.workflowId');
    }

    const parsed = parseGitHubRepoUrl(ctx.repoUrl);
    if (!parsed) {
      throw new ExecutionSetupError(
        'dispatch', 1,
        `Could not parse a GitHub owner/repo from "${ctx.repoUrl}". GitHub Actions execution requires a GitHub repository.`,
      );
    }
    const { owner, repo } = parsed;
    const ref = ctx.branch || 'main';
    const startedAt = Date.now();
    // Mark the dispatch window a few seconds in the past to tolerate clock skew.
    const sinceIso = new Date(startedAt - 5000).toISOString();

    // ── 1. Dispatch ──────────────────────────────────────────────────────
    logger.info(MOD, 'Dispatching workflow', { owner, repo, workflowId: cfg.workflowId, ref });
    const dispatch = await this.github.dispatchWorkflow(
      owner, repo, cfg.workflowId, ref, cfg.inputs, ctx.companyId, ctx.userId,
    );
    if (!dispatch.success) {
      throw new ExecutionSetupError('dispatch', 1, `Failed to dispatch workflow: ${dispatch.error}`);
    }

    // ── 2. Correlate + wait for completion ────────────────────────────────
    const found = await this.github.findRunForDispatch(
      owner, repo, cfg.workflowId, ref, sinceIso, ctx.companyId, ctx.userId,
    );
    if (found.error || !found.run) {
      throw new ExecutionSetupError('execute', 1, found.error || 'Dispatched workflow run could not be correlated.');
    }
    const runId = found.run.id;
    logger.info(MOD, 'Run correlated; waiting for completion', { runId, htmlUrl: found.run.htmlUrl });

    const completed = await this.waitForRun(owner, repo, runId, ctx);
    const conclusion = completed.conclusion; // success | failure | cancelled | timed_out | null
    const runUrl = completed.htmlUrl;
    logger.info(MOD, 'Run completed', { runId, conclusion });

    // ── 3. Clone the repo locally (for code context + Hybrid validation) ──
    fs.mkdirSync(path.dirname(ctx.repoPath), { recursive: true });
    await ExecutionEngine.cloneRepository(ctx.repoUrl, ctx.repoPath, ref);
    // Install deps so Hybrid validation reruns can execute immediately.
    try {
      await ExecutionEngine.installDependencies(ctx.repoPath);
    } catch (err) {
      logger.warn(MOD, 'Dependency install failed after CI run (validation reruns may be slower)', {
        error: (err as Error).message,
      });
    }

    // ── 4. Download + ingest artifacts → canonical test-results.json ──────
    const extractDir = path.join(ctx.repoPath, '.levelup', 'gha-artifacts', String(runId));
    const ingested = await this.ingest(owner, repo, runId, extractDir, ctx);
    for (const w of ingested.warnings) logger.warn(MOD, 'Artifact ingestion warning', { runId, warning: w });

    // Place the CI results file at the conventional location the collector reads.
    const canonicalResults = path.join(ctx.repoPath, 'test-results.json');
    if (ingested.resultsFile) {
      try {
        fs.copyFileSync(ingested.resultsFile, canonicalResults);
      } catch (err) {
        logger.warn(MOD, 'Failed to copy CI results into repo path', { error: (err as Error).message });
      }
    }

    // ── 5. Derive exitCode + assemble the canonical result ────────────────
    // 0 ⇒ success/all-passed; non-zero ⇒ there were failures to heal. When we
    // could not obtain a results file we still signal failure so the worker
    // surfaces an actionable message rather than silently "all passed".
    const haveResults = !!ingested.resultsFile && fs.existsSync(canonicalResults);
    const exitCode = conclusion === 'success' ? 0 : 1;

    const providerInfo: ProviderInfo = {
      source: this.source,
      runId,
      runUrl,
      conclusion,
      artifactDir: ingested.extractDir,
    };

    return assembleExecutionResult({
      resultsFile: canonicalResults,
      repoPath: ctx.repoPath,
      exitCode,
      jobId: ctx.jobId ?? String(runId),
      profile: ctx.profile,
      metadata: {
        startTime: new Date(startedAt).toISOString(),
        endTime: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        exitCode,
        stderr: haveResults
          ? ''
          : (ingested.warnings.join('; ') || 'No Playwright results were ingested from the GitHub Actions run.'),
      },
      providerInfo,
    });
  }

  /**
   * Hybrid validation: re-run the healed test locally for speed. Delegates to the
   * Local provider so there is exactly ONE validation implementation across all
   * providers. A future remote-validation mode would override here only.
   */
  async validate(ctx: ValidationContext): Promise<RunResult> {
    return this.local.validate(ctx);
  }

  /** Download + extract the run's artifacts into `destDir`. */
  async downloadArtifacts(info: ProviderInfo, destDir: string, ctx: ExecutionContext): Promise<string | null> {
    const parsed = parseGitHubRepoUrl(ctx.repoUrl);
    if (!parsed || info.runId === undefined) return null;
    const ingested = await this.ingest(parsed.owner, parsed.repo, Number(info.runId), destDir, ctx);
    return ingested.resultsFile;
  }

  /** Locate a Playwright results file inside an already-extracted directory. */
  async collectResults(outcomeDir: string): Promise<string | null> {
    const p = path.join(outcomeDir, 'test-results.json');
    return fs.existsSync(p) ? p : null;
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Poll a run until it reaches `completed` (or the poll budget is exhausted). */
  private async waitForRun(
    owner: string, repo: string, runId: number, ctx: ExecutionContext,
  ): Promise<{ conclusion: string | null; htmlUrl: string }> {
    let htmlUrl = '';
    for (let i = 0; i < DEFAULT_RUN_POLL_ATTEMPTS; i++) {
      const { run, error } = await this.github.getWorkflowRun(owner, repo, runId, ctx.companyId, ctx.userId);
      if (error) throw new ExecutionSetupError('execute', 1, error);
      if (run) {
        htmlUrl = run.htmlUrl;
        if (run.status === 'completed') {
          return { conclusion: run.conclusion, htmlUrl };
        }
      }
      await new Promise((r) => setTimeout(r, DEFAULT_RUN_POLL_INTERVAL_MS));
    }
    throw new ExecutionSetupError('execute', 1, `GitHub Actions run ${runId} did not complete within the polling budget.`);
  }

  /** List → download → extract artifacts for a run. */
  private async ingest(owner: string, repo: string, runId: number, destDir: string, ctx: ExecutionContext) {
    const { artifacts, error } = await this.github.listRunArtifacts(owner, repo, runId, ctx.companyId, ctx.userId);
    if (error) {
      logger.warn(MOD, 'Failed to list run artifacts', { runId, error });
    }
    const remote: RemoteArtifact[] = (artifacts || []).map(a => ({
      id: a.id, name: a.name, archiveDownloadUrl: a.archiveDownloadUrl, expired: a.expired,
    }));
    return ingestRunArtifacts(
      remote,
      (art) => this.github.downloadArtifactZip(
        { id: art.id, archiveDownloadUrl: art.archiveDownloadUrl }, owner, repo, ctx.companyId, ctx.userId,
      ),
      destDir,
    );
  }
}
