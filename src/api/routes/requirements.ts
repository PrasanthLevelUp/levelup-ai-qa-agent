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
import { ManualRenderer } from '../../renderers/scenario-renderer';
import type { CanonicalScenario, ManualTestCase } from '../../renderers/scenario-renderer';
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
  recalculateAllRequirementCoverage,
  getRequirementBySourceId,
  updateRequirementFromSource,
} from '../../db/postgres';
import {
  getStoredJiraConfig,
  fetchProjects,
  fetchIssueTypes,
  searchIssues,
  searchIssuesByKeys,
  type JiraImportedIssue,
} from '../../integrations/jira';
import { parseIssueKeys } from '../../integrations/jira-issue-keys';

const MOD = 'requirements-routes';

const VALID_PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];

/**
 * PHASE B — Project canonical scenarios (DB rows) to Manual test cases.
 * Same logic as test-coverage.ts — one canonical scenario, projected per consumer.
 */
function projectToManual(dbRows: any[]): any[] {
  const renderer = new ManualRenderer();
  return dbRows.map(row => {
    const metadata = row.ai_metadata || {};
    const canonical: CanonicalScenario = {
      schemaVersion: 2,
      title: row.title || '',
      objective: metadata.objective || '',
      scenarioIndex: 0,
      scenarioId: row.id?.toString() || '',
      riskArea: metadata.riskArea || row.risk_area || '',
      preconditions: row.preconditions || '',
      steps: Array.isArray(row.steps) ? row.steps : [],
      grounding: metadata.grounding,
      expected: metadata.expected,
      expectedResult: row.expected_result || '',
      testData: row.test_data || '',
      selectors: [],
      priority: row.priority || 'P2',
      severity: row.severity || 'major',
      tags: Array.isArray(row.tags) ? row.tags : [],
      automationReady: row.automation_ready ?? false,
      automationComplexity: row.automation_complexity || 'medium',
      selectorAvailability: row.selector_availability || 'unknown',
      source: metadata.source || 'knowledge',
      sourceEvidence: metadata.sourceEvidence || '',
    };
    // Business projection: clean steps + observable expected (NO selectors).
    const manual: ManualTestCase = renderer.render(canonical);
    // Preserve the DB row envelope (id, automation_status, is_automated,
    // script_count, requirement_id, created_at…) that the Script-Gen requirement
    // picker depends on — a bare ManualTestCase dropped `id`, breaking the
    // "Load a test case" flow (Number(undefined) → NaN). Overlay the business
    // projection in the snake_case transport shape; hide technical grounding.
    const { grounding: _grounding, expected: metaExpected, ...safeMetadata } = metadata as any;
    const safeExpected = metaExpected
      ? { observable: metaExpected.observable, business: metaExpected.business }
      : undefined;
    return {
      ...row,
      title: manual.title,
      preconditions: manual.preconditions,
      steps: manual.steps,
      expected_result: manual.expected,
      test_data: manual.testData,
      priority: manual.priority,
      severity: manual.severity,
      tags: manual.tags,
      ai_metadata: safeExpected ? { ...safeMetadata, expected: safeExpected } : safeMetadata,
    };
  });
}

/** Map a Jira priority name onto our fixed priority vocabulary. */
function mapJiraPriority(name?: string): string {
  switch ((name || '').toLowerCase()) {
    case 'highest':
    case 'blocker':
      return 'Critical';
    case 'high':
      return 'High';
    case 'low':
    case 'lowest':
    case 'trivial':
      return 'Low';
    default:
      return 'Medium';
  }
}

/** Map a Jira status name onto our requirement status vocabulary. */
function mapJiraStatus(name?: string): string {
  const s = (name || '').toLowerCase();
  if (s.includes('done') || s.includes('closed') || s.includes('resolved')) return 'Passed';
  if (s.includes('progress') || s.includes('review') || s.includes('testing')) return 'In Progress';
  return 'Not Tested';
}

