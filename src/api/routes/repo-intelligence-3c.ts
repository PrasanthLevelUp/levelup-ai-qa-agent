/**
 * Repository Intelligence — Phase 3C API Routes
 *
 * Three feature-flagged sub-systems, all READ-ONLY against the Phase 3 method
 * index + dependency graph (health endpoints additionally write snapshots):
 *
 *   Health Intelligence  (ENABLE_HEALTH_INTELLIGENCE)
 *     GET  /api/repo-intelligence-3c/health/:contextId
 *     GET  /api/repo-intelligence-3c/health/:contextId/snapshots
 *     GET  /api/repo-intelligence-3c/health/:contextId/trend
 *     GET  /api/repo-intelligence-3c/health/:contextId/issues
 *
 *   Impact Analysis      (ENABLE_IMPACT_ANALYSIS)
 *     GET  /api/repo-intelligence-3c/impact/method/:methodId
 *     GET  /api/repo-intelligence-3c/impact/method/:methodId/tests
 *     GET  /api/repo-intelligence-3c/impact/file/:contextId?filePath=...
 *
 *   Knowledge Graph Lite (ENABLE_KNOWLEDGE_GRAPH)
 *     GET  /api/repo-intelligence-3c/graph/:contextId?format=json|d3
 *     GET  /api/repo-intelligence-3c/graph/method/:methodId/neighborhood?depth=2
 *
 * Every group returns 404 `{ available:false }` when its flag is off, so the
 * default product surface is unchanged.
 */

import { Router, type Request, type Response } from 'express';
import { FEATURE_FLAGS } from '../../config/features';
import { logger } from '../../utils/logger';
import {
  isHealthIntelAvailable,
  isMethodIntelAvailable,
  getQualityIssues,
} from '../../db/postgres';
import { repositoryHealthService } from '../../services/repository-health-service';
import { impactAnalysisService } from '../../services/impact-analysis-service';
import { knowledgeGraphService } from '../../services/knowledge-graph-service';

const MOD = 'repo-intelligence-3c';

