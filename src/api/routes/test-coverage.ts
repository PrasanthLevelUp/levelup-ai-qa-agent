/**
 * API Routes for AI Test Coverage Intelligence Engine
 */

import { Router, type Request, type Response } from 'express';
import { logger } from '../../utils/logger';
import {
  TestCoverageEngine,
  type RequirementInput,
  type CoverageType,
  type KnowledgeContext,
} from '../../engines/test-coverage-engine';
import { TestToScriptEngine } from '../../engines/test-to-script-engine';
import { GitHubService } from '../../services/github-service';
import {
  createTestRequirement,
  getTestRequirements,
  getTestRequirement,
  deleteTestRequirement,
  insertTestScenarios,
  getTestScenarios,
  insertTestCases,
  getTestCases,
  getTestCasesByRequirement,
  upsertApplicationKnowledge,
  getApplicationKnowledge,
  deleteApplicationKnowledge,
  getTestCoverageStats,
  getKnowledgeItem,
  getRepository,
  getRepositoryContext,
  logExport,
  getExportHistory,
  updateCoverageGapPreference,
  linkTestCasesToRequirement,
} from '../../db/postgres';
import { ExportService } from '../../services/export-service';
import { TemplateService } from '../../services/template-service';

const MOD = 'test-coverage-routes';

