/**
 * GitHub Actions API Routes — Execution Mode 2 (Existing CI Integration)
 *
 * Lets LevelUp AI plug into a customer's existing GitHub Actions instead of
 * running its own engine:
 *
 *   GET  /api/github/actions/workflows                 — list .github/workflows
 *   POST /api/github/actions/dispatch                  — trigger via workflow_dispatch
 *   GET  /api/github/actions/runs/:runId               — poll a run's status
 *   GET  /api/github/actions/runs/:runId/artifacts     — list a run's artifacts
 *   POST /api/github/actions/runs/:runId/record        — record a finished run's
 *                                                        tests (pass+fail) as
 *                                                        execution records
 *
 * Repo can be supplied either as `owner` + `repo` OR a single `repoUrl`
 * (e.g. github.com/Owner/Repo.git) which is parsed server-side.
 *
 * Uses the per-user/company GitHub PAT (notification_configs) via GitHubService.
 * The token is NEVER returned or logged.
 */

import { Router, type Request, type Response } from 'express';
import { GitHubService, parseGitHubRepoUrl } from '../../integrations/github-service';
import { logger } from '../../utils/logger';
import { recordRunAsExecutions } from '../../core/execution/record-run-executions';
import { getProjectIdForRepo } from '../../db/postgres';
import { isExecutionProfile } from '../../core/execution/execution-profile';
import { runHealingEnvironmentDiagnostic } from '../../core/diagnostics/healing-environment-diagnostic';

const MOD = 'github-actions-routes';

/**
 * Resolve { owner, repo } from the request. Accepts `owner`+`repo` (query or
 * body) or a single `repoUrl`. Returns null and writes a 400 response if it
 * cannot be resolved.
 */
function resolveOwnerRepo(
  src: Record<string, any>,
  res: Response,
): { owner: string; repo: string } | null {
  const owner = src.owner ? String(src.owner) : '';
  const repo = src.repo ? String(src.repo) : '';
  if (owner && repo) return { owner, repo };

  const repoUrl = src.repoUrl ? String(src.repoUrl) : '';
  if (repoUrl) {
    const parsed = parseGitHubRepoUrl(repoUrl);
    if (parsed) return parsed;
    res.status(400).json({ success: false, error: `Could not parse a GitHub owner/repo from "${repoUrl}".` });
    return null;
  }

  res.status(400).json({ success: false, error: 'Provide owner+repo or a repoUrl.' });
  return null;
}