function parseIntParam(value: unknown): number | null {
  if (value == null) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function createRepoIntelligence3CRouter(): Router {
  const router = Router();

  /* ───────────────────────── Health Intelligence ───────────────────────── */

  const requireHealth = (res: Response): boolean => {
    if (!FEATURE_FLAGS.REPO_INTELLIGENCE.HEALTH_INTELLIGENCE) {
      res.status(404).json({ available: false, error: 'Health Intelligence is disabled (ENABLE_HEALTH_INTELLIGENCE)' });
      return false;
    }
    if (!isMethodIntelAvailable() || !isHealthIntelAvailable()) {
      res.status(503).json({ available: false, error: 'Health/method schema not available on this database' });
      return false;
    }
    return true;
  };

  router.get('/health/:contextId', async (req: Request, res: Response) => {
    if (!requireHealth(res)) return;
    const contextId = parseIntParam(req.params.contextId);
    if (!contextId) return res.status(400).json({ error: 'contextId must be a positive integer' });
    const persist = req.query.persist === 'true';
    try {
      const score = await repositoryHealthService.calculateHealth(contextId, { persist });
      return res.json({ success: true, persisted: persist, health: score });
    } catch (err: any) {
      logger.error(MOD, 'health calculation failed', { error: err?.message, contextId });
      return res.status(500).json({ error: 'health calculation failed', detail: err?.message });
    }
  });

  router.get('/health/:contextId/snapshots', async (req: Request, res: Response) => {
    if (!requireHealth(res)) return;
    const contextId = parseIntParam(req.params.contextId);
    if (!contextId) return res.status(400).json({ error: 'contextId must be a positive integer' });
    const limit = parseIntParam(req.query.limit as string) ?? 30;
    try {
      const snapshots = await repositoryHealthService.getSnapshots(contextId, limit);
      return res.json({ success: true, count: snapshots.length, snapshots });
    } catch (err: any) {
      return res.status(500).json({ error: 'failed to load snapshots', detail: err?.message });
    }
  });

  router.get('/health/:contextId/trend', async (req: Request, res: Response) => {
    if (!requireHealth(res)) return;
    const contextId = parseIntParam(req.params.contextId);
    if (!contextId) return res.status(400).json({ error: 'contextId must be a positive integer' });
    const persist = req.query.persist === 'true';
    try {
      const trend = await repositoryHealthService.getHealthTrend(contextId, { persist });
      return res.json({ success: true, count: trend.length, trend });
    } catch (err: any) {
      return res.status(500).json({ error: 'failed to compute trend', detail: err?.message });
    }
  });

  router.get('/health/:contextId/issues', async (req: Request, res: Response) => {
    if (!requireHealth(res)) return;
    const contextId = parseIntParam(req.params.contextId);
    if (!contextId) return res.status(400).json({ error: 'contextId must be a positive integer' });
    const issueType = (req.query.type as string) || undefined;
    try {
      const issues = await getQualityIssues(contextId, { issueType });
      return res.json({ success: true, count: issues.length, issues });
    } catch (err: any) {
      return res.status(500).json({ error: 'failed to load issues', detail: err?.message });
    }
  });

  /* ───────────────────────── Impact Analysis ───────────────────────────── */

  const requireImpact = (res: Response): boolean => {
    if (!FEATURE_FLAGS.REPO_INTELLIGENCE.IMPACT_ANALYSIS) {
      res.status(404).json({ available: false, error: 'Impact Analysis is disabled (ENABLE_IMPACT_ANALYSIS)' });
      return false;
    }
    if (!isMethodIntelAvailable()) {
      res.status(503).json({ available: false, error: 'Method schema not available on this database' });
      return false;
    }
    return true;
  };

  router.get('/impact/method/:methodId', async (req: Request, res: Response) => {
    if (!requireImpact(res)) return;
    const methodId = parseIntParam(req.params.methodId);
    if (!methodId) return res.status(400).json({ error: 'methodId must be a positive integer' });
    try {
      const impact = await impactAnalysisService.analyzeMethodImpact(methodId);
      return res.json({ success: true, impact });
    } catch (err: any) {
      logger.error(MOD, 'impact analysis failed', { error: err?.message, methodId });
      return res.status(500).json({ error: 'impact analysis failed', detail: err?.message });
    }
  });

  router.get('/impact/method/:methodId/tests', async (req: Request, res: Response) => {
    if (!requireImpact(res)) return;
    const methodId = parseIntParam(req.params.methodId);
    if (!methodId) return res.status(400).json({ error: 'methodId must be a positive integer' });
    try {
      const tests = await impactAnalysisService.findBreakingTests(methodId);
      return res.json({ success: true, count: tests.length, tests });
    } catch (err: any) {
      return res.status(500).json({ error: 'failed to find breaking tests', detail: err?.message });
    }
  });

  router.get('/impact/file/:contextId', async (req: Request, res: Response) => {
    if (!requireImpact(res)) return;
    const contextId = parseIntParam(req.params.contextId);
    if (!contextId) return res.status(400).json({ error: 'contextId must be a positive integer' });
    const filePath = (req.query.filePath as string) || '';
    if (!filePath) return res.status(400).json({ error: 'filePath query param is required' });
    try {
      const impact = await impactAnalysisService.analyzeFileImpact(contextId, filePath);
      return res.json({ success: true, impact });
    } catch (err: any) {
      return res.status(500).json({ error: 'file impact analysis failed', detail: err?.message });
    }
  });

  /* ───────────────────────── Knowledge Graph ───────────────────────────── */

  const requireGraph = (res: Response): boolean => {
    if (!FEATURE_FLAGS.REPO_INTELLIGENCE.KNOWLEDGE_GRAPH) {
      res.status(404).json({ available: false, error: 'Knowledge Graph is disabled (ENABLE_KNOWLEDGE_GRAPH)' });
      return false;
    }
    if (!isMethodIntelAvailable()) {
      res.status(503).json({ available: false, error: 'Method schema not available on this database' });
      return false;
    }
    return true;
  };

  router.get('/graph/:contextId', async (req: Request, res: Response) => {
    if (!requireGraph(res)) return;
    const contextId = parseIntParam(req.params.contextId);
    if (!contextId) return res.status(400).json({ error: 'contextId must be a positive integer' });
    try {
      const graph = await knowledgeGraphService.buildGraph(contextId);
      if (req.query.format === 'd3') {
        return res.json({ success: true, format: 'd3', stats: graph.stats, graph: knowledgeGraphService.exportForD3(graph) });
      }
      return res.json({ success: true, format: 'json', graph });
    } catch (err: any) {
      logger.error(MOD, 'graph build failed', { error: err?.message, contextId });
      return res.status(500).json({ error: 'graph build failed', detail: err?.message });
    }
  });

  router.get('/graph/method/:methodId/neighborhood', async (req: Request, res: Response) => {
    if (!requireGraph(res)) return;
    const methodId = parseIntParam(req.params.methodId);
    if (!methodId) return res.status(400).json({ error: 'methodId must be a positive integer' });
    const depth = parseIntParam(req.query.depth as string) ?? 2;
    try {
      const graph = await knowledgeGraphService.getMethodNeighborhood(methodId, depth);
      if (req.query.format === 'd3') {
        return res.json({ success: true, format: 'd3', stats: graph.stats, graph: knowledgeGraphService.exportForD3(graph) });
      }
      return res.json({ success: true, format: 'json', graph });
    } catch (err: any) {
      return res.status(500).json({ error: 'neighborhood build failed', detail: err?.message });
    }
  });

  return router;
}
