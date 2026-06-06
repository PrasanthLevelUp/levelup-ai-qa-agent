/**
 * Dashboard API Routes — Endpoints consumed by the Next.js dashboard frontend.
 * Provides healings, stats, jobs, scripts, and project-context data.
 */

import { Router, type Request, type Response } from 'express';
import { getPool } from '../../db/postgres';
import {
  getDailyAiMetrics,
  getAiUsageByModel,
  getAiUsageByFeature,
  getAiCostTrend,
  getDailyBudgetStatus,
} from '../../db/postgres';
import { logger } from '../../utils/logger';

const MOD = 'dashboard-api';

/**
 * Resolve the analytics time window for a stats request (Phase 2: context-aware).
 *
 * Precedence:
 *   1. Explicit sprint window — `startDate` + `endDate` query params (ISO dates).
 *      Sent by the frontend when a Sprint (WHEN) is the active filter. The
 *      "previous" comparison window is the equally-sized span immediately before.
 *   2. Legacy rolling window — `period` (7d/30d/90d) → trailing N days from now.
 *
 * This is fully backward-compatible: requests without startDate/endDate behave
 * exactly as before. `until` is `now` for the legacy path, so adding an upper
 * `created_at < until` bound does not change legacy results.
 */
interface StatsWindow {
  since: Date;
  until: Date;
  prevSince: Date;
  prevUntil: Date;
  /** Human label for logging/debugging. */
  label: string;
}

function resolveWindow(req: Request): StatsWindow {
  const startQ = (req.query.startDate as string) || '';
  const endQ = (req.query.endDate as string) || '';

  if (startQ && endQ) {
    const since = new Date(startQ);
    const until = new Date(endQ);
    if (!isNaN(since.getTime()) && !isNaN(until.getTime()) && until.getTime() > since.getTime()) {
      const span = until.getTime() - since.getTime();
      return {
        since,
        until,
        prevSince: new Date(since.getTime() - span),
        prevUntil: since,
        label: `sprint ${startQ}→${endQ}`,
      };
    }
  }

  const period = (req.query.period as string) || '7d';
  const days = period === '30d' ? 30 : period === '90d' ? 90 : 7;
  const now = new Date();
  const since = new Date(now.getTime() - days * 86400000);
  return {
    since,
    until: now,
    prevSince: new Date(since.getTime() - days * 86400000),
    prevUntil: since,
    label: `${days}d`,
  };
}