export function createTestCoverageRouter(): Router {
  const router = Router();
  let engine: TestCoverageEngine | null = null;
  const exportService = new ExportService();

  function getEngine(): TestCoverageEngine {
    if (!engine) engine = new TestCoverageEngine();
    return engine;
  }

  /* ---- POST /generate — Full pipeline: analyze + generate + gap analysis ---- */
  router.post('/generate', async (req: Request, res: Response) => {
    try {
      const {
        title, description, jiraId, businessFlow, acceptanceCriteria,
        apiDocs, releaseNotes, module: mod, coverageTypes,
        knowledgeItemIds,
        useRepoIntelligence, repoId,
        includeCoverageGaps,
        requirementId,
      } = req.body;

      if (!title || !description) {
        return res.status(400).json({ error: 'title and description are required' });
      }

      const selectedTypes: CoverageType[] = coverageTypes?.length
        ? coverageTypes
        : ['positive', 'negative', 'edge_cases'];

      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId;
      logger.info(MOD, 'Generate request', { title, companyId, projectId, coverageTypes: selectedTypes, knowledgeItemIds });

      // Fetch app knowledge for context (legacy application_knowledge table)
      let knowledge: KnowledgeContext = { modules: [], historicalBugs: [] };
      try {
        const knowledgeRows = await getApplicationKnowledge(companyId);
        knowledge = {
          modules: knowledgeRows.map((k: any) => ({
            name: k.module,
            workflows: k.workflow,
            businessRules: k.business_rules,
            apis: k.apis,
          })),
          historicalBugs: knowledgeRows
            .filter((k: any) => k.historical_bugs)
            .map((k: any) => k.historical_bugs),
        };
      } catch (knowledgeErr: any) {
        logger.warn(MOD, 'Could not load legacy knowledge context', { error: knowledgeErr.message });
      }

      // Fetch enterprise knowledge items if IDs provided
      let knowledgeItemsUsed: any[] = [];
      if (Array.isArray(knowledgeItemIds) && knowledgeItemIds.length > 0) {
        try {
          const items = await Promise.all(
            knowledgeItemIds.slice(0, 20).map((id: number) => getKnowledgeItem(id, companyId))
          );
          knowledgeItemsUsed = items.filter(Boolean);
          logger.info(MOD, 'Enterprise knowledge items loaded', { requested: knowledgeItemIds.length, found: knowledgeItemsUsed.length });

          // Merge enterprise knowledge into context
          if (knowledgeItemsUsed.length > 0) {
            knowledge.enterpriseKnowledge = knowledgeItemsUsed.map((ki: any) => ({
              id: ki.id,
              category: ki.category,
              title: ki.title,
              description: ki.description,
              tags: ki.tags || [],
              relatedModules: ki.related_modules || [],
              priority: ki.priority,
              metadata: ki.metadata,
            }));
          }
        } catch (kiErr: any) {
          logger.warn(MOD, 'Could not load enterprise knowledge items', { error: kiErr.message });
        }
      }

      // Fetch repository intelligence context if requested
      let repoContextUsed: any = null;
      if (useRepoIntelligence && repoId) {
        try {
          const profile = await getRepositoryContext(repoId, companyId);
          if (profile) {
            repoContextUsed = { repoId, profile };
            // Merge repo context into knowledge for the AI engine
            knowledge.repositoryContext = {
              repoId,
              techStack: (profile as any).techStack || [],
              architecture: (profile as any).architecture || {},
              patterns: (profile as any).patterns || [],
              testingFrameworks: (profile as any).testingFrameworks || [],
              summary: (profile as any).summary || '',
            };
            logger.info(MOD, 'Repository intelligence loaded', { repoId });
          } else {
            logger.warn(MOD, 'No repository context found for repoId', { repoId });
          }
        } catch (repoErr: any) {
          logger.warn(MOD, 'Could not load repository context', { repoId, error: repoErr.message });
        }
      }

      const input: RequirementInput = {
        title, description, jiraId, businessFlow,
        acceptanceCriteria, apiDocs, releaseNotes, module: mod,
      };

      logger.info(MOD, 'Calling AI engine for test coverage generation', {
        knowledgeModules: knowledge.modules?.length || 0,
        enterpriseKnowledge: knowledge.enterpriseKnowledge?.length || 0,
        repositoryContext: repoContextUsed ? true : false,
      });
      const result = await getEngine().generateFullCoverage(input, selectedTypes, knowledge);
      logger.info(MOD, 'AI engine returned', {
        scenarios: result.scenarios.length,
        testCases: result.testCases.length,
        gaps: result.coverageGaps.length,
      });

      // Persist to DB — store knowledge item references and coverage types in analysis
      const analysisWithKnowledge = {
        ...result.requirementAnalysis,
        coverageTypes: selectedTypes,
        knowledgeItemIds: knowledgeItemsUsed.map((ki: any) => ki.id),
        knowledgeItemTitles: knowledgeItemsUsed.map((ki: any) => ki.title),
        useRepoIntelligence: !!repoContextUsed,
        repoId: repoContextUsed ? repoId : undefined,
        includeCoverageGaps: includeCoverageGaps !== false, // default true
        // Persist the coverage gaps inside the analysis JSONB so they survive to
        // the History detail view (gaps are not stored in a separate table).
        coverageGaps: result.coverageGaps || [],
        gapsFound: result.stats?.gapsFound ?? (result.coverageGaps?.length || 0),
      };

      let reqId: number;
      try {
        reqId = await createTestRequirement({
          title, description, jiraId, businessFlow, acceptanceCriteria,
          apiDocs, releaseNotes, module: mod,
          featureType: result.requirementAnalysis.featureType,
          riskLevel: result.requirementAnalysis.riskLevel,
          analysis: analysisWithKnowledge,
          companyId,
          projectId,
        });
        logger.info(MOD, 'Requirement persisted', { reqId });
      } catch (dbErr: any) {
        logger.error(MOD, 'Failed to persist requirement to DB', { error: dbErr.message, stack: dbErr.stack });
        // Return AI results even if DB save fails, but flag the error
        return res.json({
          requirementId: null,
          ...result,
          _warning: 'AI generation succeeded but database persistence failed. Results shown are not saved.',
        });
      }

      // Insert scenarios
      let scenarioIds: number[] = [];
      try {
        scenarioIds = await insertTestScenarios(reqId, result.scenarios.map(s => ({
          scenario: s.scenario,
          coverageType: s.coverageType,
          priority: s.priority,
          riskArea: s.riskArea,
        })), companyId);
        logger.info(MOD, 'Scenarios persisted', { count: scenarioIds.length });
      } catch (scenErr: any) {
        logger.error(MOD, 'Failed to persist scenarios', { error: scenErr.message });
      }

      // Map test cases to scenarios — prefer scenarioIndex from AI, fallback to tag matching
      if (result.testCases.length > 0 && scenarioIds.length > 0) {
        const scenariosWithType = result.scenarios.map((s, i) => ({ ...s, dbId: scenarioIds[i], index: i }));
        let insertedCases = 0;
        const insertedTestCaseIds: number[] = [];
        for (const tc of result.testCases) {
          try {
            // 1. Use scenarioIndex if provided by AI (most reliable)
            let matchingScenario = (tc as any).scenarioIndex != null && (tc as any).scenarioIndex < scenariosWithType.length
              ? scenariosWithType[(tc as any).scenarioIndex]
              : null;

            // 2. Fallback: match by coverage type tag
            if (!matchingScenario && tc.tags?.length) {
              matchingScenario = scenariosWithType.find(s =>
                tc.tags.some(t =>
                  s.coverageType.includes(t) ||
                  s.scenario.toLowerCase().includes(t.toLowerCase())
                )
              ) || null;
            }

            // 3. Final fallback: first scenario
            if (!matchingScenario) {
              matchingScenario = scenariosWithType[0];
            }

            const newIds = await insertTestCases(matchingScenario.dbId, [{
              title: tc.title,
              preconditions: tc.preconditions || '',
              steps: tc.steps || [],
              expectedResult: tc.expectedResult || '',
              testData: tc.testData || '',
              priority: tc.priority || 'P2',
              severity: tc.severity || 'major',
              tags: tc.tags || [],
              automationReady: tc.automationReady ?? false,
              automationComplexity: tc.automationComplexity || 'medium',
              selectorAvailability: tc.selectorAvailability || 'unknown',
            }], companyId);
            insertedTestCaseIds.push(...newIds);
            insertedCases++;
          } catch (tcErr: any) {
            logger.error(MOD, 'Failed to persist test case', { title: tc.title, error: tcErr.message });
          }
        }
        logger.info(MOD, 'Test cases persisted', { inserted: insertedCases, total: result.testCases.length });

        // RTM: if an existing requirement was supplied, link the freshly
        // generated test cases to it so coverage updates automatically.
        // Best-effort — never let traceability failures break generation.
        if (requirementId && insertedTestCaseIds.length > 0) {
          try {
            const linked = await linkTestCasesToRequirement({
              testCaseIds: insertedTestCaseIds,
              requirementId: String(requirementId),
              companyId,
              projectId: projectId ?? null,
              userId: (req as any).userId ?? null,
            });
            logger.info(MOD, 'Linked generated test cases to requirement', { requirementId, linked });
          } catch (linkErr: any) {
            logger.error(MOD, 'Failed to link test cases to requirement', { requirementId, error: linkErr.message });
          }
        }
      }

      return res.json({
        requirementId: reqId,
        ...result,
        knowledgeUsed: knowledgeItemsUsed.length > 0 ? knowledgeItemsUsed.map((ki: any) => ({
          id: ki.id,
          title: ki.title,
          category: ki.category,
        })) : undefined,
      });
    } catch (err: any) {
      logger.error(MOD, 'Generation failed', { error: err.message, stack: err.stack });
      return res.status(500).json({ error: 'Generation failed', details: err.message });
    }
  });

  /* ---- GET /requirements — List all requirements ---- */
  router.get('/requirements', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId;
      logger.info(MOD, 'Fetching requirements', { companyId, projectId });
      const reqs = await getTestRequirements(companyId, projectId);
      logger.info(MOD, 'Requirements fetched', { count: reqs.length, companyId, projectId });
      return res.json(reqs);
    } catch (err: any) {
      logger.error(MOD, 'Failed to fetch requirements', { error: err.message });
      return res.status(500).json({ error: 'Failed to fetch requirements', details: err.message });
    }
  });

  /* ---- GET /requirements/:id — Single requirement with scenarios & cases ---- */
  router.get('/requirements/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const companyId = (req as any).companyId;
      const requirement = await getTestRequirement(id, companyId);
      if (!requirement) return res.status(404).json({ error: 'Not found' });

      const scenarios = await getTestScenarios(id);
      const testCases = await getTestCasesByRequirement(id);

      return res.json({ requirement, scenarios, testCases });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to fetch requirement', details: err.message });
    }
  });

  /* ---- DELETE /requirements/:id ---- */
  router.delete('/requirements/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const deleted = await deleteTestRequirement(id);
      return res.json({ deleted });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to delete', details: err.message });
    }
  });

  /* ---- GET /stats — Coverage statistics ---- */
  router.get('/stats', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId;
      const stats = await getTestCoverageStats(companyId, projectId);
      return res.json(stats);
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to fetch stats', details: err.message });
    }
  });

  /* ---- Application Knowledge CRUD ---- */
  router.get('/knowledge', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const knowledge = await getApplicationKnowledge(companyId);
      return res.json(knowledge);
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to fetch knowledge', details: err.message });
    }
  });

  router.post('/knowledge', async (req: Request, res: Response) => {
    try {
      const { module: mod, workflow, businessRules, dependencies, apis, historicalBugs } = req.body;
      if (!mod) return res.status(400).json({ error: 'module is required' });
      const companyId = (req as any).companyId;
      const id = await upsertApplicationKnowledge({
        module: mod, workflow, businessRules, dependencies, apis, historicalBugs, companyId,
      });
      return res.json({ id, module: mod });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to save knowledge', details: err.message });
    }
  });

  router.delete('/knowledge/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const deleted = await deleteApplicationKnowledge(id);
      return res.json({ deleted });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to delete knowledge', details: err.message });
    }
  });

  /* ------------------------------------------------------------------ */
  /*  POST /requirements/:id/generate-scripts-and-commit                 */
  /*  Test Case Lab → Script Gen → GitHub PR pipeline                    */
  /* ------------------------------------------------------------------ */
  router.post('/requirements/:id/generate-scripts-and-commit', async (req: Request, res: Response) => {
    const requirementId = parseInt(String(req.params.id), 10);
    const companyId = (req as any).companyId;

    try {
      const {
        repositoryId,
        projectId,
        framework = 'playwright',
        baseUrl,
        outputDir,
        githubToken,
      } = req.body;

      if (!repositoryId) {
        return res.status(400).json({ error: 'repositoryId is required' });
      }

      logger.info(MOD, 'Generate scripts & commit pipeline started', {
        requirementId, companyId, repositoryId,
      });

      // 1. Look up the repository to get its GitHub URL + branch
      const repo = await getRepository(repositoryId, companyId);
      if (!repo) {
        return res.status(404).json({ error: 'Repository not found' });
      }
      if (!repo.url) {
        return res.status(400).json({ error: 'Repository has no URL configured' });
      }

      // Determine GitHub token: prefer request body, fall back to env
      const token = githubToken || process.env.GITHUB_TOKEN;
      if (!token) {
        return res.status(400).json({
          error: 'GitHub token required. Provide githubToken in request body or set GITHUB_TOKEN env variable.',
        });
      }

      // 2. Generate scripts from test cases
      const scriptEngine = new TestToScriptEngine();
      const scriptResult = await scriptEngine.generate({
        requirementId,
        companyId,
        repositoryId,
        projectId,
        framework: framework as 'playwright',
        baseUrl: baseUrl || 'http://localhost:3000',
        outputDir: outputDir || 'tests/generated',
      });

      if (!scriptResult.files.length) {
        return res.status(400).json({ error: 'No scripts were generated' });
      }

      logger.info(MOD, 'Scripts generated', {
        files: scriptResult.files.length,
        totalTests: scriptResult.totalTests,
      });

      // 3. Commit to GitHub and create PR
      const parsed = GitHubService.parseRepoUrl(repo.url);
      if (!parsed) {
        return res.status(400).json({ error: `Cannot parse GitHub URL: ${repo.url}` });
      }

      const github = new GitHubService({
        token,
        owner: parsed.owner,
        repo: parsed.repo,
      });

      const timestamp = Date.now();
      const branchName = `test-cases/requirement-${requirementId}-${timestamp}`;
      const baseBranch = repo.branch || 'main';

      const prResult = await github.commitAndCreatePR({
        files: scriptResult.files.map(f => ({
          filePath: f.filePath,
          content: f.content,
        })),
        branchName,
        baseBranch,
        commitMessage: [
          `test: add AI-generated test scripts for "${scriptResult.requirementTitle}"`,
          '',
          `Requirement: #${requirementId}`,
          `Test Cases: ${scriptResult.totalTests}`,
          `Files: ${scriptResult.totalFiles}`,
          '',
          'Generated by LevelUp AI Test-to-Script Engine',
        ].join('\n'),
        pr: {
          title: `🧪 Test Scripts: ${scriptResult.requirementTitle}`,
          body: buildTestScriptPRBody(scriptResult, requirementId),
          labels: ['levelup-ai', 'generated-tests', 'test-case-lab'],
        },
      });

      logger.info(MOD, 'PR created successfully', {
        prUrl: prResult.prUrl,
        prNumber: prResult.prNumber,
        branch: prResult.branchName,
      });

      return res.json({
        success: true,
        data: {
          requirementId,
          requirementTitle: scriptResult.requirementTitle,
          scripts: scriptResult.files.map(f => ({
            filePath: f.filePath,
            testCount: f.testCount,
          })),
          totalTests: scriptResult.totalTests,
          totalFiles: scriptResult.totalFiles,
          github: {
            prUrl: prResult.prUrl,
            prNumber: prResult.prNumber,
            branchName: prResult.branchName,
            commitSha: prResult.commitSha,
            repoUrl: `https://github.com/${parsed.owner}/${parsed.repo}`,
          },
        },
      });
    } catch (err: any) {
      logger.error(MOD, 'Generate scripts & commit pipeline failed', {
        requirementId, error: err.message,
      });
      return res.status(500).json({
        error: 'Failed to generate scripts and create PR',
        details: err.message,
      });
    }
  });

  /* ---- POST /export — Export test cases to Excel/CSV/Jira/TestRail ---- */
  router.post('/export', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId;
      const userId = (req as any).userId;

      const {
        requirementId,
        format = 'excel',
        includeGaps = false,
      } = req.body;

      if (!requirementId) {
        return res.status(400).json({ error: 'requirementId is required' });
      }

      const validFormats = ['excel', 'csv', 'jira', 'testrail'];
      if (!validFormats.includes(format)) {
        return res.status(400).json({
          error: `Invalid format. Must be one of: ${validFormats.join(', ')}`,
        });
      }

      const startTime = Date.now();

      // Fetch requirement
      const requirement = await getTestRequirement(requirementId, companyId);
      if (!requirement) {
        return res.status(404).json({ error: 'Requirement not found' });
      }

      // Fetch scenarios and cases
      const scenarios = await getTestScenarios(requirementId);
      const testCases = await getTestCasesByRequirement(requirementId);

      if (!scenarios.length && !testCases.length) {
        return res.status(404).json({
          error: 'No test scenarios or cases found for this requirement',
        });
      }

      const requirementInfo = {
        id: requirement.id,
        title: requirement.title,
        description: requirement.description || '',
        module: requirement.module,
        risk_level: requirement.risk_level,
        created_at: requirement.created_at?.toISOString?.() || String(requirement.created_at || ''),
      };

      const exportOptions = {
        format: format as 'excel' | 'csv' | 'jira' | 'testrail',
        includeGaps,
        includeMetadata: true,
      };

      let fileBuffer: Buffer | string;
      let contentType: string;
      let fileExtension: string;

      if (format === 'csv') {
        fileBuffer = await exportService.exportToCSV(testCases, exportOptions);
        contentType = 'text/csv';
        fileExtension = 'csv';
      } else {
        // excel, jira, testrail all produce xlsx
        fileBuffer = await exportService.exportToExcel(testCases, requirementInfo, exportOptions);
        contentType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        fileExtension = 'xlsx';
      }

      const exportTimeMs = Date.now() - startTime;
      const fileSizeBytes = Buffer.byteLength(
        typeof fileBuffer === 'string' ? Buffer.from(fileBuffer) : fileBuffer,
      );

      // Log the export
      try {
        await logExport({
          companyId,
          projectId,
          userId,
          requirementId,
          format,
          totalScenarios: scenarios.length,
          totalCases: testCases.length,
          includedGaps: includeGaps,
          fileSizeBytes,
          exportTimeMs,
        });
      } catch (logErr: any) {
        logger.warn(MOD, 'Failed to log export history', { error: logErr.message });
      }

      const safeName = requirement.title
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .substring(0, 50);
      const fileName = `test-cases_${safeName}_${Date.now()}.${fileExtension}`;

      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('X-Export-Time-Ms', String(exportTimeMs));
      res.setHeader('X-Total-Scenarios', String(scenarios.length));
      res.setHeader('X-Total-Cases', String(testCases.length));

      return res.send(typeof fileBuffer === 'string' ? Buffer.from(fileBuffer) : fileBuffer);
    } catch (err: any) {
      logger.error(MOD, 'Export failed', { error: err.message });
      return res.status(500).json({ error: 'Export failed', details: err.message });
    }
  });

  /* ---- GET /template — Download sample test case template ---- */
  router.get('/template', async (req: Request, res: Response) => {
    try {
      const format = (req.query.format as string) || 'excel';

      if (format === 'csv') {
        const csv = await TemplateService.generateCSVTemplate();
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="test-case-template.csv"');
        return res.send(Buffer.from(csv));
      }

      const buffer = await TemplateService.generateExcelTemplate();
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', 'attachment; filename="test-case-template.xlsx"');
      return res.send(buffer);
    } catch (err: any) {
      logger.error(MOD, 'Template generation failed', { error: err.message });
      return res.status(500).json({ error: 'Template generation failed', details: err.message });
    }
  });

  /* ---- PATCH /requirements/:id/gaps — Update coverage gap inclusion preference ---- */
  router.patch('/requirements/:id/gaps', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const requirementId = parseInt(String(req.params.id), 10);

      if (isNaN(requirementId)) {
        return res.status(400).json({ error: 'Invalid requirement ID' });
      }

      const { includeGaps } = req.body;
      if (typeof includeGaps !== 'boolean') {
        return res.status(400).json({ error: 'includeGaps must be a boolean' });
      }

      const updated = await updateCoverageGapPreference(requirementId, includeGaps, companyId);
      if (!updated) {
        return res.status(404).json({ error: 'Requirement not found' });
      }

      return res.json({
        success: true,
        requirementId,
        includeGaps,
        message: `Coverage gap preference ${includeGaps ? 'enabled' : 'disabled'}`,
      });
    } catch (err: any) {
      logger.error(MOD, 'Update gap preference failed', { error: err.message });
      return res.status(500).json({ error: 'Failed to update gap preference', details: err.message });
    }
  });

  /* ---- GET /export-history — Paginated export history ---- */
  router.get('/export-history', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId;
      const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
      const offset = parseInt(req.query.offset as string, 10) || 0;

      const { records, total } = await getExportHistory(companyId, projectId, limit, offset);

      return res.json({
        success: true,
        data: records,
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + limit < total,
        },
      });
    } catch (err: any) {
      logger.error(MOD, 'Get export history failed', { error: err.message });
      return res.status(500).json({ error: 'Failed to fetch export history', details: err.message });
    }
  });

  return router;
}

