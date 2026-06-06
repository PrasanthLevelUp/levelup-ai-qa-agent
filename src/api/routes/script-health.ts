/**
 * Script Health API Routes — Proactive Script Maintenance
 *
 * GET /api/script-health           — Health scores for every active script
 * GET /api/script-health/changes   — Change-detection: diff latest crawls +
 *                                     list scripts impacted by removed selectors
 * GET /api/script-health/:id       — Detailed health for a single script
 *
 * Read-only and additive: when no crawl snapshots / locator reports exist yet,
 * endpoints still respond with best-effort (heuristic) data instead of failing.
 */

import { Router, type Request, type Response } from 'express';
import {
  getScriptsForHealth,
  getGeneratedScript,
  getProfileByUrl,
  getSnapshotBaseUrls,
  getLatestSnapshots,
  type CrawlSnapshotRecord,
} from '../../db/postgres';
import {
  scoreScriptHealth,
  diffCrawlSignatures,
  analyzeImpact,
  type CrawlSignature,
  type ScriptHealth,
} from '../../services/script-maintenance';
import { logger } from '../../utils/logger';

const MOD = 'ScriptHealthAPI';

/** Resolve the base URL (origin) for a script's page URL. */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export function createScriptHealthRouter(): Router {
  const router = Router();

  // ── GET /api/script-health ────────────────────────────────────────────
  // Health scores for all active scripts in the current company/project scope.
  router.get('/', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const projectId = (req as any).projectId as number | undefined;
      if (companyId == null) {
        return res.status(401).json({ success: false, error: 'Missing company context' });
      }

      const scripts = await getScriptsForHealth(companyId, projectId);

      // Cache crawl data per origin so we don't re-fetch the same profile.
      const crawlCache = new Map<string, any>();
      const getCrawl = async (url: string): Promise<any> => {
        const origin = originOf(url);
        if (crawlCache.has(origin)) return crawlCache.get(origin);
        let crawl: any = null;
        try {
          const profile = await getProfileByUrl(origin, companyId, projectId);
          crawl = profile?.crawl_data ?? null;
        } catch (e) {
          logger.warn(MOD, `Could not load profile for ${origin}`, { error: (e as Error).message });
        }
        crawlCache.set(origin, crawl);
        return crawl;
      };

      const health: ScriptHealth[] = [];
      for (const s of scripts) {
        const crawl = await getCrawl(s.url);
        health.push(scoreScriptHealth(s, crawl));
      }

      // Aggregate summary for the dashboard header.
      const total = health.length;
      const avgScore = total ? Math.round(health.reduce((a, h) => a + h.score, 0) / total) : 0;
      const gradeCounts = health.reduce(
        (acc, h) => {
          acc[h.grade] = (acc[h.grade] || 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      );
      const needsAttention = health.filter((h) => h.grade === 'D' || h.grade === 'F').length;
      const staleCount = health.filter((h) => h.ageDays > 90).length;
      const outdatedLocatorCount = health.reduce((a, h) => a + h.outdatedLocators.length, 0);

      return res.json({
        success: true,
        summary: {
          total,
          avgScore,
          gradeCounts,
          needsAttention,
          staleCount,
          outdatedLocatorCount,
        },
        scripts: health,
      });
    } catch (err: any) {
      logger.error(MOD, 'GET /script-health failed', { error: err?.message });
      return res.status(500).json({ success: false, error: err?.message || 'Internal error' });
    }
  });

  // ── GET /api/script-health/changes ────────────────────────────────────
  // Diff the two most recent crawl snapshots per app + flag impacted scripts.
  router.get('/changes', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const projectId = (req as any).projectId as number | undefined;
      if (companyId == null) {
        return res.status(401).json({ success: false, error: 'Missing company context' });
      }

      const baseUrls = await getSnapshotBaseUrls(companyId, projectId);
      const scripts = await getScriptsForHealth(companyId, projectId);

      const changes: any[] = [];
      for (const baseUrl of baseUrls) {
        const snaps: CrawlSnapshotRecord[] = await getLatestSnapshots(baseUrl, companyId, projectId, 2);
        if (snaps.length < 2) {
          // Only one crawl so far — nothing to diff yet.
          changes.push({
            baseUrl,
            versions: snaps.length,
            hasDiff: false,
            message: 'Only one crawl captured — re-crawl to enable change detection',
          });
          continue;
        }
        const [curr, prev] = snaps; // ordered version DESC
        const currSig = (curr.signature || {}) as CrawlSignature;
        const prevSig = (prev.signature || {}) as CrawlSignature;
        const diff = diffCrawlSignatures(prevSig, currSig);

        // Only consider scripts whose origin matches this app.
        const scoped = scripts.filter((s) => originOf(s.url) === baseUrl || s.url.startsWith(baseUrl));
        const impacted = analyzeImpact(scoped, diff);

        changes.push({
          baseUrl,
          versions: snaps.length,
          fromVersion: prev.version,
          toVersion: curr.version,
          detectedAt: curr.created_at,
          hasDiff: !diff.unchanged,
          severity: diff.severity,
          diff,
          impactedScripts: impacted,
        });
      }

      const totalImpacted = changes.reduce(
        (a, c) => a + (Array.isArray(c.impactedScripts) ? c.impactedScripts.length : 0),
        0,
      );

      return res.json({
        success: true,
        summary: {
          appsTracked: baseUrls.length,
          appsWithChanges: changes.filter((c) => c.hasDiff).length,
          totalImpactedScripts: totalImpacted,
        },
        changes,
      });
    } catch (err: any) {
      logger.error(MOD, 'GET /script-health/changes failed', { error: err?.message });
      return res.status(500).json({ success: false, error: err?.message || 'Internal error' });
    }
  });

  // ── GET /api/script-health/:id ────────────────────────────────────────
  // Detailed health for a single script (incl. full outdated-locator list).
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const projectId = (req as any).projectId as number | undefined;
      if (companyId == null) {
        return res.status(401).json({ success: false, error: 'Missing company context' });
      }
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ success: false, error: 'Invalid script id' });
      }

      const script = await getGeneratedScript(id, companyId, projectId);
      if (!script) {
        return res.status(404).json({ success: false, error: 'Script not found' });
      }

      let crawl: any = null;
      try {
        const profile = await getProfileByUrl(originOf(script.url), companyId, projectId);
        crawl = profile?.crawl_data ?? null;
      } catch {
        /* best-effort */
      }

      const health = scoreScriptHealth(
        {
          id,
          url: script.url,
          page_type: script.page_type,
          locator_report: script.locator_report,
          created_at: script.created_at,
        },
        crawl,
      );

      return res.json({ success: true, health });
    } catch (err: any) {
      logger.error(MOD, 'GET /script-health/:id failed', { error: err?.message });
      return res.status(500).json({ success: false, error: err?.message || 'Internal error' });
    }
  });

  return router;
}
