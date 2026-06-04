/**
 * Project Sprints management endpoints (Phase 1 Foundation).
 *
 * Mounted at `/api/projects/:projectId/sprints`. Uses mergeParams so the parent
 * `:projectId` is available; every handler validates the project belongs to the
 * request's company before touching sprint rows.
 */

import { Router, type Request, type Response } from 'express';
import { logger } from '../../utils/logger';
import {
  validateProjectAccess,
  listSprints,
  getSprint,
  createSprint,
  updateSprint,
  deleteSprint,
} from '../../db/postgres';
import { sprintService } from '../../services/sprint-service';

const MOD = 'sprints-route';

async function resolveProject(req: Request, res: Response): Promise<number | null> {
  const companyId = (req as any).companyId as number | undefined;
  const projectId = parseInt(String(req.params['projectId']), 10);
  if (isNaN(projectId) || projectId <= 0) {
    res.status(400).json({ error: 'Invalid project ID' });
    return null;
  }
  if (companyId) {
    const project = await validateProjectAccess(projectId, companyId);
    if (!project) {
      res.status(403).json({ error: 'Project not found or access denied', code: 'PROJECT_ACCESS_DENIED' });
      return null;
    }
  }
  return projectId;
}

export function createSprintsRouter(): Router {
  const router = Router({ mergeParams: true });

  // GET / — list sprints (optional ?status=, ?limit=)
  router.get('/', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProject(req, res);
      if (projectId === null) return;
      const status = req.query['status'] ? String(req.query['status']) : undefined;
      const limit = req.query['limit'] ? parseInt(String(req.query['limit']), 10) : undefined;
      const sprints = await listSprints(projectId, { status, limit: isNaN(limit as any) ? undefined : limit });
      res.json({ sprints });
    } catch (err: any) {
      logger.error(MOD, 'Failed to list sprints', { error: err.message });
      res.status(500).json({ error: 'Failed to list sprints' });
    }
  });

  // GET /current — current sprint + progress
  router.get('/current', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProject(req, res);
      if (projectId === null) return;
      const sprint = await sprintService.getCurrentSprint(projectId);
      const progress = sprint ? sprintService.computeProgress(sprint) : null;
      res.json({ sprint, progress });
    } catch (err: any) {
      logger.error(MOD, 'Failed to get current sprint', { error: err.message });
      res.status(500).json({ error: 'Failed to get current sprint' });
    }
  });

  // POST /next — create the next sprint (date/name auto-derived)
  router.post('/next', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProject(req, res);
      if (projectId === null) return;
      const companyId = (req as any).companyId as number | undefined;
      const userId = (req as any).userId as number | undefined;
      const activate = req.body?.activate === true;
      const sprint = await sprintService.createNextSprint(projectId, { companyId, createdBy: userId ?? null, activate });
      res.status(201).json({ sprint });
    } catch (err: any) {
      logger.error(MOD, 'Failed to create next sprint', { error: err.message });
      res.status(500).json({ error: 'Failed to create next sprint' });
    }
  });

  // POST / — create a sprint
  router.post('/', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProject(req, res);
      if (projectId === null) return;
      const companyId = (req as any).companyId as number | undefined;
      const userId = (req as any).userId as number | undefined;
      const { name, sprint_type, start_date, end_date, status, is_current, goals } = req.body || {};
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        res.status(400).json({ error: 'Sprint name is required' });
        return;
      }
      const sprint = await createSprint({
        company_id: companyId ?? null,
        project_id: projectId,
        name: name.trim(),
        sprint_type: sprint_type ?? null,
        start_date: start_date ?? null,
        end_date: end_date ?? null,
        status: status ?? null,
        is_current: is_current === true,
        goals: goals ?? null,
        created_by: userId ?? null,
      });
      logger.info(MOD, 'Sprint created', { projectId, sprintId: sprint.id });
      res.status(201).json({ sprint });
    } catch (err: any) {
      logger.error(MOD, 'Failed to create sprint', { error: err.message });
      res.status(500).json({ error: 'Failed to create sprint' });
    }
  });

  // GET /:id — single sprint
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProject(req, res);
      if (projectId === null) return;
      const id = parseInt(String(req.params['id']), 10);
      if (isNaN(id)) { res.status(400).json({ error: 'Invalid sprint ID' }); return; }
      const sprint = await getSprint(id, projectId);
      if (!sprint) { res.status(404).json({ error: 'Sprint not found' }); return; }
      res.json({ sprint, progress: sprintService.computeProgress(sprint) });
    } catch (err: any) {
      logger.error(MOD, 'Failed to get sprint', { error: err.message });
      res.status(500).json({ error: 'Failed to get sprint' });
    }
  });

  // GET /:id/metrics — aggregated QA metrics
  router.get('/:id/metrics', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProject(req, res);
      if (projectId === null) return;
      const id = parseInt(String(req.params['id']), 10);
      if (isNaN(id)) { res.status(400).json({ error: 'Invalid sprint ID' }); return; }
      const metrics = await sprintService.getSprintMetrics(id, projectId);
      res.json({ metrics });
    } catch (err: any) {
      logger.error(MOD, 'Failed to get sprint metrics', { error: err.message });
      res.status(500).json({ error: 'Failed to get sprint metrics' });
    }
  });

  // PUT /:id — update sprint
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProject(req, res);
      if (projectId === null) return;
      const id = parseInt(String(req.params['id']), 10);
      if (isNaN(id)) { res.status(400).json({ error: 'Invalid sprint ID' }); return; }
      const { name, sprint_type, start_date, end_date, status, is_current, goals } = req.body || {};
      const updated = await updateSprint(id, projectId, {
        name, sprint_type, start_date, end_date, status, is_current, goals,
      });
      if (!updated) { res.status(404).json({ error: 'Sprint not found' }); return; }
      res.json({ sprint: updated });
    } catch (err: any) {
      logger.error(MOD, 'Failed to update sprint', { error: err.message });
      res.status(500).json({ error: 'Failed to update sprint' });
    }
  });

  // POST /:id/activate — mark as current/active
  router.post('/:id/activate', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProject(req, res);
      if (projectId === null) return;
      const id = parseInt(String(req.params['id']), 10);
      if (isNaN(id)) { res.status(400).json({ error: 'Invalid sprint ID' }); return; }
      const sprint = await sprintService.activateSprint(id, projectId);
      if (!sprint) { res.status(404).json({ error: 'Sprint not found' }); return; }
      res.json({ sprint });
    } catch (err: any) {
      logger.error(MOD, 'Failed to activate sprint', { error: err.message });
      res.status(500).json({ error: 'Failed to activate sprint' });
    }
  });

  // POST /:id/complete — complete sprint (+ optional auto-rollover)
  router.post('/:id/complete', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProject(req, res);
      if (projectId === null) return;
      const id = parseInt(String(req.params['id']), 10);
      if (isNaN(id)) { res.status(400).json({ error: 'Invalid sprint ID' }); return; }
      const companyId = (req as any).companyId as number | undefined;
      const userId = (req as any).userId as number | undefined;
      const { completed, next } = await sprintService.completeSprint(id, projectId, { companyId, createdBy: userId ?? null });
      if (!completed) { res.status(404).json({ error: 'Sprint not found' }); return; }
      res.json({ sprint: completed, next });
    } catch (err: any) {
      logger.error(MOD, 'Failed to complete sprint', { error: err.message });
      res.status(500).json({ error: 'Failed to complete sprint' });
    }
  });

  // DELETE /:id — delete sprint
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProject(req, res);
      if (projectId === null) return;
      const id = parseInt(String(req.params['id']), 10);
      if (isNaN(id)) { res.status(400).json({ error: 'Invalid sprint ID' }); return; }
      const ok = await deleteSprint(id, projectId);
      if (!ok) { res.status(404).json({ error: 'Sprint not found' }); return; }
      res.json({ success: true });
    } catch (err: any) {
      logger.error(MOD, 'Failed to delete sprint', { error: err.message });
      res.status(500).json({ error: 'Failed to delete sprint' });
    }
  });

  return router;
}
