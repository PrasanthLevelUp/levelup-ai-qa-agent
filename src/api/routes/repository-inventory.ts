/**
 * Repository Coverage Inventory endpoints — Sprint RCI-1
 * ======================================================
 * Deterministic scan → persist → read of the tests that ALREADY exist in a
 * repository. NO LLM, NO embeddings, NO generation — this is the "understand
 * what's already here" foundation that runs BEFORE any AI generation.
 *
 *   POST /api/repository-inventory/scan   — scan a repo & persist per-test rows
 *   GET  /api/repository-inventory        — grouped, searchable inventory
 *
 * Scope (company_id / project_id) comes from auth + project middleware, exactly
 * like the other project-scoped routers.
 */

import { Router, type Request, type Response } from 'express';
import * as fs from 'fs';
import { scanRepositoryInventory } from '../../coverage-intelligence/repository-inventory-scanner';
import { cloneToTemp, cleanupTemp, isRemoteUrl } from '../../services/repo-scan-service';
import {
  getRepository,
  replaceRepositoryTestInventory,
  getRepositoryTestInventoryGrouped,
  type RepositoryInventoryRecordInput,
} from '../../db/postgres';
import { logger } from '../../utils/logger';

const MOD = 'repository-inventory-routes';

export function createRepositoryInventoryRouter(): Router {
  const router = Router();

  /**
   * POST /api/repository-inventory/scan
   * Body: { repositoryId?: number, repoPath?: string, branch?: string }
   *   - repositoryId → look up the stored repository, clone its URL (or scan
   *     its local path) and persist the inventory linked to that repository.
   *   - repoPath     → ad-hoc scan of a local path or remote URL (repository_id
   *     is left NULL).
   */
  router.post('/scan', async (req: Request, res: Response) => {
    const companyId = (req as any).companyId as number | undefined;
    if (!companyId) {
      return res.status(401).json({ error: 'Company context required' });
    }

    const { repositoryId, repoPath, branch } = req.body as {
      repositoryId?: number;
      repoPath?: string;
      branch?: string;
    };

    let scanTarget: string | null = null;
    let resolvedBranch = branch || 'main';
    let repositoryDbId: number | null = null;
    let projectId: number | null = (req as any).projectId ?? null;
    let tempDir: string | null = null;

    try {
      // ── Resolve what to scan ─────────────────────────────────────────
      if (repositoryId != null) {
        const repo = await getRepository(Number(repositoryId), companyId);
        if (!repo) {
          return res.status(404).json({ error: `Repository ${repositoryId} not found` });
        }
        repositoryDbId = repo.id;
        projectId = repo.project_id ?? projectId;
        scanTarget = repo.url;
        resolvedBranch = branch || repo.branch || 'main';
      } else if (repoPath) {
        scanTarget = repoPath;
      } else {
        return res.status(400).json({ error: 'Provide repositoryId or repoPath' });
      }

      if (!scanTarget) {
        return res.status(400).json({ error: 'Could not resolve a repository URL or path to scan' });
      }

      // ── Get files on disk (clone remote, use local as-is) ────────────
      let diskPath: string;
      if (isRemoteUrl(scanTarget)) {
        logger.info(MOD, `Cloning ${scanTarget} @ ${resolvedBranch} for inventory scan`);
        tempDir = cloneToTemp(scanTarget, resolvedBranch);
        diskPath = tempDir;
      } else {
        if (!fs.existsSync(scanTarget)) {
          return res.status(400).json({ error: `Path does not exist: ${scanTarget}` });
        }
        diskPath = scanTarget;
      }

      // ── Deterministic scan ───────────────────────────────────────────
      const scan = scanRepositoryInventory(diskPath);

      // ── Persist ──────────────────────────────────────────────────────
      const records: RepositoryInventoryRecordInput[] = scan.records.map(r => ({
        filePath: r.filePath,
        testName: r.testName,
        feature: r.feature,
        flow: r.flow,
        page: r.page,
        tags: r.tags,
        assertions: r.assertions,
        pomMethods: r.pomMethods,
        framework: r.framework,
        confidence: r.confidence,
        metadata: r.metadata,
      }));

      const { inserted } = await replaceRepositoryTestInventory(
        companyId,
        projectId,
        repositoryDbId,
        records,
      );

      return res.json({
        ok: true,
        repositoryId: repositoryDbId,
        scanned: {
          filesScanned: scan.filesScanned,
          testFilesScanned: scan.testFilesScanned,
          testsFound: scan.testsFound,
          frameworks: scan.frameworks,
          durationMs: scan.durationMs,
        },
        persisted: inserted,
        warnings: scan.warnings.slice(0, 20),
      });
    } catch (err) {
      logger.error(MOD, `Inventory scan failed: ${(err as Error).message}`, { error: (err as Error).stack });
      return res.status(500).json({ error: `Scan failed: ${(err as Error).message}` });
    } finally {
      if (tempDir) cleanupTemp(tempDir);
    }
  });

  /**
   * GET /api/repository-inventory?repository_id=&search=
   * Returns the persisted inventory grouped by feature (with counts).
   */
  router.get('/', async (req: Request, res: Response) => {
    const companyId = (req as any).companyId as number | undefined;
    if (!companyId) {
      return res.status(401).json({ error: 'Company context required' });
    }
    const projectId = (req as any).projectId ?? null;
    const repositoryIdRaw = req.query.repository_id;
    const repositoryId = repositoryIdRaw ? parseInt(String(repositoryIdRaw), 10) : null;
    const search = req.query.search ? String(req.query.search) : undefined;

    try {
      const result = await getRepositoryTestInventoryGrouped(companyId, {
        projectId,
        repositoryId: repositoryId && !isNaN(repositoryId) ? repositoryId : null,
        search,
      });
      return res.json(result);
    } catch (err) {
      logger.error(MOD, `Inventory fetch failed: ${(err as Error).message}`);
      return res.status(500).json({ error: `Fetch failed: ${(err as Error).message}` });
    }
  });

  return router;
}
