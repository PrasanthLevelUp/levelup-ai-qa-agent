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
 *
 * Repo can be supplied either as `owner` + `repo` OR a single `repoUrl`
 * (e.g. github.com/Owner/Repo.git) which is parsed server-side.
 *
 * Uses the per-user/company GitHub PAT (notification_configs) via GitHubService.
 * The token is NEVER returned or logged.
 */

import { Router, type Request, type Response } from 'express';
import { GitHubService, parseGitHubRepoUrl } from '../../integrations/github-service';
import { getPool } from '../../db/postgres';
import { logger } from '../../utils/logger';

const MOD = 'github-actions-routes';

/** Mask a secret for safe diagnostics: prefix + suffix + length, never the full value. */
function maskSecret(val: unknown): { present: boolean; length: number; preview: string } {
  if (typeof val !== 'string' || val.length === 0) {
    return { present: false, length: 0, preview: '(none)' };
  }
  const preview = val.length > 8 ? `${val.slice(0, 4)}…${val.slice(-4)}` : '••••';
  return { present: true, length: val.length, preview };
}

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

  /* ── Step-by-step diagnostics ───────────────────────────────────────
   * TEMPORARY (read-only) endpoint to prove exactly which step in the
   * workflow-loading path fails. Walks: request context → DB rows →
   * old exact-match query → new COALESCE query → token resolution →
   * GitHub API. Tokens are ALWAYS masked. Safe to run in prod.
   *
   *   GET /api/github/actions/_diagnose?owner=&repo=  (or ?repoUrl=)
   * ------------------------------------------------------------------ */
  router.get('/_diagnose', async (req: Request, res: Response) => {
    const steps: any[] = [];
    const companyId = (req as any).companyId as number | undefined;
    const userId = (req as any).userId as number | undefined;

    const target = resolveOwnerRepo(req.query, res);
    if (!target) return; // resolveOwnerRepo already wrote a 400

    /* Step 0 — request context actually seen by the backend */
    steps.push({
      step: 0,
      name: 'request-context',
      ok: true,
      detail: {
        companyId: companyId ?? null,
        userId: userId ?? null,
        hasSessionCookie: Boolean(req.headers.cookie && /levelup_session=/.test(String(req.headers.cookie))),
        apiKeyName: (req as any).apiKeyName ?? null,
        owner: target.owner,
        repo: target.repo,
      },
    });

    try {
      const pool = getPool();

      /* Step 1 — raw dump of ALL github rows (what context is the token stored under?) */
      const rawRows = await pool.query(
        `SELECT id, tool_type, company_id, user_id, status, updated_at,
                config->>'token' AS token
           FROM notification_configs
          WHERE tool_type = 'github'
          ORDER BY updated_at DESC`,
      );
      steps.push({
        step: 1,
        name: 'db-raw-github-rows',
        ok: rawRows.rows.length > 0,
        detail: {
          rowCount: rawRows.rows.length,
          rows: rawRows.rows.map((r: any) => ({
            id: r.id,
            company_id: r.company_id,
            user_id: r.user_id,
            status: r.status,
            updated_at: r.updated_at,
            token: maskSecret(r.token),
          })),
          note: rawRows.rows.length === 0
            ? 'No github row exists at all — token was never saved.'
            : 'Compare company_id/user_id below against the request-context values in step 0.',
        },
      });

      /* Step 2 — OLD exact-match query (faithful replica of the pre-fix logic) */
      const oldParams: any[] = ['github'];
      const oldWhere: string[] = [`tool_type = $1`];
      if (companyId != null) { oldParams.push(companyId); oldWhere.push(`company_id = $${oldParams.length}`); }
      if (userId != null) { oldParams.push(userId); oldWhere.push(`user_id = $${oldParams.length}`); }
      const oldRes = await pool.query(
        `SELECT id, company_id, user_id, config->>'token' AS token
           FROM notification_configs
          WHERE ${oldWhere.join(' AND ')}
          ORDER BY updated_at DESC LIMIT 1`,
        oldParams,
      );
      const oldRow = oldRes.rows[0] || null;
      steps.push({
        step: 2,
        name: 'old-exact-match-query',
        ok: Boolean(oldRow),
        detail: {
          sqlWhere: oldWhere.join(' AND '),
          params: oldParams,
          found: Boolean(oldRow),
          matchedRow: oldRow ? { id: oldRow.id, company_id: oldRow.company_id, user_id: oldRow.user_id, token: maskSecret(oldRow.token) } : null,
        },
      });

      /* Step 3 — NEW COALESCE query (faithful replica of the post-fix logic) */
      const newRes = await pool.query(
        `SELECT id, company_id, user_id, config->>'token' AS token
           FROM notification_configs
          WHERE tool_type = $1
            AND COALESCE(company_id, 0) = $2
            AND COALESCE(user_id, 0) = $3
          ORDER BY updated_at DESC LIMIT 1`,
        ['github', companyId ?? 0, userId ?? 0],
      );
      const newRow = newRes.rows[0] || null;
      steps.push({
        step: 3,
        name: 'new-coalesce-query',
        ok: Boolean(newRow),
        detail: {
          params: ['github', companyId ?? 0, userId ?? 0],
          found: Boolean(newRow),
          matchedRow: newRow ? { id: newRow.id, company_id: newRow.company_id, user_id: newRow.user_id, token: maskSecret(newRow.token) } : null,
        },
      });

      /* Step 4 — what the LIVE getToken() actually returns right now */
      const github = new GitHubService();
      const liveToken = await github.getToken(companyId, userId);
      steps.push({
        step: 4,
        name: 'live-getToken',
        ok: Boolean(liveToken),
        detail: {
          token: maskSecret(liveToken),
          note: liveToken ? 'getToken resolved a token.' : 'getToken returned null — listWorkflows will report "GitHub not connected".',
        },
      });

      /* Step 5 — live listWorkflows() (full service path the UI uses) */
      const wfResult = await github.listWorkflows(target.owner, target.repo, companyId, userId);
      steps.push({
        step: 5,
        name: 'live-listWorkflows',
        ok: !wfResult.error && wfResult.workflows.length > 0,
        detail: {
          error: wfResult.error ?? null,
          workflowCount: wfResult.workflows.length,
          workflows: wfResult.workflows.map((w) => ({ name: w.name, path: w.path, state: w.state })),
        },
      });

      /* Step 6 — raw GitHub API call (isolate API/permissions from our parsing) */
      let rawApi: any = { skipped: true, reason: 'no token available' };
      const apiToken = liveToken || newRow?.token || oldRow?.token || null;
      if (apiToken) {
        const apiRes = await fetch(
          `https://api.github.com/repos/${target.owner}/${target.repo}/actions/workflows?per_page=100`,
          { headers: { Authorization: `Bearer ${apiToken}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'LevelUp-AI-QA-Agent/2.0' } },
        );
        const apiData: any = await apiRes.json().catch(() => ({}));
        rawApi = {
          httpStatus: apiRes.status,
          ok: apiRes.ok,
          totalCount: apiData.total_count ?? null,
          message: apiData.message ?? null,
          workflows: Array.isArray(apiData.workflows)
            ? apiData.workflows.map((w: any) => ({ name: w.name, path: w.path, state: w.state }))
            : null,
        };
      }
      steps.push({ step: 6, name: 'raw-github-api', ok: rawApi.ok === true, detail: rawApi });

      /* Diagnosis — first failing step */
      const firstFail = steps.find((s) => s.ok === false);
      const diagnosis = !firstFail
        ? 'All steps passed — workflows resolved successfully.'
        : `First failing step: #${firstFail.step} (${firstFail.name}).`;

      // Determine whether the COALESCE change is the proven root cause:
      // old query fails but new query succeeds AND the API would return workflows.
      const sqlIsRootCause =
        steps[2] && steps[3] &&
        steps[2].ok === false && steps[3].ok === true;

      res.json({
        success: true,
        diagnosis,
        sqlIsRootCause,
        steps,
      });
    } catch (err: any) {
      logger.error(MOD, 'GET /_diagnose error', { error: err.message });
      res.status(500).json({ success: false, error: err.message, stepsSoFar: steps });
    }
  });

  return router;
}
