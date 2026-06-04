/**
 * API Routes — Requirements Traceability Matrix (RTM), Sprint 1
 * =============================================================
 * CRUD for requirements plus coverage read endpoints. Scope (companyId /
 * projectId / userId) is injected by the auth / company / project-context
 * middleware chain applied at registration time in server.ts — this router
 * only reads `(req as any).companyId` etc.
 *
 * Route ordering note: static paths (e.g. /coverage-summary) MUST be declared
 * before the parametric `/:id` routes, otherwise Express matches them as an id.
 */

import { Router, type Request, type Response } from 'express';
import { logger } from '../../utils/logger';
import { getContextFromRequest } from '../middleware/context';
import {
  createRequirement,
  getRequirements,
  getRequirement,
  updateRequirement,
  deleteRequirement,
  getRequirementCoverage,
  getCoverageSummary,
  getTestCasesForRequirement,
  getRequirementAutomationCoverage,
} from '../../db/postgres';

const MOD = 'requirements-routes';

const VALID_PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];

export function createRequirementsRouter(): Router {
  const router = Router();

  /* ─── Coverage summary (STATIC — must precede /:id) ──────────────── */
  router.get('/coverage-summary', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId ?? null;
      const summary = await getCoverageSummary(companyId, projectId);
      res.json({ success: true, data: summary });
    } catch (error: any) {
      logger.error(MOD, 'Failed to get coverage summary', { error: error?.message });
      res.status(500).json({ success: false, error: 'Failed to get coverage summary' });
    }
  });

  /* ─── Create requirement ─────────────────────────────────────────── */
  router.post('/', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId ?? null;
      const userId = (req as any).userId ?? null;
      // Write-path attribution — environment / sprint selected in the dashboard.
      // Undefined values let the DB triggers stamp the project defaults.
      const { environmentId, sprintId } = getContextFromRequest(req);
      const {
        title,
        description,
        category,
        priority,
        acceptanceCriteria,
        acceptance_criteria,
        status,
        tags,
        metadata,
      } = req.body || {};

      if (!title || typeof title !== 'string' || !title.trim()) {
        return res.status(400).json({ success: false, error: 'title is required' });
      }
      if (priority && !VALID_PRIORITIES.includes(priority)) {
        return res.status(400).json({
          success: false,
          error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}`,
        });
      }
      if (tags && !Array.isArray(tags)) {
        return res.status(400).json({ success: false, error: 'tags must be an array of strings' });
      }

      const requirement = await createRequirement({
        companyId,
        projectId,
        title: title.trim(),
        description: description ?? null,
        category: category ?? null,
        priority: priority ?? null,
        acceptanceCriteria: acceptanceCriteria ?? acceptance_criteria ?? null,
        status: status ?? null,
        tags: tags ?? null,
        createdBy: userId,
        metadata: metadata ?? null,
        environmentId: environmentId ?? null,
        sprintId: sprintId ?? null,
      });

      logger.info(MOD, 'Requirement created', {
        id: requirement.id,
        requirementId: requirement.requirement_id,
        companyId,
        projectId,
      });
      res.status(201).json({ success: true, data: requirement });
    } catch (error: any) {
      logger.error(MOD, 'Failed to create requirement', { error: error?.message });
      res.status(500).json({ success: false, error: 'Failed to create requirement' });
    }
  });

  /* ─── List requirements ──────────────────────────────────────────── */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId ?? null;
      const { category, priority, status, search } = req.query;

      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
      const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : undefined;

      const { requirements, total } = await getRequirements({
        companyId,
        projectId,
        category: category ? String(category) : undefined,
        priority: priority ? String(priority) : undefined,
        status: status ? String(status) : undefined,
        search: search ? String(search) : undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
        offset: Number.isFinite(offset) ? offset : undefined,
      });

      res.json({ success: true, data: requirements, total });
    } catch (error: any) {
      logger.error(MOD, 'Failed to list requirements', { error: error?.message });
      res.status(500).json({ success: false, error: 'Failed to list requirements' });
    }
  });

  /* ─── Get single requirement ─────────────────────────────────────── */
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const requirement = await getRequirement(String(req.params.id), companyId);
      if (!requirement) {
        return res.status(404).json({ success: false, error: 'Requirement not found' });
      }
      res.json({ success: true, data: requirement });
    } catch (error: any) {
      logger.error(MOD, 'Failed to get requirement', { error: error?.message });
      res.status(500).json({ success: false, error: 'Failed to get requirement' });
    }
  });

  /* ─── Requirement coverage detail ────────────────────────────────── */
  router.get('/:id/coverage', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const coverage = await getRequirementCoverage(String(req.params.id), companyId);
      if (!coverage) {
        return res.status(404).json({ success: false, error: 'Requirement not found' });
      }
      res.json({ success: true, data: coverage });
    } catch (error: any) {
      logger.error(MOD, 'Failed to get requirement coverage', { error: error?.message });
      res.status(500).json({ success: false, error: 'Failed to get requirement coverage' });
    }
  });

  /* ─── Test cases for a requirement (Sprint 4B) ───────────────────────
   * Lists the test cases linked to a requirement (RTM UUID FK) along with
   * their automation status — powers the requirement → test-case selector and
   * the automation badges. `?include_automation_status=true` is accepted for
   * forward-compat; automation fields are always returned regardless. */
  router.get('/:id/test-cases', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const testCases = await getTestCasesForRequirement(String(req.params.id), companyId);
      res.json({ success: true, data: testCases, count: testCases.length });
    } catch (error: any) {
      logger.error(MOD, 'Failed to list requirement test cases', { error: error?.message });
      res.status(500).json({ success: false, error: 'Failed to list requirement test cases' });
    }
  });

  /* ─── Automation coverage for a requirement (Sprint 4B) ──────────────
   * Returns { totalTestCases, automatedCount, automationPercentage }. */
  router.get('/:id/automation-coverage', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const coverage = await getRequirementAutomationCoverage(String(req.params.id), companyId);
      res.json({ success: true, data: coverage });
    } catch (error: any) {
      logger.error(MOD, 'Failed to get requirement automation coverage', { error: error?.message });
      res.status(500).json({ success: false, error: 'Failed to get requirement automation coverage' });
    }
  });

  /* ─── Update requirement ─────────────────────────────────────────── */
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const {
        title,
        description,
        category,
        priority,
        acceptanceCriteria,
        acceptance_criteria,
        status,
        tags,
        metadata,
      } = req.body || {};

      if (priority !== undefined && !VALID_PRIORITIES.includes(priority)) {
        return res.status(400).json({
          success: false,
          error: `priority must be one of: ${VALID_PRIORITIES.join(', ')}`,
        });
      }
      if (tags !== undefined && tags !== null && !Array.isArray(tags)) {
        return res.status(400).json({ success: false, error: 'tags must be an array of strings' });
      }

      const updated = await updateRequirement(String(req.params.id), companyId, {
        title,
        description,
        category,
        priority,
        acceptanceCriteria: acceptanceCriteria ?? acceptance_criteria,
        status,
        tags,
        metadata,
      });

      if (!updated) {
        return res.status(404).json({ success: false, error: 'Requirement not found' });
      }
      logger.info(MOD, 'Requirement updated', { id: updated.id, companyId });
      res.json({ success: true, data: updated });
    } catch (error: any) {
      logger.error(MOD, 'Failed to update requirement', { error: error?.message });
      res.status(500).json({ success: false, error: 'Failed to update requirement' });
    }
  });

  /* ─── Delete (soft) requirement ──────────────────────────────────── */
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const deleted = await deleteRequirement(String(req.params.id), companyId);
      if (!deleted) {
        return res.status(404).json({ success: false, error: 'Requirement not found' });
      }
      logger.info(MOD, 'Requirement deleted', { id: String(req.params.id), companyId });
      res.json({ success: true });
    } catch (error: any) {
      logger.error(MOD, 'Failed to delete requirement', { error: error?.message });
      res.status(500).json({ success: false, error: 'Failed to delete requirement' });
    }
  });

  return router;
}
