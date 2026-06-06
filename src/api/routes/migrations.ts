/**
 * Migration Assistant routes (Feature D)
 * --------------------------------------------------------------------------
 * Bulk re-point generated scripts from one crawl snapshot to another.
 *
 *   GET    /api/migrations                  — list migrations (scoped)
 *   GET    /api/migrations/base-urls        — apps that have ≥1 snapshot
 *   GET    /api/migrations/snapshots        — snapshots for a base URL
 *   POST   /api/migrations/create           — diff two snapshots → suggestions
 *   GET    /api/migrations/:id/suggestions  — stored mappings + affected scripts
 *   POST   /api/migrations/:id/apply        — apply (with overrides) → diffs
 *
 * All endpoints are scoped by company/project via the standard middleware
 * chain. Purely additive — no existing behaviour changes.
 */

import { Router, type Request, type Response } from 'express';
import { logger } from '../../utils/logger';
import {
  createMigration,
  getMigration,
  updateMigration,
  listMigrations,
  getSnapshotById,
  getLatestSnapshots,
  getSnapshotBaseUrls,
  getScriptHistory,
} from '../../db/postgres';
import { diffCrawlSignatures, type CrawlSignature } from '../../services/script-maintenance';
import {
  suggestMappings,
  applyOverrides,
  applyMigrationToScript,
  findAffectedScripts,
  type ElementMapping,
  type EmbeddingProvider,
} from '../../services/script-migration';
import { updateScriptContent, saveScriptVersion } from '../../db/postgres';

const MOD = 'Migrations';

/** Build an optional embedding provider when an OpenAI key is configured. */
function getEmbedder(): EmbeddingProvider | null {
  if (!process.env['OPENAI_API_KEY']) return null;
  try {
    // Lazy require so the route loads even if the AI module has heavy deps.
    const { OpenAIClient } = require('../../ai/openai-client');
    const client = new OpenAIClient();
    return {
      batchGenerateEmbeddings: (texts: string[]) => client.batchGenerateEmbeddings(texts),
      cosineSimilarity: (a: number[], b: number[]) => client.cosineSimilarity(a, b),
    };
  } catch (err) {
    logger.warn(MOD, 'Embedding provider unavailable, falling back to heuristic mapping', {
      error: (err as Error).message,
    });
    return null;
  }
}

