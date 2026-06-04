/**
 * Project Environments management endpoints (Phase 1 Foundation).
 *
 * Mounted at `/api/projects/:projectId/environments`. Uses mergeParams so the
 * parent `:projectId` is available; every handler validates the project belongs
 * to the request's company before touching environment rows.
 */

import { Router, type Request, type Response } from 'express';
import { logger } from '../../utils/logger';
import {
  validateProjectAccess,
  listEnvironments,
  getEnvironment,
  getDefaultEnvironment,
  createEnvironment,
  updateEnvironment,
  setDefaultEnvironment,
  deleteEnvironment,
  getEnvironmentUsageStats,
  recordEnvironmentHealth,
} from '../../db/postgres';
import { environmentService } from '../../services/environment-service';

const MOD = 'environments-route';

/** Resolve + authorise the project from the URL param. Returns id or null (and writes the error response). */
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

export function createEnvironmentsRouter(): Router {
  const router = Router({ mergeParams: true });

  // GET / — list environments
  router.get('/', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProject(req, res);
      if (projectId === null) return;
      const includeInactive = req.query['includeInactive'] === 'true';
      const environments = await listEnvironments(projectId, { includeInactive });
      res.json({ environments });
    } catch (err: any) {
      logger.error(MOD, 'Failed to list environments', { error: err.message });
      res.status(500).json({ error: 'Failed to list environments' });
    }
  });

  // GET /default — project default environment
  router.get('/default', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProject(req, res);
      if (projectId === null) return;
      const environment = await getDefaultEnvironment(projectId);
      res.json({ environment });
    } catch (err: any) {
      logger.error(MOD, 'Failed to get default environment', { error: err.message });
      res.status(500).json({ error: 'Failed to get default environment' });
    }
  });

  // POST / — create environment
  router.post('/', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProject(req, res);
      if (projectId === null) return;
      const companyId = (req as any).companyId as number | undefined;
      const userId = (req as any).userId as number | undefined;
      const { name, base_url, description, environment_type, is_default } = req.body || {};
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        res.status(400).json({ error: 'Environment name is required' });
        return;
      }
      const environment = await createEnvironment({
        company_id: companyId ?? null,
        project_id: projectId,
        name: name.trim(),
        base_url: base_url ?? null,
        description: description ?? null,
        environment_type: environment_type ?? null,
        is_default: is_default === true,
        created_by: userId ?? null,
      });
      logger.info(MOD, 'Environment created', { projectId, environmentId: environment.id });
      res.status(201).json({ environment });
    } catch (err: any) {
      if (err.code === '23505') {
        res.status(409).json({ error: 'An environment with this name already exists for the project' });
        return;
      }
      logger.error(MOD, 'Failed to create environment', { error: err.message });
      res.status(500).json({ error: 'Failed to create environment' });
    }
  });

  // GET /:id — single environment
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProject(req, res);
      if (projectId === null) return;
      const id = parseInt(String(req.params['id']), 10);
      if (isNaN(id)) { res.status(400).json({ error: 'Invalid environment ID' }); return; }
      const environment = await getEnvironment(id, projectId);
      if (!environment) { res.status(404).json({ error: 'Environment not found' }); return; }
      res.json({ environment });
    } catch (err: any) {
      logger.error(MOD, 'Failed to get environment', { error: err.message });
      res.status(500).json({ error: 'Failed to get environment' });
    }
  });

  // GET /:id/usage — usage stats
  router.get('/:id/usage', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProject(req, res);
      if (projectId === null) return;
      const id = parseInt(String(req.params['id']), 10);
      if (isNaN(id)) { res.status(400).json({ error: 'Invalid environment ID' }); return; }
      const usage = await getEnvironmentUsageStats(id, projectId);
      res.json({ usage });
    } catch (err: any) {
      logger.error(MOD, 'Failed to get environment usage', { error: err.message });
      res.status(500).json({ error: 'Failed to get environment usage' });
    }
  });

  // PUT /:id — update environment
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProject(req, res);
      if (projectId === null) return;
      const id = parseInt(String(req.params['id']), 10);
      if (isNaN(id)) { res.status(400).json({ error: 'Invalid environment ID' }); return; }
      const { name, base_url, description, environment_type, is_default, is_active } = req.body || {};
      const updated = await updateEnvironment(id, projectId, {
        name, base_url, description, environment_type, is_default, is_active,
      });
      if (!updated) { res.status(404).json({ error: 'Environment not found' }); return; }
      res.json({ environment: updated });
    } catch (err: any) {
      if (err.code === '23505') {
        res.status(409).json({ error: 'An environment with this name already exists for the project' });
        return;
      }
      logger.error(MOD, 'Failed to update environment', { error: err.message });
      res.status(500).json({ error: 'Failed to update environment' });
    }
  });

  // POST /:id/set-default — mark as default
  router.post('/:id/set-default', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProject(req, res);
      if (projectId === null) return;
      const id = parseInt(String(req.params['id']), 10);
      if (isNaN(id)) { res.status(400).json({ error: 'Invalid environment ID' }); return; }
      const environment = await setDefaultEnvironment(id, projectId);
      if (!environment) { res.status(404).json({ error: 'Environment not found' }); return; }
      res.json({ environment });
    } catch (err: any) {
      logger.error(MOD, 'Failed to set default environment', { error: err.message });
      res.status(500).json({ error: 'Failed to set default environment' });
    }
  });

  // POST /:id/health-check — probe base URL + persist status
  router.post('/:id/health-check', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProject(req, res);
      if (projectId === null) return;
      const id = parseInt(String(req.params['id']), 10);
      if (isNaN(id)) { res.status(400).json({ error: 'Invalid environment ID' }); return; }
      const environment = await getEnvironment(id, projectId);
      if (!environment) { res.status(404).json({ error: 'Environment not found' }); return; }
      const result = await environmentService.healthCheck(environment);
      await recordEnvironmentHealth(id, projectId, result.status).catch(() => undefined);
      res.json({ health: result });
    } catch (err: any) {
      logger.error(MOD, 'Failed to run health check', { error: err.message });
      res.status(500).json({ error: 'Failed to run health check' });
    }
  });

  // DELETE /:id — soft delete environment
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const projectId = await resolveProject(req, res);
      if (projectId === null) return;
      const id = parseInt(String(req.params['id']), 10);
      if (isNaN(id)) { res.status(400).json({ error: 'Invalid environment ID' }); return; }
      const ok = await deleteEnvironment(id, projectId);
      if (!ok) { res.status(404).json({ error: 'Environment not found' }); return; }
      res.json({ success: true });
    } catch (err: any) {
      logger.error(MOD, 'Failed to delete environment', { error: err.message });
      res.status(500).json({ error: 'Failed to delete environment' });
    }
  });

  return router;
}
