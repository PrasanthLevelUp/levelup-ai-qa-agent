/**
 * Projects & Repositories management endpoints.
 * Replaces the old repos.json flat file with database-backed project hierarchy.
 */

import { Router, type Request, type Response } from 'express';
import { logger } from '../../utils/logger';
import * as crypto from 'crypto';
import {
  createProject,
  listProjects,
  getProject,
  updateProject,
  deleteProject,
  addRepository,
  listRepositories,
  listAllRepositories,
  getRepository,
  updateRepository,
  deleteRepository,
  createWebhookConfig,
  getWebhookConfig,
  createReleaseWindow,
  listReleaseWindows,
  updateReleaseWindow,
  deleteReleaseWindow,
  getProjectStats,
  migrateDataToDefaultProjects,
} from '../../db/postgres';

const MOD = 'projects-route';

export function createProjectsRouter(): Router {
  const router = Router();

  // ─── Projects CRUD ─────────────────────────────────────────────

  // GET /api/projects — list all projects for company
  router.get('/', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projects = await listProjects(companyId);
      res.json({ projects });
    } catch (err: any) {
      logger.error(MOD, 'Failed to list projects', { error: err.message });
      res.status(500).json({ error: 'Failed to list projects' });
    }
  });

  // GET /api/projects/:id — get single project with repos
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const id = parseInt(req.params['id'] as string, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: 'Invalid project ID' });
        return;
      }
      const project = await getProject(id, companyId);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const repos = await listRepositories(id, companyId);
      res.json({ project: { ...project, repositories: repos } });
    } catch (err: any) {
      logger.error(MOD, 'Failed to get project', { error: err.message });
      res.status(500).json({ error: 'Failed to get project' });
    }
  });

  // POST /api/projects — create project
  router.post('/', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const { name, description } = req.body;
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        res.status(400).json({ error: 'Project name is required' });
        return;
      }
      const project = await createProject({
        company_id: companyId,
        name: name.trim(),
        description: description || null,
      });
      logger.info(MOD, 'Project created', { projectId: project.id, name: project.name, companyId });
      res.status(201).json({ project });
    } catch (err: any) {
      if (err.code === '23505') {
        res.status(409).json({ error: 'A project with this name already exists' });
        return;
      }
      logger.error(MOD, 'Failed to create project', { error: err.message });
      res.status(500).json({ error: 'Failed to create project' });
    }
  });

  // PUT /api/projects/:id — update project
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const id = parseInt(req.params['id'] as string, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: 'Invalid project ID' });
        return;
      }
      const updated = await updateProject(id, companyId, req.body);
      if (!updated) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      res.json({ project: updated });
    } catch (err: any) {
      logger.error(MOD, 'Failed to update project', { error: err.message });
      res.status(500).json({ error: 'Failed to update project' });
    }
  });

  // DELETE /api/projects/:id — soft delete project
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const id = parseInt(req.params['id'] as string, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: 'Invalid project ID' });
        return;
      }
      const deleted = await deleteProject(id, companyId);
      if (!deleted) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      res.json({ message: 'Project deleted' });
    } catch (err: any) {
      logger.error(MOD, 'Failed to delete project', { error: err.message });
      res.status(500).json({ error: 'Failed to delete project' });
    }
  });

  // ─── Repositories CRUD (nested under projects) ─────────────────

  // GET /api/projects/:id/repositories — list repos for a project
  router.get('/:id/repositories', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = parseInt(req.params['id'] as string, 10);
      if (isNaN(projectId)) {
        res.status(400).json({ error: 'Invalid project ID' });
        return;
      }
      const repos = await listRepositories(projectId, companyId);
      res.json({ repositories: repos });
    } catch (err: any) {
      logger.error(MOD, 'Failed to list repositories', { error: err.message });
      res.status(500).json({ error: 'Failed to list repositories' });
    }
  });

  // POST /api/projects/:id/repositories — add repo to project
  router.post('/:id/repositories', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = parseInt(req.params['id'] as string, 10);
      if (isNaN(projectId)) {
        res.status(400).json({ error: 'Invalid project ID' });
        return;
      }
      // Verify project exists and belongs to company
      const project = await getProject(projectId, companyId);
      if (!project) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      const { name, url, branch, type } = req.body;
      if (!name || !url) {
        res.status(400).json({ error: 'Repository name and url are required' });
        return;
      }
      const repo = await addRepository({
        project_id: projectId,
        company_id: companyId,
        name: name.trim(),
        url: url.trim(),
        branch: branch || 'main',
        type: type || 'web',
      });
      logger.info(MOD, 'Repository added', { repoId: repo.id, projectId, name, companyId });
      res.status(201).json({ repository: repo });
    } catch (err: any) {
      logger.error(MOD, 'Failed to add repository', { error: err.message });
      res.status(500).json({ error: 'Failed to add repository' });
    }
  });

  // PUT /api/projects/:projectId/repositories/:repoId — update repo
  router.put('/:projectId/repositories/:repoId', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const repoId = parseInt(req.params['repoId'] as string, 10);
      if (isNaN(repoId)) {
        res.status(400).json({ error: 'Invalid repository ID' });
        return;
      }
      const updated = await updateRepository(repoId, companyId, req.body);
      if (!updated) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      res.json({ repository: updated });
    } catch (err: any) {
      logger.error(MOD, 'Failed to update repository', { error: err.message });
      res.status(500).json({ error: 'Failed to update repository' });
    }
  });

  // DELETE /api/projects/:projectId/repositories/:repoId — soft delete repo
  router.delete('/:projectId/repositories/:repoId', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const repoId = parseInt(req.params['repoId'] as string, 10);
      if (isNaN(repoId)) {
        res.status(400).json({ error: 'Invalid repository ID' });
        return;
      }
      const deleted = await deleteRepository(repoId, companyId);
      if (!deleted) {
        res.status(404).json({ error: 'Repository not found' });
        return;
      }
      res.json({ message: 'Repository removed' });
    } catch (err: any) {
      logger.error(MOD, 'Failed to delete repository', { error: err.message });
      res.status(500).json({ error: 'Failed to delete repository' });
    }
  });

  // ─── Project Stats ─────────────────────────────────────────────

  // GET /api/projects/:id/stats — get project resource counts
  router.get('/:id/stats', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = parseInt(req.params['id'] as string, 10);
      if (isNaN(projectId)) {
        res.status(400).json({ error: 'Invalid project ID' });
        return;
      }
      const stats = await getProjectStats(projectId, companyId);
      res.json({ stats });
    } catch (err: any) {
      logger.error(MOD, 'Failed to get project stats', { error: err.message });
      res.status(500).json({ error: 'Failed to get project stats' });
    }
  });

  // ─── Data Migration ──────────────────────────────────────────

  // POST /api/projects/migrate — Migrate orphaned data to default projects
  router.post('/migrate', async (_req: Request, res: Response) => {
    try {
      const result = await migrateDataToDefaultProjects();
      res.json({ success: true, ...result });
    } catch (err: any) {
      logger.error(MOD, 'Migration failed', { error: err.message });
      res.status(500).json({ error: 'Migration failed' });
    }
  });

  // ─── Convenience: list ALL repos for company (flat, across all projects) ──

  // GET /api/projects/all/repositories — all repos across all projects
  router.get('/all/repositories', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const repos = await listAllRepositories(companyId);
      res.json({ repositories: repos });
    } catch (err: any) {
      logger.error(MOD, 'Failed to list all repositories', { error: err.message });
      res.status(500).json({ error: 'Failed to list repositories' });
    }
  });

  // ─── Release Cycle Configuration ───────────────────────────────

  // PUT /api/projects/:id/release-config — Update release cycle settings
  router.put('/:id/release-config', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const id = parseInt(req.params['id'] as string, 10);
      if (isNaN(id)) {
        res.status(400).json({ error: 'Invalid project ID' });
        return;
      }
      const { release_cycle_type, release_cycle_days, release_day_of_week, release_timezone, overview_default_range } = req.body;
      const validTypes = ['continuous', 'sprint', 'monthly', 'quarterly', 'custom'];
      if (release_cycle_type && !validTypes.includes(release_cycle_type)) {
        res.status(400).json({ error: `Invalid release_cycle_type. Must be one of: ${validTypes.join(', ')}` });
        return;
      }
      const updated = await updateProject(id, companyId, {
        release_cycle_type,
        release_cycle_days,
        release_day_of_week,
        release_timezone,
        overview_default_range,
      });
      if (!updated) {
        res.status(404).json({ error: 'Project not found' });
        return;
      }
      logger.info(MOD, 'Release config updated', { projectId: id, type: release_cycle_type });
      res.json({ project: updated });
    } catch (err: any) {
      logger.error(MOD, 'Failed to update release config', { error: err.message });
      res.status(500).json({ error: 'Failed to update release config' });
    }
  });

  // ─── Release Windows CRUD ─────────────────────────────────────

  // GET /api/projects/:id/release-windows — List release windows
  router.get('/:id/release-windows', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = parseInt(req.params['id'] as string, 10);
      if (isNaN(projectId)) {
        res.status(400).json({ error: 'Invalid project ID' });
        return;
      }
      const windows = await listReleaseWindows(projectId, companyId);
      res.json({ windows });
    } catch (err: any) {
      logger.error(MOD, 'Failed to list release windows', { error: err.message });
      res.status(500).json({ error: 'Failed to list release windows' });
    }
  });

  // POST /api/projects/:id/release-windows — Create release window
  router.post('/:id/release-windows', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = parseInt(req.params['id'] as string, 10);
      if (isNaN(projectId)) {
        res.status(400).json({ error: 'Invalid project ID' });
        return;
      }
      const { name, startDate, endDate, status } = req.body;
      if (!name || !startDate || !endDate) {
        res.status(400).json({ error: 'name, startDate, and endDate are required' });
        return;
      }
      const window = await createReleaseWindow({ projectId, companyId, name, startDate, endDate, status });
      logger.info(MOD, 'Release window created', { windowId: window.id, projectId });
      res.status(201).json({ window });
    } catch (err: any) {
      logger.error(MOD, 'Failed to create release window', { error: err.message });
      res.status(500).json({ error: 'Failed to create release window' });
    }
  });

  // PUT /api/projects/:projectId/release-windows/:windowId — Update release window
  router.put('/:projectId/release-windows/:windowId', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const windowId = parseInt(req.params['windowId'] as string, 10);
      if (isNaN(windowId)) {
        res.status(400).json({ error: 'Invalid window ID' });
        return;
      }
      const updated = await updateReleaseWindow(windowId, companyId, req.body);
      if (!updated) {
        res.status(404).json({ error: 'Release window not found' });
        return;
      }
      res.json({ window: updated });
    } catch (err: any) {
      logger.error(MOD, 'Failed to update release window', { error: err.message });
      res.status(500).json({ error: 'Failed to update release window' });
    }
  });

  // DELETE /api/projects/:projectId/release-windows/:windowId — Delete release window
  router.delete('/:projectId/release-windows/:windowId', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const windowId = parseInt(req.params['windowId'] as string, 10);
      if (isNaN(windowId)) {
        res.status(400).json({ error: 'Invalid window ID' });
        return;
      }
      const deleted = await deleteReleaseWindow(windowId, companyId);
      if (!deleted) {
        res.status(404).json({ error: 'Release window not found' });
        return;
      }
      res.json({ message: 'Release window deleted' });
    } catch (err: any) {
      logger.error(MOD, 'Failed to delete release window', { error: err.message });
      res.status(500).json({ error: 'Failed to delete release window' });
    }
  });

  // ─── Webhook Configuration ─────────────────────────────────────

  // POST /api/projects/:id/configure-webhook — Generate/update webhook config
  router.post('/:id/configure-webhook', async (req: Request, res: Response) => {
    try {
      const projectId = parseInt(String(req.params.id), 10);
      const companyId = (req as any).companyId;
      const { repositoryId } = req.body;

      // Generate a webhook secret
      const secret = 'whsec_' + crypto.randomBytes(24).toString('hex');

      const config = await createWebhookConfig({
        projectId,
        companyId,
        repositoryId: repositoryId ? parseInt(repositoryId, 10) : undefined,
        webhookSecret: secret,
      });

      // Build the webhook URL
      const baseUrl = process.env['PUBLIC_API_URL']
        || process.env['RAILWAY_PUBLIC_DOMAIN']
          ? `https://${process.env['RAILWAY_PUBLIC_DOMAIN']}`
          : 'https://levelup-ai-qa-agent-production.up.railway.app';
      const webhookUrl = `${baseUrl}/api/ci-webhooks/github`;

      logger.info(MOD, 'Webhook configured', { projectId, configId: config.id });

      res.json({
        success: true,
        webhook: {
          id: config.id,
          webhookUrl,
          secret,
          events: ['workflow_run'],
          contentType: 'application/json',
          instructions: {
            step1: 'Go to your GitHub repository → Settings → Webhooks → Add webhook',
            step2: `Payload URL: ${webhookUrl}`,
            step3: `Secret: ${secret}`,
            step4: 'Content type: application/json',
            step5: 'Select: "Let me select individual events" → Check "Workflow runs"',
            step6: 'Click "Add webhook"',
          },
        },
      });
    } catch (err: any) {
      logger.error(MOD, 'Failed to configure webhook', { error: err.message });
      res.status(500).json({ error: 'Failed to configure webhook' });
    }
  });

  // GET /api/projects/:id/webhook-status — Check webhook configuration
  router.get('/:id/webhook-status', async (req: Request, res: Response) => {
    try {
      const projectId = parseInt(String(req.params.id), 10);
      const companyId = (req as any).companyId;

      const config = await getWebhookConfig(projectId, companyId);

      if (!config) {
        return res.json({
          configured: false,
          message: 'No webhook configured for this project. Use POST /configure-webhook to set up.',
        });
      }

      const baseUrl = process.env['PUBLIC_API_URL']
        || process.env['RAILWAY_PUBLIC_DOMAIN']
          ? `https://${process.env['RAILWAY_PUBLIC_DOMAIN']}`
          : 'https://levelup-ai-qa-agent-production.up.railway.app';
      const webhookUrl = `${baseUrl}/api/ci-webhooks/github`;

      res.json({
        configured: true,
        webhook: {
          id: config.id,
          webhookUrl,
          repositoryName: config.repository_name || null,
          repositoryUrl: config.repository_url || null,
          eventsReceived: config.events_received,
          lastEventAt: config.last_event_at,
          isActive: config.is_active,
          createdAt: config.created_at,
        },
      });
    } catch (err: any) {
      logger.error(MOD, 'Failed to get webhook status', { error: err.message });
      res.status(500).json({ error: 'Failed to get webhook status' });
    }
  });

  return router;
}