export function createGitHubActionsRouter(): Router {
  const router = Router();
  const github = new GitHubService();

  /* ── Healing environment diagnostic ─────────────────────────────────
   * GET /api/github/actions/diagnose?repoUrl=github.com/Owner/Repo.git[&branch=main][&testFile=foo.spec.ts]
   *
   * Runs the real healing toolchain (env probe → xvfb smoke → clone → install →
   * playwright --list → execute one spec) INSIDE this container and returns a
   * stage-by-stage report. Use this to see exactly WHY healing fails in prod
   * instead of inferring it from the UI. Read-only: clones to a temp dir and
   * cleans up. The GitHub token is used for cloning but never returned/logged.
   */
  router.get('/diagnose', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const userId = (req as any).userId as number | undefined;
      const target = resolveOwnerRepo(req.query, res);
      if (!target) return;

      const branch = req.query.branch ? String(req.query.branch) : 'main';
      const testFile = req.query.testFile ? String(req.query.testFile) : undefined;

      // Best-effort token for private repos; diagnostic still runs for public.
      let token: string | null = null;
      try {
        token = await github.getToken(companyId, userId);
      } catch {
        token = null;
      }

      logger.info(MOD, 'GET /diagnose start', { owner: target.owner, repo: target.repo, branch, hasToken: !!token });
      const report = await runHealingEnvironmentDiagnostic({
        owner: target.owner,
        repo: target.repo,
        branch,
        token,
        testFile,
      });
      logger.info(MOD, 'GET /diagnose done', { ok: report.ok, verdict: report.verdict, durationMs: report.totalDurationMs });

      // 200 even when ok=false: the diagnostic SUCCEEDED at finding the problem.
      res.json({ success: true, data: report });
    } catch (err: any) {
      logger.error(MOD, 'GET /diagnose error', { error: err.message });
      res.status(500).json({ success: false, error: err?.message || 'Diagnostic failed to run' });
    }
  });

  /* ── List workflows ─────────────────────────────────────────────── */
  router.get('/workflows', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const userId = (req as any).userId as number | undefined;
      const target = resolveOwnerRepo(req.query, res);
      if (!target) return;

      const result = await github.listWorkflows(target.owner, target.repo, companyId, userId);
      if (result.error) {
        res.status(400).json({ success: false, error: result.error });
        return;
      }
      res.json({ success: true, data: result.workflows });
    } catch (err: any) {
      logger.error(MOD, 'GET /workflows error', { error: err.message });
      res.status(500).json({ success: false, error: 'Failed to list workflows' });
    }
  });

  /* ── Dispatch a workflow ────────────────────────────────────────── */
  router.post('/dispatch', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const userId = (req as any).userId as number | undefined;
      const target = resolveOwnerRepo(req.body, res);
      if (!target) return;

      const { workflowId, ref, inputs } = req.body as {
        workflowId?: string | number;
        ref?: string;
        inputs?: Record<string, string>;
      };

      if (workflowId == null || workflowId === '') {
        res.status(400).json({ success: false, error: 'workflowId is required (numeric id or file name).' });
        return;
      }
      const refToUse = (ref && String(ref).trim()) || 'main';

      // Record the dispatch time slightly in the past to avoid clock skew when
      // correlating the created run via the `created:>=` filter.
      const sinceIso = new Date(Date.now() - 60_000).toISOString();

      const dispatch = await github.dispatchWorkflow(
        target.owner, target.repo, workflowId, refToUse, inputs, companyId, userId,
      );
      if (!dispatch.success) {
        res.status(400).json({ success: false, error: dispatch.error });
        return;
      }

      // Best-effort: correlate the dispatch to its run so the UI can poll it.
      const { run, error: correlateError } = await github.findRunForDispatch(
        target.owner, target.repo, workflowId, refToUse, sinceIso, companyId, userId,
        { attempts: 6, intervalMs: 1500 },
      );

      res.json({
        success: true,
        data: {
          dispatched: true,
          ref: refToUse,
          run: run ?? null,
          // Not an error — the run just hasn't been indexed yet; the UI can fall
          // back to listing recent runs.
          note: run ? undefined : (correlateError || 'Run dispatched; it may take a few seconds to appear.'),
        },
      });
    } catch (err: any) {
      logger.error(MOD, 'POST /dispatch error', { error: err.message });
      res.status(500).json({ success: false, error: 'Failed to dispatch workflow' });
    }
  });

  /* ── Poll a run's status ────────────────────────────────────────── */
  router.get('/runs/:runId', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const userId = (req as any).userId as number | undefined;
      const target = resolveOwnerRepo(req.query, res);
      if (!target) return;

      const runId = parseInt(String(req.params.runId), 10);
      if (isNaN(runId)) {
        res.status(400).json({ success: false, error: 'Invalid runId.' });
        return;
      }

      const result = await github.getWorkflowRun(target.owner, target.repo, runId, companyId, userId);
      if (result.error) {
        res.status(400).json({ success: false, error: result.error });
        return;
      }
      res.json({ success: true, data: result.run });
    } catch (err: any) {
      logger.error(MOD, 'GET /runs/:runId error', { error: err.message });
      res.status(500).json({ success: false, error: 'Failed to get workflow run' });
    }
  });

  /* ── List a run's artifacts ─────────────────────────────────────── */
  router.get('/runs/:runId/artifacts', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const userId = (req as any).userId as number | undefined;
      const target = resolveOwnerRepo(req.query, res);
      if (!target) return;

      const runId = parseInt(String(req.params.runId), 10);
      if (isNaN(runId)) {
        res.status(400).json({ success: false, error: 'Invalid runId.' });
        return;
      }

      const result = await github.listRunArtifacts(target.owner, target.repo, runId, companyId, userId);
      if (result.error) {
        res.status(400).json({ success: false, error: result.error });
        return;
      }
      res.json({ success: true, data: result.artifacts });
    } catch (err: any) {
      logger.error(MOD, 'GET /runs/:runId/artifacts error', { error: err.message });
      res.status(500).json({ success: false, error: 'Failed to list run artifacts' });
    }
  });

  /* ── Record a finished run as execution records (pass + fail) ────────
     Ingests THIS run's artifacts and persists one execution record per test so
     the run shows up on the Execution / Healing / Jobs screens — without healing
     and without re-running anything. Idempotent per run (upserts in place). */
  router.post('/runs/:runId/record', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const userId = (req as any).userId as number | undefined;
      const target = resolveOwnerRepo(req.body, res);
      if (!target) return;

      const runId = parseInt(String(req.params.runId), 10);
      if (isNaN(runId)) {
        res.status(400).json({ success: false, error: 'Invalid runId.' });
        return;
      }

      // Scope the records to the right project so they land under the active
      // project filter. Resolve from the supplied repoUrl when available.
      const repoUrl = req.body?.repoUrl ? String(req.body.repoUrl) : undefined;
      const projectIdRaw = req.body?.projectId;
      let projectId: number | undefined =
        projectIdRaw != null && Number.isFinite(Number(projectIdRaw)) ? Number(projectIdRaw) : undefined;
      if (projectId == null) {
        const resolved = await getProjectIdForRepo(repoUrl, companyId);
        if (resolved != null) projectId = resolved;
      }

      const profile = isExecutionProfile(req.body?.profile) ? req.body.profile : undefined;

      const summary = await recordRunAsExecutions(github, target.owner, target.repo, runId, {
        companyId, userId, projectId, profile,
      });

      res.json({ success: true, data: summary });
    } catch (err: any) {
      logger.error(MOD, 'POST /runs/:runId/record error', { error: err.message });
      res.status(500).json({ success: false, error: err?.message || 'Failed to record workflow run' });
    }
  });

  return router;
}