export function createMigrationsRouter(): Router {
  const router = Router();

  /* ── List migrations ─────────────────────────────────────── */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const projectId = (req as any).projectId as number | undefined;
      const rows = await listMigrations(companyId, projectId);
      res.json({ success: true, data: rows });
    } catch (err: any) {
      logger.error(MOD, 'list migrations failed', { error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Base URLs with snapshots (wizard step 1) ─────────────── */
  router.get('/base-urls', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const projectId = (req as any).projectId as number | undefined;
      const urls = await getSnapshotBaseUrls(companyId, projectId);
      res.json({ success: true, data: urls });
    } catch (err: any) {
      logger.error(MOD, 'base-urls failed', { error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Snapshots for a base URL (wizard step 1) ─────────────── */
  router.get('/snapshots', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const projectId = (req as any).projectId as number | undefined;
      const baseUrl = String(req.query.baseUrl || '');
      if (!baseUrl) {
        return res.status(400).json({ success: false, error: 'baseUrl query param is required' });
      }
      const snaps = await getLatestSnapshots(baseUrl, companyId, projectId, 20);
      res.json({
        success: true,
        data: snaps.map((s) => ({
          id: s.id,
          version: s.version,
          baseUrl: s.base_url,
          elementCount: s.element_count,
          formCount: s.form_count,
          selectorCount: s.selector_count,
          pageCount: s.page_count,
          createdAt: s.created_at,
        })),
      });
    } catch (err: any) {
      logger.error(MOD, 'snapshots failed', { error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Create migration: diff two snapshots → suggestions ───── */
  router.post('/create', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const projectId = (req as any).projectId as number | undefined;
      const { oldSnapshotId, newSnapshotId } = req.body ?? {};
      if (!oldSnapshotId || !newSnapshotId) {
        return res.status(400).json({ success: false, error: 'oldSnapshotId and newSnapshotId are required' });
      }

      const oldSnap = await getSnapshotById(Number(oldSnapshotId), companyId, projectId);
      const newSnap = await getSnapshotById(Number(newSnapshotId), companyId, projectId);
      if (!oldSnap || !newSnap) {
        return res.status(404).json({ success: false, error: 'One or both snapshots not found' });
      }

      const oldSig = oldSnap.signature as CrawlSignature;
      const newSig = newSnap.signature as CrawlSignature;
      const diff = diffCrawlSignatures(oldSig, newSig);

      // AI/heuristic element mapping suggestions.
      const mappings = await suggestMappings(oldSig, newSig, getEmbedder());

      // Which existing scripts reference any removed selector?
      const removed = diff.removedSelectors;
      let affectedScriptIds: number[] = [];
      if (companyId != null && removed.length) {
        const { records } = await getScriptHistory(companyId, { projectId, limit: 500 });
        affectedScriptIds = findAffectedScripts(
          records.map((r: any) => ({ id: r.id, url: r.url, script_content: r.script_content, files_generated: r.files_generated })),
          removed,
        );
      }

      const migration = await createMigration({
        companyId,
        projectId,
        baseUrl: newSnap.base_url,
        oldSnapshotId: oldSnap.id,
        newSnapshotId: newSnap.id,
        mappings,
        affectedScriptIds,
      });

      logger.info(MOD, 'migration created', {
        id: migration?.id, removed: removed.length, mappings: mappings.length, affected: affectedScriptIds.length,
      });

      res.json({
        success: true,
        data: {
          migration,
          diff,
          mappings,
          affectedScriptIds,
        },
      });
    } catch (err: any) {
      logger.error(MOD, 'create migration failed', { error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Suggestions for an existing migration ────────────────── */
  router.get('/:id/suggestions', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const projectId = (req as any).projectId as number | undefined;
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid migration ID' });

      const migration = await getMigration(id, companyId, projectId);
      if (!migration) return res.status(404).json({ success: false, error: 'Migration not found' });

      // Build per-script preview diffs (dry-run) for the affected scripts.
      const mappings = applyOverrides(
        (migration.mappings as ElementMapping[]) || [],
        (migration.overrides as Record<string, string>) || {},
      );
      const affectedIds: number[] = (migration.affected_script_ids as number[]) || [];

      let previews: any[] = [];
      if (companyId != null && affectedIds.length) {
        const { records } = await getScriptHistory(companyId, { projectId, limit: 500 });
        const byId = new Map(records.map((r: any) => [r.id, r]));
        previews = affectedIds
          .map((sid) => byId.get(sid))
          .filter(Boolean)
          .map((r: any) =>
            applyMigrationToScript(
              { id: r.id, url: r.url, script_content: r.script_content, files_generated: r.files_generated },
              mappings,
              false,
            ),
          );
      }

      res.json({
        success: true,
        data: { migration, mappings, affectedScriptIds: affectedIds, previews },
      });
    } catch (err: any) {
      logger.error(MOD, 'suggestions failed', { error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Apply migration (with overrides) ─────────────────────── */
  router.post('/:id/apply', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const projectId = (req as any).projectId as number | undefined;
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid migration ID' });

      const dryRun = req.body?.dryRun === true;
      const overrides: Record<string, string> = req.body?.overrides || {};

      const migration = await getMigration(id, companyId, projectId);
      if (!migration) return res.status(404).json({ success: false, error: 'Migration not found' });

      const mappings = applyOverrides((migration.mappings as ElementMapping[]) || [], overrides);
      const affectedIds: number[] = (migration.affected_script_ids as number[]) || [];

      const diffs: any[] = [];
      let updatedCount = 0;
      if (companyId != null && affectedIds.length) {
        const { records } = await getScriptHistory(companyId, { projectId, limit: 500 });
        const byId = new Map(records.map((r: any) => [r.id, r]));
        for (const sid of affectedIds) {
          const r = byId.get(sid);
          if (!r) continue;
          const diff = applyMigrationToScript(
            { id: r.id, url: r.url, script_content: r.script_content, files_generated: r.files_generated },
            mappings,
            true,
          );
          diffs.push({ scriptId: diff.scriptId, url: diff.url, changed: diff.changed, replacements: diff.replacements });
          if (!dryRun && diff.changed && diff.newScriptContent) {
            try {
              await saveScriptVersion({
                scriptId: sid, companyId, projectId, reason: `pre-migration-${id}`,
                scriptContent: r.script_content, filesGenerated: r.files_generated,
              });
            } catch (bErr: any) {
              logger.warn(MOD, 'backup failed (continuing)', { scriptId: sid, error: bErr.message });
            }
            const ok = await updateScriptContent(sid, diff.newScriptContent, r.files_generated, companyId, projectId);
            if (ok) updatedCount++;
          }
        }
      }

      const applyResult = { updatedCount, totalAffected: affectedIds.length, dryRun };
      if (!dryRun) {
        await updateMigration(id, { status: 'applied', overrides, mappings, applyResult });
      } else {
        await updateMigration(id, { overrides, mappings });
      }

      logger.info(MOD, 'migration applied', { id, updatedCount, dryRun });
      res.json({ success: true, data: { diffs, ...applyResult } });
    } catch (err: any) {
      logger.error(MOD, 'apply failed', { error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}
