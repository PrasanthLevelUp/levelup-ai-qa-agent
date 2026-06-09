/**
 * Observable Metrics API — investor-grade KPIs + Loop 2 crawl intelligence.
 *
 * Metrics (the five north-star numbers that prove the product improves):
 *   GET  /api/metrics/current                 — live metrics + last snapshot
 *   GET  /api/metrics/trends?period=30d        — daily time series for charts
 *   GET  /api/metrics/improvement?period=30d   — % improvement over the window
 *   POST /api/metrics/snapshot                 — force today's snapshot (idempotent)
 *
 * Loop 2 — Test Failures → Crawl Intelligence:
 *   GET  /api/metrics/crawl/failures           — per-page failure report
 *   GET  /api/metrics/crawl/adaptations        — learned per-page crawl configs
 *   POST /api/metrics/crawl/analyze            — (re)analyze failures → adaptations
 *
 * Loop 3 — Maintenance → Healing:
 *   GET  /api/metrics/patterns/maintenance     — learned old→new selector library
 *
 * MTTR (Mean Time To Repair) flows through /current and /trends automatically
 * (mttr_minutes, mttr_manual_minutes, mttr_improvement_factor).
 *
 * Privacy Controls:
 *   GET  /api/metrics/learning-scope           — current scope (project|company|disabled)
 *   PUT  /api/metrics/learning-scope           — update scope (enterprise can disable)
 *
 * Every endpoint is scoped to the caller's (companyId, projectId) and is
 * fail-safe: empty history returns zeros / empty arrays rather than erroring.
 */

import { Router, type Request, type Response } from 'express';
import {
  getCurrentMetrics,
  getTrends,
  getImprovement,
  snapshotDailyMetrics,
} from '../../services/metrics-calculator-service';
import {
  analyzeFailures,
  getFailureReport,
  listCrawlAdaptations,
} from '../../services/crawl-adaptation-service';
import { listMaintenancePatterns } from '../../services/maintenance-pattern-service';
import {
  getLearningSettings,
  upsertLearningSettings,
  recordLearningScopeChange,
  getLearningScopeAudit,
  DEFAULT_LEARNING_SETTINGS,
  type LearningScope,
} from '../../db/postgres';
import { logger } from '../../utils/logger';

const MOD = 'metrics-api';

function scopeOf(req: Request): { companyId?: number; projectId?: number } {
  return {
    companyId: (req as any).companyId as number | undefined,
    projectId: (req as any).projectId as number | undefined,
  };
}

