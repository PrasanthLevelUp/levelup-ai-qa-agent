/**
 * Repository Migration Report (internal)
 * ============================================================================
 *
 * Surfaces the health of an in-flight legacy → provider migration so we can
 * make the flip decision on DATA, not vibes. It reads the durable shadow
 * metrics table (see `provider_shadow_metrics` in db/postgres) and the live
 * migration state (see services/migration-state).
 *
 *   GET /api/migration-report/repository?hours=24
 *
 * Response (all fields fail-safe — a fresh DB with no metrics returns zeros):
 *   {
 *     success: true,
 *     source: 'repository',
 *     mode: 'shadow' | 'provider' | 'legacy',   // effective runtime phase
 *     shadowActive: boolean,                     // provider running in parallel?
 *     legacyPresent: boolean,                    // legacy inline still exists?
 *     report: {
 *       windowHours, total, matched, mismatched,
 *       matchRatePct,                            // the 99.9% gate number
 *       avgLegacyMs, avgProviderMs, avgSpeedupMs,// migration perf metrics
 *       providerVersions, lastComparisonAt,
 *       topMismatchReasons: [{ reason, count }]  // top 10 buckets
 *     }
 *   }
 *
 * Scoped to the caller's (companyId, projectId) via the standard middleware
 * chain, so tenants only see their own comparison data.
 */

import { Router, type Request, type Response } from 'express';
import { getProviderShadowReport } from '../../db/postgres';
import {
  resolveMode,
  isShadowActive,
  MIGRATION_REGISTRY,
} from '../../services/migration-state';
import { logger } from '../../utils/logger';

const MOD = 'migration-report-api';

function scopeOf(req: Request): { companyId?: number; projectId?: number } {
  return {
    companyId: (req as any).companyId as number | undefined,
    projectId: (req as any).projectId as number | undefined,
  };
}

export function createMigrationReportRouter(): Router {
  const router = Router();

  // ── Per-source migration report ──
  // :source must be a declared migration key (e.g. "repository").
  router.get('/:source', async (req: Request, res: Response) => {
    const source = String(req.params.source || '').trim();
    const decl = MIGRATION_REGISTRY[source];
    if (!decl) {
      return res.status(404).json({
        success: false,
        error: `Unknown migration source "${source}". Known: ${Object.keys(MIGRATION_REGISTRY).join(', ')}`,
      });
    }
    try {
      const hoursRaw = Number(req.query.hours);
      const windowHours = Number.isFinite(hoursRaw) && hoursRaw > 0 ? hoursRaw : 24;
      const { companyId, projectId } = scopeOf(req);

      const report = await getProviderShadowReport(decl.providerName, {
        windowHours,
        companyId,
        projectId,
      });

      res.json({
        success: true,
        source: decl.key,
        providerName: decl.providerName,
        mode: resolveMode(source),
        shadowActive: isShadowActive(source),
        legacyPresent: decl.legacyPresent,
        report,
      });
    } catch (err: any) {
      logger.error(MOD, `report error for "${source}": ${err?.message || err}`);
      res.status(500).json({ success: false, error: err?.message || String(err) });
    }
  });

  return router;
}