/** Derive a coarse category from the Jira issue type. Kept intentionally simple. */
function mapJiraCategory(issueType?: string): string | null {
  const t = (issueType || '').toLowerCase();
  if (t === 'bug') return 'Bug';
  if (t === 'epic') return 'Epic';
  return null; // Story / Task -> let it stay uncategorized (user can set it)
}

/** Scope + context under which imported requirements are persisted. */
interface ImportContext {
  companyId: any;
  projectId: any;
  userId: any;
  environmentId: any;
  sprintId: any;
}

/** Summary returned by the shared Jira import routine. */
interface ImportSummary {
  imported: number;
  updated: number;
  skipped: number;
  total: number;
  requirements: any[];
}

/**
 * Persist a batch of fetched Jira issues as requirements. This is the ONE
 * shared import routine — both "Import All" (by project/type) and "Import by
 * Issue Key" fetch issues differently but converge here, so conversion,
 * dedup-by-source, and persistence behave identically. Re-importing an issue
 * UPDATES it in place (matched by source + source_id) instead of duplicating.
 */
async function importIssuesAsRequirements(
  issues: JiraImportedIssue[],
  projectKey: string,
  ctx: ImportContext,
): Promise<ImportSummary> {
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  const requirements: any[] = [];

  for (const issue of issues) {
    // Build the metadata envelope of live Jira facts shown in the Hub.
    const jiraMeta = {
      source: 'jira',
      sourceId: issue.key,
      jira: {
        key: issue.key,
        issueType: issue.issueType,
        status: issue.status,
        priority: issue.priority ?? null,
        assignee: issue.assignee ?? null,
        sprint: issue.sprint ?? null,
        labels: issue.labels ?? [],
        updated: issue.updated ?? null,
        url: issue.url,
        projectKey: projectKey || issue.key.split('-')[0],
      },
    };

    const existing = await getRequirementBySourceId({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      source: 'jira',
      sourceId: issue.key,
    });

    if (existing) {
      const row = await updateRequirementFromSource(existing.id, ctx.companyId, {
        title: issue.summary,
        description: issue.description || null,
        priority: mapJiraPriority(issue.priority),
        metadata: { ...(existing.metadata || {}), ...jiraMeta },
        syncStatus: 'synced',
      });
      if (row) {
        updated++;
        requirements.push(row);
      } else {
        skipped++;
      }
      continue;
    }

    const row = await createRequirement({
      companyId: ctx.companyId,
      projectId: ctx.projectId,
      title: issue.summary,
      description: issue.description || null,
      category: mapJiraCategory(issue.issueType),
      priority: mapJiraPriority(issue.priority),
      acceptanceCriteria: null,
      status: mapJiraStatus(issue.status),
      tags: issue.labels && issue.labels.length ? issue.labels : null,
      createdBy: ctx.userId,
      metadata: jiraMeta,
      source: 'jira',
      sourceId: issue.key,
      syncStatus: 'synced',
      // Environment intentionally omitted — requirements are env-independent.
      environmentId: null,
      sprintId: ctx.sprintId ?? null,
    });
    imported++;
    requirements.push(row);
  }

  return { imported, updated, skipped, total: issues.length, requirements };
}