export function createMetricsRouter(): Router {
  const router = Router();

  // ── Current metrics (live) ──
  router.get('/current', async (req: Request, res: Response) => {
    try {
      const data = await getCurrentMetrics(scopeOf(req));
      res.json({ success: true, data });
    } catch (err: any) {
      logger.error(MOD, `current error: ${err?.message || err}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── Trends (daily time series) ──
  router.get('/trends', async (req: Request, res: Response) => {
    try {
      const period = (req.query.period as string) || '30d';
      const data = await getTrends(period, scopeOf(req));
      res.json({ success: true, data });
    } catch (err: any) {
      logger.error(MOD, `trends error: ${err?.message || err}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── Improvement over the window ──
  router.get('/improvement', async (req: Request, res: Response) => {
    try {
      const period = (req.query.period as string) || '30d';
      const data = await getImprovement(period, scopeOf(req));
      res.json({ success: true, data });
    } catch (err: any) {
      logger.error(MOD, `improvement error: ${err?.message || err}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── Force a daily snapshot (idempotent upsert for today) ──
  router.post('/snapshot', async (req: Request, res: Response) => {
    try {
      const data = await snapshotDailyMetrics(scopeOf(req));
      res.json({ success: true, data });
    } catch (err: any) {
      logger.error(MOD, `snapshot error: ${err?.message || err}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Loop 2: Crawl Intelligence ─────────────────────────────────────────── */

  // Per-page failure report.
  router.get('/crawl/failures', async (req: Request, res: Response) => {
    try {
      const windowDays = parseInt(String(req.query.days || '30'), 10) || 30;
      const data = await getFailureReport(scopeOf(req), windowDays);
      res.json({ success: true, data, count: data.length });
    } catch (err: any) {
      logger.error(MOD, `crawl/failures error: ${err?.message || err}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Learned per-page crawl adaptations.
  router.get('/crawl/adaptations', async (req: Request, res: Response) => {
    try {
      const data = await listCrawlAdaptations(scopeOf(req));
      res.json({ success: true, data, count: data.length });
    } catch (err: any) {
      logger.error(MOD, `crawl/adaptations error: ${err?.message || err}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // (Re)analyze accumulated failures → recompute adaptations.
  router.post('/crawl/analyze', async (req: Request, res: Response) => {
    try {
      const windowDays = parseInt(String(req.body?.days || '30'), 10) || 30;
      const data = await analyzeFailures(scopeOf(req), windowDays);
      res.json({ success: true, data, count: data.length });
    } catch (err: any) {
      logger.error(MOD, `crawl/analyze error: ${err?.message || err}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Privacy Controls: learning scope ───────────────────────────────────── */

  // Static catalogue of selectable scopes + governance metadata. Surfaced to
  // the settings UI so option copy lives in one place (backend = source of truth).
  const LEARNING_SCOPE_OPTIONS = [
    {
      value: 'project',
      label: 'Project Learning',
      recommended: true,
      summary: "Learn only from this project's test execution data.",
      benefits: ['Maximum data isolation', 'Project-specific patterns only', 'No cross-project data sharing'],
      dataUsed: "This project's failures, healing actions and selector patterns.",
      isolation: 'strict',
    },
    {
      value: 'company',
      label: 'Company Learning',
      recommended: false,
      summary: 'Learn from all projects across your organization.',
      benefits: ['Faster learning through shared knowledge', 'Organization-wide pattern recognition', 'Higher reuse of proven fixes'],
      dataUsed: 'Failures, healing actions and patterns from every project in your company.',
      isolation: 'company',
    },
    {
      value: 'disabled',
      label: 'Disabled',
      recommended: false,
      summary: 'Disable all learning capabilities.',
      benefits: ['No data collected for learning', 'Static intelligence only', 'Maximum privacy posture'],
      dataUsed: 'Nothing — no execution data is mined or stored for learning.',
      isolation: 'none',
    },
  ];

  router.get('/learning-scope', async (req: Request, res: Response) => {
    try {
      const { companyId, projectId } = scopeOf(req);
      const settings = await getLearningSettings(companyId, projectId);
      res.json({
        success: true,
        data: {
          ...settings,
          options: LEARNING_SCOPE_OPTIONS,
          defaultScope: DEFAULT_LEARNING_SETTINGS.learningScope,
          scope: { companyId: companyId ?? null, projectId: projectId ?? null },
        },
      });
    } catch (err: any) {
      logger.error(MOD, `learning-scope get error: ${err?.message || err}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.put('/learning-scope', async (req: Request, res: Response) => {
    try {
      const { companyId, projectId } = scopeOf(req);
      const requested = String(req.body?.learningScope || '').trim() as LearningScope;
      const allowed: LearningScope[] = ['project', 'company', 'disabled'];
      if (!allowed.includes(requested)) {
        return res.status(400).json({ success: false, error: `learningScope must be one of: ${allowed.join(', ')}` });
      }
      const previous = await getLearningSettings(companyId, projectId);
      const settings = await upsertLearningSettings({ learningScope: requested }, companyId, projectId);

      // Append an immutable governance record (non-fatal if audit table missing).
      if (previous.learningScope !== requested) {
        await recordLearningScopeChange({
          companyId, projectId,
          oldScope: previous.learningScope,
          newScope: requested,
          changedByUserId: (req as any).userId ?? null,
          changedByUsername: (req as any).username ?? null,
        });
      }
      logger.info(MOD, '🔒 Learning scope updated', {
        companyId, projectId, from: previous.learningScope, to: requested,
        by: (req as any).username || (req as any).userId || 'unknown',
      });
      res.json({ success: true, data: settings });
    } catch (err: any) {
      logger.error(MOD, `learning-scope put error: ${err?.message || err}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/learning-scope/audit', async (req: Request, res: Response) => {
    try {
      const { companyId, projectId } = scopeOf(req);
      const limit = parseInt(String(req.query.limit ?? '25'), 10);
      const entries = await getLearningScopeAudit(companyId, projectId, Number.isFinite(limit) ? limit : 25);
      res.json({ success: true, data: { entries, total: entries.length } });
    } catch (err: any) {
      logger.error(MOD, `learning-scope audit error: ${err?.message || err}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ── Loop 3: learned maintenance pattern library (old→new selector mappings) ──
  router.get('/patterns/maintenance', async (req: Request, res: Response) => {
    try {
      const scope = scopeOf(req);
      const limit = parseInt(String(req.query.limit ?? '100'), 10);
      const patterns = await listMaintenancePatterns(scope, Number.isFinite(limit) ? limit : 100);
      res.json({ success: true, data: { patterns, total: patterns.length } });
    } catch (err: any) {
      logger.error(MOD, `patterns/maintenance error: ${err?.message || err}`);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}