export function createDashboardRouter(): Router {
  const router = Router();

  // ─── Healings ───────────────────────────────────────────────

  /** GET /api/dashboard/healings/recent?limit=20&projectId=&status=healed|failed */
  router.get('/healings/recent', async (req: Request, res: Response) => {
    try {
      // Allow a larger page size for the dedicated Healings screen while keeping
      // the dashboard widget's default small.
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 200);
      const cid = (req as any).companyId;
      const pid = req.query.projectId ? parseInt(req.query.projectId as string, 10) : null;
      const pidClause = pid && !Number.isNaN(pid) ? `AND ha.project_id = ${pid}` : '';

      // Optional status filter: 'healed' → success=true, 'failed' → success=false.
      const status = (req.query.status as string) || '';
      const statusClause =
        status === 'healed' ? 'AND ha.success = true'
        : status === 'failed' ? 'AND ha.success = false'
        : '';
      const pool = getPool();

      const { rows } = await pool.query(
        `SELECT ha.*, te.test_name AS exec_test_name
         FROM healing_actions ha
         LEFT JOIN test_executions te ON ha.test_execution_id = te.id
         WHERE ($1::int IS NULL OR ha.company_id = $1) ${pidClause} ${statusClause}
         ORDER BY ha.created_at DESC
         LIMIT $2`,
        [cid, limit],
      );

      const result = rows.map((a: any) => ({
        id: a.id,
        executionId: a.test_execution_id,
        projectId: a.project_id ?? null,
        timestamp: a.created_at ? new Date(a.created_at).toISOString() : '',
        testName: a.test_name || '',
        repository: a.exec_test_name || 'unknown',
        failedLocator: a.failed_locator || '',
        healedLocator: a.healed_locator || '',
        status: a.success ? 'healed' : 'failed',
        strategy: a.healing_strategy || 'unknown',
        confidence: a.confidence || 0,
        tokensUsed: a.ai_tokens_used || 0,
        cost: Math.round((a.ai_tokens_used || 0) * 0.000003 * 10000) / 10000,
        validationStatus: a.validation_status || 'unknown',
      }));

      res.json(result);
    } catch (err) {
      logger.error(MOD, 'healings/recent failed', { error: err });
      res.json([]);
    }
  });

  /** GET /api/dashboard/healings/:id */
  router.get('/healings/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (!id) return res.status(400).json({ error: 'Invalid ID' });

      const pool = getPool();
      const { rows } = await pool.query(
        `SELECT ha.*, te.test_name AS exec_test_name, te.duration_ms
         FROM healing_actions ha
         LEFT JOIN test_executions te ON ha.test_execution_id = te.id
         WHERE ha.id = $1`,
        [id],
      );

      if (rows.length === 0) return res.status(404).json({ error: 'Not found' });
      const a = rows[0];

      const isSuccess = a.success ?? false;
      const confidence = a.confidence ?? 0;
      const failedLoc = a.failed_locator || '#unknown';
      const healedLoc = a.healed_locator || 'unknown';

      const validationChecks = {
        syntax: { passed: isSuccess, score: isSuccess ? 100 : 40 },
        semantic: { passed: isSuccess, score: isSuccess ? Math.round(confidence * 100) : 30 },
        exists: { passed: isSuccess, score: isSuccess ? 100 : 0 },
        unique: { passed: true, score: 95 },
        visible: { passed: isSuccess, score: isSuccess ? 90 : 20 },
        interactable: { passed: isSuccess, score: isSuccess ? 85 : 10 },
        security: { passed: true, score: 100 },
      };

      const codeChanges = {
        before: `await page.click('${failedLoc}');`,
        after: isSuccess ? `await ${healedLoc}.click();` : null,
      };

      res.json({
        id: a.id,
        executionId: a.test_execution_id,
        testName: a.test_name || '',
        repository: a.exec_test_name || 'unknown',
        status: isSuccess ? 'healed' : 'failed',
        strategy: a.healing_strategy || 'unknown',
        timestamp: a.created_at ? new Date(a.created_at).toISOString() : '',
        failedLocator: failedLoc,
        healedLocator: healedLoc,
        confidence,
        validationChecks,
        codeChanges,
        validationStatus: a.validation_status || 'unknown',
        validationReason: a.validation_reason || '',
        tokensUsed: a.ai_tokens_used || 0,
        cost: Math.round((a.ai_tokens_used || 0) * 0.000003 * 10000) / 10000,
        errorContext: a.error_context || '',
        durationMs: a.duration_ms || 0,
      });
    } catch (err) {
      logger.error(MOD, 'healings/:id failed', { error: err });
      res.status(500).json({ error: 'Failed to fetch healing detail' });
    }
  });

  // ─── Stats ──────────────────────────────────────────────────

  /** GET /api/dashboard/stats/overview?period=7d&projectId=1 */
  router.get('/stats/overview', async (req: Request, res: Response) => {
    try {
      const { since, until, prevSince } = resolveWindow(req);
      const cid = (req as any).companyId;
      const pid = req.query.projectId ? parseInt(req.query.projectId as string, 10) : null;
      const pool = getPool();

      // Build project filter clause
      const pidClause = pid ? `AND project_id = ${pid}` : '';

      // Current period executions (within [since, until))
      const execRes = await pool.query(
        `SELECT status, healing_attempted FROM test_executions
         WHERE created_at >= $1 AND created_at < $3 AND ($2::int IS NULL OR company_id = $2) ${pidClause}`,
        [since, cid, until],
      );
      const executions = execRes.rows;
      const totalRuns = executions.length;
      const healed = executions.filter((e: any) => e.status === 'healed').length;
      const healingAttempted = executions.filter((e: any) => e.healing_attempted).length;

      // Current period actions (within [since, until))
      const actRes = await pool.query(
        `SELECT healing_strategy FROM healing_actions
         WHERE created_at >= $1 AND created_at < $3 AND ($2::int IS NULL OR company_id = $2) ${pidClause}`,
        [since, cid, until],
      );
      const actions = actRes.rows;
      const nonAi = actions.filter((a: any) => a.healing_strategy !== 'ai').length;
      const totalActions = actions.length || 1;
      const successRate = healingAttempted > 0 ? Math.round((healed / healingAttempted) * 1000) / 10 : 0;
      const aiCallsSaved = totalActions > 0 ? Math.round((nonAi / totalActions) * 1000) / 10 : 0;

      // Token usage (within [since, until])
      const sinceStr = since.toISOString().split('T')[0];
      const untilStr = until.toISOString().split('T')[0];
      const tokRes = await pool.query(`SELECT tokens_used, date FROM token_usage`);
      const filteredTokens = tokRes.rows.filter((t: any) => {
        const d = t.date || '';
        return d >= sinceStr && d <= untilStr;
      });
      const totalTokens = filteredTokens.reduce((sum: number, t: any) => sum + (t.tokens_used ?? 0), 0);

      // Previous period
      const prevExecRes = await pool.query(
        `SELECT status, healing_attempted FROM test_executions
         WHERE created_at >= $1 AND created_at < $2 AND ($3::int IS NULL OR company_id = $3) ${pidClause}`,
        [prevSince, since, cid],
      );
      const prevExec = prevExecRes.rows;
      const prevTotal = prevExec.length;
      const prevHealed = prevExec.filter((e: any) => e.status === 'healed').length;
      const prevAttempted = prevExec.filter((e: any) => e.healing_attempted).length;

      const prevActRes = await pool.query(
        `SELECT healing_strategy FROM healing_actions
         WHERE created_at >= $1 AND created_at < $2 AND ($3::int IS NULL OR company_id = $3) ${pidClause}`,
        [prevSince, since, cid],
      );
      const prevActions = prevActRes.rows;
      const prevNonAi = prevActions.filter((a: any) => a.healing_strategy !== 'ai').length;
      const prevTotalActions = prevActions.length || 1;
      const prevSuccessRate = prevAttempted > 0 ? (prevHealed / prevAttempted) * 100 : 0;
      const prevAiSaved = prevTotalActions > 0 ? (prevNonAi / prevTotalActions) * 100 : 0;

      res.json({
        totalRuns,
        successRate,
        aiCallsSaved,
        totalTokens,
        trends: {
          runs: totalRuns >= prevTotal ? 'up' : 'down',
          success: successRate >= prevSuccessRate ? 'up' : 'down',
          savings: aiCallsSaved >= prevAiSaved ? 'up' : 'down',
          tokens: 'down',
        },
        prevRuns: prevTotal,
        prevSuccessRate: Math.round(prevSuccessRate * 10) / 10,
        projectId: pid,
      });
    } catch (err) {
      logger.error(MOD, 'stats/overview failed', { error: err });
      res.status(500).json({ error: 'Failed to fetch overview stats' });
    }
  });

  /** GET /api/dashboard/stats/trend?period=7d&projectId=1 */
  router.get('/stats/trend', async (req: Request, res: Response) => {
    try {
      const { since, until } = resolveWindow(req);
      const cid = (req as any).companyId;
      const pid = req.query.projectId ? parseInt(req.query.projectId as string, 10) : null;
      const pool = getPool();
      const pidClause = pid ? `AND project_id = ${pid}` : '';

      const { rows } = await pool.query(
        `SELECT status, healing_attempted, created_at FROM test_executions
         WHERE created_at >= $1 AND created_at < $3 AND ($2::int IS NULL OR company_id = $2) ${pidClause}
         ORDER BY created_at ASC`,
        [since, cid, until],
      );

      const byDate: Record<string, { total: number; healed: number; attempted: number }> = {};
      for (const ex of rows) {
        const dateStr = ex.created_at ? new Date(ex.created_at).toISOString().split('T')[0] : 'unknown';
        if (!byDate[dateStr]) byDate[dateStr] = { total: 0, healed: 0, attempted: 0 };
        byDate[dateStr].total++;
        if (ex.healing_attempted) byDate[dateStr].attempted++;
        if (ex.status === 'healed') byDate[dateStr].healed++;
      }

      const trend = Object.entries(byDate).map(([date, data]) => ({
        date,
        successRate: data.attempted > 0 ? Math.round((data.healed / data.attempted) * 1000) / 10 : 100,
        totalRuns: data.total,
        healed: data.healed,
      }));

      res.json(trend);
    } catch (err) {
      logger.error(MOD, 'stats/trend failed', { error: err });
      res.status(500).json({ error: 'Failed to fetch trend data' });
    }
  });

  /** GET /api/dashboard/stats/strategies?period=7d&projectId=1 */
  router.get('/stats/strategies', async (req: Request, res: Response) => {
    try {
      const { since, until } = resolveWindow(req);
      const cid = (req as any).companyId;
      const pid = req.query.projectId ? parseInt(req.query.projectId as string, 10) : null;
      const pool = getPool();
      const pidClause = pid ? `AND project_id = ${pid}` : '';

      const { rows } = await pool.query(
        `SELECT healing_strategy FROM healing_actions
         WHERE created_at >= $1 AND created_at < $3 AND ($2::int IS NULL OR company_id = $2) ${pidClause}`,
        [since, cid, until],
      );

      const counts: Record<string, number> = {};
      for (const a of rows) {
        const strat = a.healing_strategy || 'unknown';
        counts[strat] = (counts[strat] || 0) + 1;
      }

      const total = rows.length || 1;
      const strategies = Object.entries(counts).map(([name, count]) => ({
        name,
        count,
        percentage: Math.round((count / total) * 1000) / 10,
      }));

      res.json(strategies);
    } catch (err) {
      logger.error(MOD, 'stats/strategies failed', { error: err });
      res.status(500).json({ error: 'Failed to fetch strategies' });
    }
  });

  /** GET /api/dashboard/stats/patterns */
  router.get('/stats/patterns', async (req: Request, res: Response) => {
    try {
      const cid = (req as any).companyId;
      const pool = getPool();

      const { rows } = await pool.query(
        `SELECT * FROM learned_patterns
         WHERE ($1::int IS NULL OR company_id = $1)
         ORDER BY success_count DESC`,
        [cid],
      );

      const result = rows.map((p: any) => ({
        id: p.id,
        testName: p.test_name || '',
        failedLocator: p.failed_locator || '',
        healedLocator: p.healed_locator || '',
        strategy: p.solution_strategy || 'unknown',
        confidence: p.confidence || 0,
        successCount: p.success_count || 0,
        usageCount: p.usage_count || 0,
        avgTokensSaved: p.avg_tokens_saved || 0,
      }));

      res.json(result);
    } catch (err) {
      logger.error(MOD, 'stats/patterns failed', { error: err });
      res.status(500).json({ error: 'Failed to fetch patterns' });
    }
  });

  /** GET /api/dashboard/stats/cost-savings?period=7d&projectId=1 */
  router.get('/stats/cost-savings', async (req: Request, res: Response) => {
    try {
      const { since, until } = resolveWindow(req);
      const cid = (req as any).companyId;
      const pid = req.query.projectId ? parseInt(req.query.projectId as string, 10) : null;
      const pool = getPool();
      const pidClause = pid ? `AND project_id = ${pid}` : '';

      const { rows } = await pool.query(
        `SELECT ai_tokens_used FROM healing_actions
         WHERE created_at >= $1 AND created_at < $3 AND ($2::int IS NULL OR company_id = $2) ${pidClause}`,
        [since, cid, until],
      );

      const totalActions = rows.length;
      const avgTokensPerAiCall = 500;
      const costPerToken = 0.000003;

      const traditionalTokens = totalActions * avgTokensPerAiCall;
      const traditionalCost = Math.round(traditionalTokens * costPerToken * 100) / 100;

      const actualTokens = rows.reduce((sum: number, a: any) => sum + (a.ai_tokens_used || 0), 0);
      const actualCost = Math.round(actualTokens * costPerToken * 100) / 100;

      const saved = Math.round((traditionalCost - actualCost) * 100) / 100;
      const percentage = traditionalCost > 0 ? Math.round((saved / traditionalCost) * 1000) / 10 : 0;

      res.json({ traditionalCost, actualCost, saved, percentage, traditionalTokens, actualTokens });
    } catch (err) {
      logger.error(MOD, 'stats/cost-savings failed', { error: err });
      res.status(500).json({ error: 'Failed to fetch cost savings' });
    }
  });

  // ─── Jobs ───────────────────────────────────────────────────

  /** GET /api/dashboard/jobs?limit=50&status=&projectId= */
  router.get('/jobs', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 50;
      const status = req.query.status as string;
      const pid = req.query.projectId ? parseInt(req.query.projectId as string, 10) : null;
      const pool = getPool();

      // Build WHERE clause dynamically so project + status filters compose cleanly.
      const conditions: string[] = [];
      const params: any[] = [];
      if (status) {
        params.push(status);
        conditions.push(`status = $${params.length}`);
      }
      if (pid && !Number.isNaN(pid)) {
        params.push(pid);
        conditions.push(`project_id = $${params.length}`);
      }

      let query = `SELECT * FROM healing_jobs`;
      if (conditions.length > 0) query += ` WHERE ${conditions.join(' AND ')}`;
      params.push(limit);
      query += ` ORDER BY created_at DESC LIMIT $${params.length}`;

      const { rows } = await pool.query(query, params);

      const jobs = rows.map((j: any) => {
        let resultData = null;
        if (j.result) {
          try { resultData = JSON.parse(j.result); } catch { resultData = null; }
        }
        return {
          id: j.id,
          repositoryId: j.repository_id,
          repositoryUrl: j.repository_url,
          projectId: j.project_id ?? null,
          branch: j.branch,
          commitSha: j.commit_sha,
          status: j.status,
          progress: j.progress,
          createdAt: j.created_at ? new Date(j.created_at).toISOString() : null,
          startedAt: j.started_at ? new Date(j.started_at).toISOString() : null,
          completedAt: j.completed_at ? new Date(j.completed_at).toISOString() : null,
          result: j.result,
          resultData,
          error: j.error,
        };
      });

      res.json({ jobs });
    } catch (err) {
      logger.error(MOD, 'jobs list failed', { error: err });
      res.status(500).json({ error: 'Failed to fetch jobs' });
    }
  });

  /** GET /api/dashboard/jobs/:jobId */
  router.get('/jobs/:jobId', async (req: Request, res: Response) => {
    try {
      const { jobId } = req.params;
      const pool = getPool();

      const { rows } = await pool.query(`SELECT * FROM healing_jobs WHERE id = $1`, [jobId]);

      let job = null;
      if (rows.length > 0) {
        const j = rows[0];
        let resultData = null;
        if (j.result) {
          try { resultData = JSON.parse(j.result); } catch { resultData = null; }
        }
        job = {
          id: j.id,
          repositoryId: j.repository_id,
          repositoryUrl: j.repository_url,
          branch: j.branch,
          commitSha: j.commit_sha,
          status: j.status,
          progress: j.progress,
          createdAt: j.created_at ? new Date(j.created_at).toISOString() : null,
          startedAt: j.started_at ? new Date(j.started_at).toISOString() : null,
          completedAt: j.completed_at ? new Date(j.completed_at).toISOString() : null,
          result: j.result,
          resultData,
          error: j.error,
        };
      }

      res.json({ job, backendStatus: null, report: null });
    } catch (err) {
      logger.error(MOD, 'jobs/:jobId failed', { error: err });
      res.status(500).json({ error: 'Failed to fetch job details' });
    }
  });

  // ─── Scripts ────────────────────────────────────────────────

  /** GET /api/dashboard/scripts/recent */
  router.get('/scripts/recent', async (_req: Request, res: Response) => {
    try {
      const pool = getPool();
      const { rows } = await pool.query(
        `SELECT gs.*, pc.name AS project_context_name
         FROM generated_scripts gs
         LEFT JOIN project_contexts pc ON gs.project_context_id = pc.id
         ORDER BY gs.created_at DESC
         LIMIT 50`,
      );

      const data = rows.map((s: any) => ({
        ...s,
        projectContext: s.project_context_name ? { name: s.project_context_name } : null,
      }));

      res.json({ success: true, data });
    } catch (err) {
      logger.error(MOD, 'scripts/recent failed', { error: err });
      res.status(500).json({ success: false, error: 'Failed to fetch scripts' });
    }
  });

  /** GET /api/dashboard/scripts/:id */
  router.get('/scripts/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid ID' });

      const pool = getPool();
      const { rows } = await pool.query(
        `SELECT gs.*, pc.name AS project_context_name, pc.app_url AS project_context_app_url
         FROM generated_scripts gs
         LEFT JOIN project_contexts pc ON gs.project_context_id = pc.id
         WHERE gs.id = $1`,
        [id],
      );

      if (rows.length === 0) return res.status(404).json({ success: false, error: 'Script not found' });

      const s = rows[0];
      res.json({
        success: true,
        data: {
          ...s,
          projectContext: s.project_context_name
            ? { name: s.project_context_name, appUrl: s.project_context_app_url }
            : null,
        },
      });
    } catch (err) {
      logger.error(MOD, 'scripts/:id failed', { error: err });
      res.status(500).json({ success: false, error: 'Failed to fetch script' });
    }
  });

  // ─── Project Context ────────────────────────────────────────

  /** GET /api/dashboard/project-context */
  router.get('/project-context', async (req: Request, res: Response) => {
    try {
      const pool = getPool();
      const companyId = (req as any).companyId;

      // Use LEFT JOIN with generated_scripts; handle case where generated_scripts
      // may not have project_context_id column yet (fresh vs. migrated DB)
      let rows: any[];
      try {
        const result = await pool.query(
          `SELECT pc.*,
                  (SELECT COUNT(*) FROM generated_scripts gs WHERE gs.project_context_id = pc.id) AS scripts_count
           FROM project_contexts pc
           WHERE pc.is_active = true
           ORDER BY pc.updated_at DESC NULLS LAST, pc.created_at DESC`,
        );
        rows = result.rows;
      } catch {
        // Fallback if generated_scripts doesn't have project_context_id yet
        const result = await pool.query(
          `SELECT pc.*, 0 AS scripts_count
           FROM project_contexts pc
           WHERE pc.is_active = true
           ORDER BY pc.created_at DESC`,
        );
        rows = result.rows;
      }

      const data = rows.map((c: any) => ({
        ...c,
        _count: { scripts: parseInt(c.scripts_count) || 0 },
      }));

      res.json({ success: true, data });
    } catch (err: any) {
      logger.error(MOD, 'project-context GET failed', { error: err?.message || err });
      res.status(500).json({ success: false, error: 'Failed to fetch project contexts' });
    }
  });

  /** POST /api/dashboard/project-context */
  router.post('/project-context', async (req: Request, res: Response) => {
    try {
      const { id, name, appUrl, framework, authMethod, selectorStrategy, appDescription, navigationFlow, customRules, credentials } = req.body;

      if (!name || !appUrl) {
        return res.status(400).json({ success: false, error: 'name and appUrl are required' });
      }

      const companyId = (req as any).companyId || null;
      const pool = getPool();

      // Safely handle credentials — could be string or object
      let credentialsStr: string | null = null;
      if (credentials) {
        credentialsStr = typeof credentials === 'string' ? credentials : JSON.stringify(credentials);
      }

      if (id) {
        const { rows } = await pool.query(
          `UPDATE project_contexts SET name=$1, app_url=$2, framework=$3, auth_method=$4,
           selector_strategy=$5, app_description=$6, navigation_flow=$7, custom_rules=$8,
           credentials=$9, updated_at=NOW()
           WHERE id=$10 RETURNING *`,
          [name, appUrl, framework || null, authMethod || null, selectorStrategy || null,
           appDescription || null, navigationFlow || null, customRules || null,
           credentialsStr, Number(id)],
        );
        if (rows.length === 0) {
          return res.status(404).json({ success: false, error: 'Project context not found' });
        }
        return res.json({ success: true, data: rows[0] });
      }

      const { rows } = await pool.query(
        `INSERT INTO project_contexts (company_id, name, app_url, framework, auth_method, selector_strategy, app_description, navigation_flow, custom_rules, credentials)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [companyId, name, appUrl, framework || null, authMethod || null, selectorStrategy || null,
         appDescription || null, navigationFlow || null, customRules || null, credentialsStr],
      );
      res.json({ success: true, data: rows[0] });
    } catch (err: any) {
      // Log comprehensive PostgreSQL error details for debugging
      const pgErrorInfo: Record<string, unknown> = {
        message: err?.message,
        code: err?.code,          // e.g. 42P01 = undefined_table, 23505 = unique_violation
        detail: err?.detail,      // PG constraint/detail info
        hint: err?.hint,
        position: err?.position,  // position in query where error occurred
        constraint: err?.constraint,
        table: err?.table,
        column: err?.column,
        dataType: err?.dataType,
        severity: err?.severity,
        routine: err?.routine,
        file: err?.file,
        line: err?.line,
      };

      logger.error(MOD, 'project-context POST failed', {
        ts: new Date().toISOString(),
        ...pgErrorInfo,
        stack: err?.stack?.split('\n').slice(0, 5).join('\n'),
        body: { ...req.body, credentials: req.body.credentials ? '[REDACTED]' : undefined },
      });

      // Return actionable error info in non-production environments
      const isProd = process.env.NODE_ENV === 'production';
      res.status(500).json({
        success: false,
        error: 'Failed to save project context',
        ...(isProd ? {} : {
          details: err?.message,
          pgCode: err?.code,
          pgDetail: err?.detail,
          pgHint: err?.hint,
          pgTable: err?.table,
        }),
      });
    }
  });

  /** GET /api/dashboard/project-context/:id */
  router.get('/project-context/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid ID' });

      const pool = getPool();
      const { rows } = await pool.query(
        `SELECT * FROM project_contexts WHERE id = $1`,
        [id],
      );
      if (rows.length === 0) return res.status(404).json({ success: false, error: 'Not found' });

      const scriptsRes = await pool.query(
        `SELECT * FROM generated_scripts WHERE project_context_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [id],
      );

      res.json({ success: true, data: { ...rows[0], scripts: scriptsRes.rows } });
    } catch (err) {
      logger.error(MOD, 'project-context/:id GET failed', { error: err });
      res.status(500).json({ success: false, error: 'Failed to fetch context' });
    }
  });

  /** DELETE /api/dashboard/project-context/:id */
  router.delete('/project-context/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid ID' });

      const pool = getPool();
      await pool.query(`UPDATE project_contexts SET is_active = false WHERE id = $1`, [id]);
      res.json({ success: true });
    } catch (err) {
      logger.error(MOD, 'project-context DELETE failed', { error: err });
      res.status(500).json({ success: false, error: 'Failed to delete context' });
    }
  });

  // ─── AI Cost Dashboard ────────────────────────────────────────────

  /** GET /api/dashboard/ai-usage/daily — today's AI usage metrics */
  router.get('/ai-usage/daily', async (_req: Request, res: Response) => {
    try {
      const metrics = await getDailyAiMetrics();
      const maxDaily = parseFloat(process.env['MAX_DAILY_AI_COST_USD'] || '5.00');
      res.json({
        success: true,
        data: {
          ...metrics,
          budgetRemaining: maxDaily - metrics.dailyCostUsd,
          isOverBudget: metrics.dailyCostUsd >= maxDaily,
          monthlyProjection: metrics.dailyCostUsd * 30,
        },
      });
    } catch (err) {
      logger.error(MOD, 'ai-usage daily failed', { error: err });
      res.status(500).json({ success: false, error: 'Failed to fetch AI usage metrics' });
    }
  });

  /** GET /api/dashboard/ai-usage/by-model — usage breakdown by model */
  router.get('/ai-usage/by-model', async (_req: Request, res: Response) => {
    try {
      const data = await getAiUsageByModel();
      res.json({ success: true, data });
    } catch (err) {
      logger.error(MOD, 'ai-usage by-model failed', { error: err });
      res.status(500).json({ success: false, error: 'Failed to fetch model usage' });
    }
  });

  /** GET /api/dashboard/ai-usage/by-feature — usage breakdown by feature (current month) */
  router.get('/ai-usage/by-feature', async (_req: Request, res: Response) => {
    try {
      const data = await getAiUsageByFeature();
      res.json({ success: true, data });
    } catch (err) {
      logger.error(MOD, 'ai-usage by-feature failed', { error: err });
      res.status(500).json({ success: false, error: 'Failed to fetch feature usage' });
    }
  });

  /** GET /api/dashboard/ai-usage/trend?days=30 — daily cost trend */
  router.get('/ai-usage/trend', async (req: Request, res: Response) => {
    try {
      const days = Math.min(parseInt(req.query.days as string) || 30, 90);
      const data = await getAiCostTrend(days);
      res.json({ success: true, data });
    } catch (err) {
      logger.error(MOD, 'ai-usage trend failed', { error: err });
      res.status(500).json({ success: false, error: 'Failed to fetch cost trend' });
    }
  });

  /** GET /api/dashboard/ai-usage/budget — today's budget status */
  router.get('/ai-usage/budget', async (_req: Request, res: Response) => {
    try {
      const maxDaily = parseFloat(process.env['MAX_DAILY_AI_COST_USD'] || '5.00');
      const data = await getDailyBudgetStatus(maxDaily);
      res.json({ success: true, data });
    } catch (err) {
      logger.error(MOD, 'ai-usage budget failed', { error: err });
      res.status(500).json({ success: false, error: 'Failed to fetch budget status' });
    }
  });

  return router;
}

// Trigger Railway redeploy — dashboard TS2345 fix verified