export function createRequirementsRouter(): Router {
  const router = Router();

  /* ─── Jira: list projects (STATIC — must precede /:id) ─────────────
   * Uses the STORED, already-connected Jira config so the user never re-enters
   * credentials in the Requirements Hub. 400 if Jira isn't connected. */
  router.get('/jira/projects', async (_req: Request, res: Response) => {
    try {
      const config = await getStoredJiraConfig();
      if (!config) {
        return res.status(400).json({
          success: false,
          error: 'Jira is not connected. Connect it under Tools → Jira first.',
          code: 'JIRA_NOT_CONNECTED',
        });
      }
      const projects = await fetchProjects(config);
      res.json({ success: true, data: projects });
    } catch (error: any) {
      logger.error(MOD, 'GET /jira/projects failed', { error: error?.message });
      res.status(500).json({ success: false, error: 'Failed to fetch Jira projects' });
    }
  });

  /* ─── Jira: list issue types for a project (STATIC) ──────────────── */
  router.get('/jira/issue-types', async (req: Request, res: Response) => {
    try {
      const projectKey = req.query.projectKey ? String(req.query.projectKey) : '';
      if (!projectKey) {
        return res.status(400).json({ success: false, error: 'projectKey is required' });
      }
      const config = await getStoredJiraConfig();
      if (!config) {
        return res.status(400).json({
          success: false,
          error: 'Jira is not connected. Connect it under Tools → Jira first.',
          code: 'JIRA_NOT_CONNECTED',
        });
      }
      const types = await fetchIssueTypes(config, projectKey);
      // Requirements are authored from top-level work items, never sub-tasks.
      res.json({ success: true, data: types.filter((t) => !t.subtask) });
    } catch (error: any) {
      logger.error(MOD, 'GET /jira/issue-types failed', { error: error?.message });
      res.status(500).json({ success: false, error: 'Failed to fetch Jira issue types' });
    }
  });

  /* ─── Jira: import issues as requirements (STATIC) ───────────────────
   * Body: { projectKey, issueTypes: string[], maxResults? }
   * Each imported issue becomes (or updates) a requirement scoped to the
   * current company/project. Re-importing an already-imported issue UPDATES it
   * in place (matched by source + source_id) instead of duplicating. Returns a
   * summary { imported, updated, skipped, total, requirements }. */
  router.post('/jira/import', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId ?? null;
      const userId = (req as any).userId ?? null;
      const { environmentId, sprintId } = getContextFromRequest(req);

      const { projectKey, issueTypes, maxResults } = req.body || {};
      if (!projectKey || typeof projectKey !== 'string') {
        return res.status(400).json({ success: false, error: 'projectKey is required' });
      }
      const types: string[] = Array.isArray(issueTypes) ? issueTypes.filter((t) => typeof t === 'string') : [];

      const config = await getStoredJiraConfig();
      if (!config) {
        return res.status(400).json({
          success: false,
          error: 'Jira is not connected. Connect it under Tools → Jira first.',
          code: 'JIRA_NOT_CONNECTED',
        });
      }

      const cap = Math.min(Math.max(Number(maxResults) || 100, 1), 200);
      const issues: JiraImportedIssue[] = await searchIssues(config, projectKey, types, cap);

      const summary = await importIssuesAsRequirements(issues, projectKey, {
        companyId, projectId, userId, environmentId, sprintId,
      });

      logger.info(MOD, 'Jira import complete', {
        companyId, projectId, projectKey, types,
        imported: summary.imported, updated: summary.updated, skipped: summary.skipped, total: summary.total,
      });

      res.json({ success: true, data: summary });
    } catch (error: any) {
      logger.error(MOD, 'POST /jira/import failed', { error: error?.message });
      res.status(500).json({ success: false, error: 'Failed to import from Jira' });
    }
  });

  /* ─── Jira: import specific issues by key (STATIC) ───────────────────
   * Body: { issueKeys: string | string[] }  (projectId optional; kept for
   * forward-compat but not required — keys carry their own project prefix).
   * Accepts comma/newline-separated keys or pasted Jira browse URLs. Keys are
   * normalized + validated BEFORE calling Jira; invalid keys are rejected up
   * front and never sent to Jira. Reuses the SAME import pipeline as the
   * project-wide import (fetch → convert → dedup → persist). Returns
   * { imported, updated, skipped, total, requested, notFound[], invalid[],
   *   requirements }. */
  router.post('/jira/import-by-keys', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId ?? null;
      const userId = (req as any).userId ?? null;
      const { environmentId, sprintId } = getContextFromRequest(req);

      const { issueKeys } = req.body || {};
      const { valid, invalid } = parseIssueKeys(issueKeys);

      if (valid.length === 0) {
        return res.status(400).json({
          success: false,
          error:
            invalid.length > 0
              ? `No valid Jira issue keys found. Invalid: ${invalid.join(', ')}`
              : 'Provide at least one Jira issue key (e.g. AUTH-123).',
          code: 'NO_VALID_ISSUE_KEYS',
          data: { invalid },
        });
      }

      const config = await getStoredJiraConfig();
      if (!config) {
        return res.status(400).json({
          success: false,
          error: 'Jira is not connected. Connect it under Tools → Jira first.',
          code: 'JIRA_NOT_CONNECTED',
        });
      }

      // Cap defensively; a single by-key import is not meant for bulk backlogs.
      const cap = Math.min(valid.length, 200);
      const issues: JiraImportedIssue[] = await searchIssuesByKeys(config, valid, cap);

      // Keys that were valid in shape but not found in Jira (typo / no access).
      const foundKeys = new Set(issues.map((i) => i.key.toUpperCase()));
      const notFound = valid.filter((k) => !foundKeys.has(k.toUpperCase()));

      const summary = await importIssuesAsRequirements(issues, '', {
        companyId, projectId, userId, environmentId, sprintId,
      });

      logger.info(MOD, 'Jira import-by-keys complete', {
        companyId, projectId,
        requested: valid.length,
        imported: summary.imported, updated: summary.updated, skipped: summary.skipped,
        notFound: notFound.length, invalid: invalid.length,
      });

      res.json({
        success: true,
        data: {
          ...summary,
          requested: valid.length,
          notFound,
          invalid,
        },
      });
    } catch (error: any) {
      logger.error(MOD, 'POST /jira/import-by-keys failed', { error: error?.message });
      res.status(500).json({ success: false, error: 'Failed to import from Jira' });
    }
  });

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

  /* ─── Recalculate coverage (STATIC — must precede /:id) ──────────────
   * Repairs stored coverage_percentage / status for all requirements in scope
   * from the live state. Useful to immediately fix historical drift (e.g.
   * coverage stuck at 33% after test cases were deleted) without a redeploy. */
  router.post('/coverage/recalculate', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId ?? null;
      const updated = await recalculateAllRequirementCoverage(companyId, projectId);
      logger.info(MOD, 'Recalculated requirement coverage', { companyId, projectId, updated });
      res.json({ success: true, data: { updated } });
    } catch (error: any) {
      logger.error(MOD, 'Failed to recalculate coverage', { error: error?.message });
      res.status(500).json({ success: false, error: 'Failed to recalculate coverage' });
    }
  });

  /* ─── Create requirement ─────────────────────────────────────────── */
  router.post('/', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId ?? null;
      const userId = (req as any).userId ?? null;
      // Write-path attribution — a requirement belongs to a sprint/release but is
      // environment-INDEPENDENT (the same requirement is verified across QA, UAT,
      // Prod). So we persist only the active sprint; environment is never stamped.
      // Undefined sprint lets the DB trigger stamp the project's current sprint.
      const { sprintId } = getContextFromRequest(req);
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
        // Environment intentionally omitted — requirements are env-independent.
        environmentId: null,
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
      const { category, priority, status, source, search } = req.query;

      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
      const offset = req.query.offset ? parseInt(String(req.query.offset), 10) : undefined;

      const { requirements, total } = await getRequirements({
        companyId,
        projectId,
        category: category ? String(category) : undefined,
        priority: priority ? String(priority) : undefined,
        status: status ? String(status) : undefined,
        source: source ? String(source) : undefined,
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
      const testCasesRaw = await getTestCasesForRequirement(String(req.params.id), companyId);
      
      // PHASE B — Project canonical scenarios to Manual test cases (business only)
      const testCases = projectToManual(testCasesRaw);
      
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