/* -------------------------------------------------------------------------- */
/*  PR body builder for Test-to-Script PRs                                     */
/* -------------------------------------------------------------------------- */

function buildTestScriptPRBody(
  result: { requirementTitle: string; files: Array<{ filePath: string; testCount: number }>; totalTests: number; totalFiles: number },
  requirementId: number,
): string {
  const fileRows = result.files
    .map(f => `| \`${f.filePath}\` | ${f.testCount} |`)
    .join('\n');

  return `## 🧪 AI-Generated Test Scripts

> Automated PR created by [LevelUp AI QA](https://app.leveluptesting.in) Test-to-Script Engine.

### 📋 Source

| Field | Value |
|-------|-------|
| **Requirement** | ${result.requirementTitle} |
| **Requirement ID** | #${requirementId} |
| **Total Test Cases** | ${result.totalTests} |
| **Files Generated** | ${result.totalFiles} |

### 📁 Generated Files

| File | Tests |
|------|-------|
${fileRows}

### ✅ What was generated

- Playwright TypeScript test files from Test Case Lab definitions
- Each test case has been converted to an automated test with:
  - Proper selectors (data-testid preferred)
  - Assertions matching expected results
  - Smart waits (no \`waitForTimeout\`)
  - Independent test isolation

### 🔍 Review Checklist

- [ ] Selectors match your actual DOM elements
- [ ] Base URL is correct for your environment
- [ ] Test data matches your test environment
- [ ] Assertions cover the expected behavior

---

> ⚠️ **Review recommended** — AI-generated scripts may need selector adjustments for your specific UI.
>
> 🏷️ *Generated by LevelUp AI QA Engine • Test-to-Script Pipeline*
`;
}
