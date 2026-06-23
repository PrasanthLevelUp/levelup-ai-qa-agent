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
  findExistingRequirementBySignature,
  deleteRequirementTestCases,
  setRequirementGenerationState,
  getApplicationProfileForGeneration,
  getProfileById,
  getTestDataSetSummaries,
} from '../../db/postgres';
import { buildApplicationProfileContext } from '../../utils/application-profile-context';
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
        force,
        useAppProfile,   // optional: explicitly disable (false) the application-profile grounding
        appProfileId,    // optional: pin a specific crawled profile instead of auto-picking the freshest
        useTestData,     // optional: explicitly disable (false) the test-data grounding
        testDataIds,     // optional: pin specific dataset IDs instead of all project datasets
        deduplicate,     // optional: set false to skip the semantic duplicate-removal pass (default on)
      } = req.body;

      if (!title || !description) {
        return res.status(400).json({ error: 'title and description are required' });
      }

      const selectedTypes: CoverageType[] = coverageTypes?.length
        ? coverageTypes
        : ['positive', 'negative', 'edge_cases'];

      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId;
      logger.info(MOD, 'Generate request', { title, companyId, projectId, coverageTypes: selectedTypes, knowledgeItemIds, force: !!force });

      // ── Issue #1: Duplicate prevention ──
      // Block regenerating for a requirement that is still 'generated' and already
      // has test cases, unless the caller explicitly passes force=true (which the
      // UI sends only after the user deletes the prior cases / confirms regenerate).
      if (!force) {
        try {
          const existing = await findExistingRequirementBySignature({
            title, module: mod, companyId, projectId,
          });
          if (existing) {
            logger.info(MOD, '♻️ Duplicate generation blocked', { existingRequirementId: existing.id, testCaseCount: existing.test_case_count });
            return res.status(409).json({
              error: `Test cases already exist for "${existing.title}" (${existing.test_case_count} cases). Delete them first to regenerate.`,
              code: 'DUPLICATE',
              existingRequirementId: existing.id,
              testCaseCount: existing.test_case_count,
            });
          }
        } catch (dupErr: any) {
          // Never let the dedupe guard break generation — fail open.
          logger.warn(MOD, 'Duplicate check failed (continuing)', { error: dupErr.message });
        }
      }

      // Fetch app knowledge for context (legacy application_knowledge table)
      let knowledge: KnowledgeContext = { modules: [], historicalBugs: [] };
      try {
        const knowledgeRows = await getApplicationKnowledge(companyId, projectId);
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

      // Fetch repository intelligence context if requested.
      // NOTE: repo intelligence is now injected ONLY into the test-case generation
      // prompt (not requirement-analysis or gap-analysis), so we only spend those
      // tokens where the codebase context can actually influence the output.
      // `repoIntelligenceContributed` records whether the loaded context had any
      // substantive content — so the response can HONESTLY report whether repo
      // intelligence really fed the model (proof), rather than just claiming it.
      let repoContextUsed: any = null;
      let repoIntelligenceContributed = false;
      if (useRepoIntelligence && repoId) {
        try {
          const profile = await getRepositoryContext(repoId, companyId, projectId);
          if (profile) {
            const repoCtx = {
              repoId,
              techStack: (profile as any).techStack || [],
              architecture: (profile as any).architecture || {},
              patterns: (profile as any).patterns || [],
              testingFrameworks: (profile as any).testingFrameworks || [],
              summary: (profile as any).summary || '',
            };
            // Substantive only if at least one field carries real signal.
            repoIntelligenceContributed = Boolean(
              repoCtx.summary ||
              repoCtx.techStack.length ||
              repoCtx.patterns.length ||
              repoCtx.testingFrameworks.length ||
              (repoCtx.architecture && Object.keys(repoCtx.architecture).length > 0)
            );
            if (repoIntelligenceContributed) {
              repoContextUsed = { repoId, profile };
              knowledge.repositoryContext = repoCtx;
              logger.info(MOD, 'Repository intelligence loaded', { repoId });
            } else {
              // Empty context — do NOT inject it (zero token waste) and report it honestly.
              logger.info(MOD, 'Repository context empty — skipping injection to avoid wasted tokens', { repoId });
            }
          } else {
            logger.warn(MOD, 'No repository context found for repoId', { repoId });
          }
        } catch (repoErr: any) {
          logger.warn(MOD, 'Could not load repository context', { repoId, error: repoErr.message });
        }
      }

      // ── Issue #2: Ground generation in the REAL crawled application ──
      // Load the freshest application profile for this project and project its
      // crawl_data (pages, forms, real selectors, login flow) into the knowledge
      // context. When no profile exists this is a no-op and generation falls back
      // to the previous generic behaviour.
      let appProfileUsed: { id: string; name?: string | null; pageCount?: number; totalElements?: number; totalForms?: number } | null = null;
      try {
        // Profile selection precedence:
        //   1. useAppProfile === false → skip grounding entirely (user opted out)
        //   2. appProfileId provided    → pin that specific crawled profile (scope-checked)
        //   3. default                  → auto-pick the freshest profile for this project
        let profile = null;
        if (useAppProfile === false) {
          profile = null;
        } else if (appProfileId) {
          const pinned = await getProfileById(String(appProfileId));
          // Scope guard: only honour a pinned profile that belongs to this company/project
          const sameCompany = !pinned?.company_id || pinned.company_id === companyId;
          const sameProject = !projectId || !pinned?.project_id || pinned.project_id === projectId;
          if (pinned && sameCompany && sameProject) {
            profile = pinned;
          } else {
            logger.warn(MOD, 'Requested appProfileId not accessible — falling back to auto-pick', { appProfileId });
            profile = await getApplicationProfileForGeneration(companyId, projectId);
          }
        } else {
          profile = await getApplicationProfileForGeneration(companyId, projectId);
        }
        const profileCtx = buildApplicationProfileContext(profile);
        if (profile && profileCtx) {
          knowledge.applicationProfile = profileCtx;
          appProfileUsed = {
            id: profile.id,
            name: profile.name,
            pageCount: profile.page_count,
            totalElements: profile.total_elements,
            totalForms: profile.total_forms,
          };
          logger.info(MOD, '🧠 Application profile loaded for generation', {
            profileId: profile.id, pages: profile.page_count, elements: profile.total_elements, forms: profile.total_forms,
          });
        } else {
          logger.info(MOD, 'No application profile available — generic generation', { companyId, projectId });
        }
      } catch (profErr: any) {
        logger.warn(MOD, 'Could not load application profile (continuing)', { error: profErr.message });
      }

      // ── Test Data grounding ──
      // Project the project's Test Data sets (token-safe summaries: names,
      // environments, record counts, and a small sample of KEYS only — never
      // values/secrets) so generated cases reference REAL datasets instead of
      // inventing placeholder credentials/products. On by default; opt out with
      // useTestData:false. Optionally pin specific datasets via testDataIds.
      let testDataUsed: Array<{ name: string; environment: string; recordCount: number; sampleKeys: string[] }> = [];
      if (useTestData !== false) {
        try {
          const ids = Array.isArray(testDataIds)
            ? testDataIds.map((n: any) => parseInt(String(n), 10)).filter((n: number) => Number.isFinite(n))
            : undefined;
          const summaries = await getTestDataSetSummaries(companyId, projectId, undefined, 5, ids);
          if (summaries.length > 0) {
            testDataUsed = summaries.slice(0, 12);
            knowledge.testData = testDataUsed;
            logger.info(MOD, '🗃️ Test data loaded for generation', { datasets: testDataUsed.length });
          } else {
            logger.info(MOD, 'No test data sets available — generation without test-data grounding', { companyId, projectId });
          }
        } catch (tdErr: any) {
          logger.warn(MOD, 'Could not load test data (continuing)', { error: tdErr.message });
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
        applicationProfile: appProfileUsed ? true : false,
        testData: testDataUsed.length,
      });
      const result = await getEngine().generateFullCoverage(input, selectedTypes, knowledge, {
        includeCoverageGaps: includeCoverageGaps !== false,
        deduplicate: deduplicate !== false, // default on — semantic near-duplicate removal
      });
      logger.info(MOD, 'AI engine returned', {
        mode: result.mode,
        scenarios: result.scenarios.length,
        testCases: result.testCases.length,
        suggestedTestCases: result.suggestedTestCases?.length || 0,
        missingRequirements: result.missingRequirements?.length || 0,
        gaps: result.coverageGaps.length,
      });

      // ── Intelligence provenance (proof) ──
      // Build an HONEST record of which intelligence sources actually fed the model
      // for this run. This is surfaced in the API response and persisted so the UI
      // can show an "Intelligence Used" panel — customers see exactly what grounded
      // their test cases (requirement, app profile, app knowledge, test data, repo)
      // instead of trusting an opaque "AI generated" label. A source is only marked
      // used when it genuinely contributed content.
      const intelligenceUsed = {
        requirement: { used: true, detail: title },
        appProfile: appProfileUsed
          ? {
              used: true,
              name: appProfileUsed.name || undefined,
              pageCount: appProfileUsed.pageCount,
              totalElements: appProfileUsed.totalElements,
              totalForms: appProfileUsed.totalForms,
            }
          : { used: false },
        appKnowledge: knowledgeItemsUsed.length > 0
          ? { used: true, items: knowledgeItemsUsed.map((ki: any) => ki.title) }
          : { used: false },
        testData: testDataUsed.length > 0
          ? { used: true, datasets: testDataUsed.map(td => `${td.name} [${td.environment}]`) }
          : { used: false },
        repoIntelligence: repoIntelligenceContributed
          ? { used: true, repoId, summary: (repoContextUsed?.profile as any)?.summary || undefined }
          : {
              used: false,
              // Explain WHY when the user asked for repo intelligence but it added nothing,
              // so the "wasted token" concern is transparent rather than silent.
              reason: useRepoIntelligence && repoId
                ? 'Repository selected but its scanned context had no usable signal — not injected (no tokens spent).'
                : undefined,
            },
      };

      // Persist to DB — store knowledge item references and coverage types in analysis
      const analysisWithKnowledge = {
        ...result.requirementAnalysis,
        coverageTypes: selectedTypes,
        knowledgeItemIds: knowledgeItemsUsed.map((ki: any) => ki.id),
        knowledgeItemTitles: knowledgeItemsUsed.map((ki: any) => ki.title),
        useRepoIntelligence: !!repoContextUsed,
        repoId: repoContextUsed ? repoId : undefined,
        includeCoverageGaps: includeCoverageGaps !== false, // default true
        // Generation mode: 'strict' (requirement-only) or 'expanded' (+ suggestions).
        mode: result.mode,
        // Persist the coverage gaps inside the analysis JSONB so they survive to
        // the History detail view (gaps are not stored in a separate table).
        coverageGaps: result.coverageGaps || [],
        gapsFound: result.stats?.gapsFound ?? (result.coverageGaps?.length || 0),
        // Suggested Additional Coverage (expanded mode only): requirement-adjacent
        // cases the model proposes but that the requirement did NOT ask for. Stored
        // separately from committed test cases so they never inflate the coverage
        // count — they live in the analysis JSONB for the History "Suggested
        // Additional Coverage" panel.
        suggestedTestCases: result.suggestedTestCases || [],
        suggestedCount: result.stats?.suggestedCount ?? (result.suggestedTestCases?.length || 0),
        // Potential Missing Requirements: open questions surfaced instead of inventing
        // assumption-based test cases (e.g. "No username length limit found — add one?").
        missingRequirements: result.missingRequirements || [],
        missingRequirementsCount: result.stats?.missingRequirementsCount ?? (result.missingRequirements?.length || 0),
        // How many near-duplicate test cases the semantic dedup pass removed.
        duplicatesRemoved: result.stats?.duplicatesRemoved ?? 0,
        // Issue #2: record whether real app knowledge was used for this generation
        appProfileUsed: appProfileUsed || undefined,
        // Record which Test Data sets grounded this generation (names + counts only).
        testDataUsed: testDataUsed.length > 0
          ? testDataUsed.map(td => ({ name: td.name, environment: td.environment, recordCount: td.recordCount }))
          : undefined,
        // Provenance proof — which intelligence sources actually fed the model.
        intelligenceUsed,
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
              // Source provenance — which intelligence grounded this case
              // (requirement | knowledge | test_data | app_profile | assumption).
              source: (tc as any).source || undefined,
              sourceEvidence: (tc as any).sourceEvidence || undefined,
            }], companyId);
            insertedTestCaseIds.push(...newIds);
            insertedCases++;
          } catch (tcErr: any) {
            logger.error(MOD, 'Failed to persist test case', { title: tc.title, error: tcErr.message });
          }
        }
        logger.info(MOD, 'Test cases persisted', { inserted: insertedCases, total: result.testCases.length });

        // ── Issue #1: record generation lifecycle state for duplicate prevention ──
        try {
          await setRequirementGenerationState(reqId, 'generated', insertedCases);
        } catch (stateErr: any) {
          logger.warn(MOD, 'Could not set generation state', { reqId, error: stateErr.message });
        }

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
        // Issue #2: surface whether the real application profile grounded this run
        appProfileUsed: appProfileUsed || undefined,
        // Surface which Test Data sets grounded this run (names + counts only).
        testDataUsed: testDataUsed.length > 0
          ? testDataUsed.map(td => ({ name: td.name, environment: td.environment, recordCount: td.recordCount }))
          : undefined,
        // Provenance proof — surfaced in the UI "Intelligence Used" panel.
        intelligenceUsed,
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
      const companyId = (req as any).companyId;
      const deleted = await deleteTestRequirement(id, companyId);
      return res.json({ deleted });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to delete', details: err.message });
    }
  });

  /* ---- DELETE /requirements/:id/test-cases — clear generated artifacts so the
         requirement can be regenerated (Issue #1). Keeps the requirement row but
         removes its scenarios/cases and marks generation_state='deleted'. ---- */
  router.delete('/requirements/:id/test-cases', async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (Number.isNaN(id)) return res.status(400).json({ error: 'Invalid requirement id' });
      const companyId = (req as any).companyId;
      const { deletedScenarios, recalculatedRequirements } = await deleteRequirementTestCases(id, companyId);
      logger.info(MOD, '🗑️ Cleared generated test cases for regeneration', {
        requirementId: id, deletedScenarios, recalculatedRequirements,
      });
      return res.json({
        cleared: true,
        requirementId: id,
        deletedScenarios,
        recalculatedRequirements,
        generationState: 'deleted',
      });
    } catch (err: any) {
      logger.error(MOD, 'Failed to clear test cases', { error: err.message });
      return res.status(500).json({ error: 'Failed to clear test cases', details: err.message });
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
      const projectId = (req as any).projectId;
      const knowledge = await getApplicationKnowledge(companyId, projectId);
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
      const projectId = (req as any).projectId;
      const id = await upsertApplicationKnowledge({
        module: mod, workflow, businessRules, dependencies, apis, historicalBugs, companyId, projectId,
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
        // Pass the caller's baseUrl through as-is (may be empty). The engine
        // resolves the effective base URL, preferring the REAL App Profile
        // base_url over the generic localhost default so generated scripts
        // navigate to a real host (fixes review issue C1 — placeholder URLs).
        baseUrl: baseUrl || undefined,
        outputDir: outputDir || 'tests/generated',
      });

      if (!scriptResult.files.length) {
        return res.status(400).json({ error: 'No scripts were generated' });
      }

      logger.info(MOD, 'Scripts generated', {
        files: scriptResult.files.length,
        totalTests: scriptResult.totalTests,
        coverageComplete: scriptResult.coverage.complete,
        covered: scriptResult.coverage.covered,
        totalTestCases: scriptResult.coverage.totalTestCases,
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
          body: buildTestScriptPRBody(scriptResult, requirementId, scriptResult.coverage),
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
          coverage: scriptResult.coverage,
          // Audit of which intelligence layers grounded the generated scripts.
          intelligence: scriptResult.intelligence,
          // Framework audit (Phase 1: Impact Analysis + Quality Report)
          ...(scriptResult.frameworkAnalysis ? { frameworkAnalysis: scriptResult.frameworkAnalysis } : {}),
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
  result: {
    requirementTitle: string;
    files: Array<{ filePath: string; testCount: number }>;
    totalTests: number;
    totalFiles: number;
    intelligence?: {
      appProfileUsed: boolean;
      appKnowledgeUsed: boolean;
      repoPatternsUsed: boolean;
      locatorReport?: { totalLocators: number; validatedCount: number; avgConfidence: number; todoCount: number };
    };
    frameworkAnalysis?: import('../../script-gen/framework-auditor').FrameworkAuditResult;
  },
  requirementId: number,
  coverage?: {
    totalTestCases: number; totalTestsGenerated: number; covered: number;
    missing: number[]; extra: number; complete: boolean;
    perFile: Array<{ filePath: string; feature: string; testCases: number; tests: number; complete: boolean }>;
  },
): string {
  const fileRows = result.files
    .map(f => `| \`${f.filePath}\` | ${f.testCount} |`)
    .join('\n');

  // Build a coverage section that *proves* 1:1 mapping (test cases in = tests out).
  let coverageSection = '';
  if (coverage) {
    const badge = coverage.complete
      ? `✅ **All ${coverage.totalTestCases} test case(s) covered** in ${result.totalFiles - 1} feature file(s)`
      : `⚠️ **Only ${coverage.covered}/${coverage.totalTestCases} test case(s) covered**`;
    const perFileRows = coverage.perFile
      .map(f => `| \`${f.filePath}\` | ${f.feature} | ${f.testCases} | ${f.tests} | ${f.complete ? '✅' : '⚠️'} |`)
      .join('\n');
    const missingNote = coverage.missing.length
      ? `\n> ⚠️ Uncovered test case ids: ${coverage.missing.join(', ')} (template tests were added as placeholders).`
      : '';
    const extraNote = coverage.extra > 0
      ? `\n> ℹ️ ${coverage.extra} extra test(s) emitted beyond the source cases — review for relevance.`
      : '';

    coverageSection = `

### 🎯 Coverage Report

${badge}

| Metric | Value |
|--------|-------|
| **Test Cases (in)** | ${coverage.totalTestCases} |
| **Tests Generated (out)** | ${coverage.totalTestsGenerated} |
| **Covered** | ${coverage.covered}/${coverage.totalTestCases} |
| **Extra (unmapped)** | ${coverage.extra} |
| **1:1 Complete** | ${coverage.complete ? 'Yes ✅' : 'No ⚠️'} |

| File | Feature | Cases | Tests | Status |
|------|---------|-------|-------|--------|
${perFileRows}${missingNote}${extraNote}`;
  }

  // Intelligence section: shows which grounding layers were applied so
  // reviewers can trust the scripts are based on real app/repo data.
  let intelligenceSection = '';
  const intel = result.intelligence;
  if (intel) {
    const mark = (b: boolean) => (b ? '✅' : '—');
    const lr = intel.locatorReport;
    const lrRow = lr
      ? `\n| **Locators resolved** | ${lr.totalLocators} (validated ${lr.validatedCount}, avg confidence ${lr.avgConfidence}%, ${lr.todoCount} to verify) |`
      : '';
    intelligenceSection = `

### 🧠 Intelligence Applied

| Layer | Used |
|-------|------|
| **Application Profile (real DOM/selectors)** | ${mark(intel.appProfileUsed)} |
| **Application Knowledge** | ${mark(intel.appKnowledgeUsed)} |
| **Repository Patterns** | ${mark(intel.repoPatternsUsed)} |${lrRow}`;
  }

  // Framework Analysis section (Phase 1): Impact Analysis + Quality Report
  let frameworkSection = '';
  const fw = result.frameworkAnalysis;
  if (fw) {
    const impact = fw.impactAnalysis;
    const quality = fw.qualityReport;
    
    const riskBadge = impact.risk.level === 'LOW' ? '🟢 LOW' : impact.risk.level === 'MEDIUM' ? '🟡 MEDIUM' : '🔴 HIGH';
    const riskReasons = impact.risk.reasons.map(r => `- ${r}`).join('\n');
    
    const existingRows = impact.existingAssets.slice(0, 5).map(a => `| ${a} |`).join('\n');
    const moreExisting = impact.existingAssets.length > 5 ? `\n> _... and ${impact.existingAssets.length - 5} more asset(s)_` : '';
    
    const createRows = impact.filesToCreate.map(f => `| \`${f.path}\` | ${f.reason} |`).join('\n') || '| _(none)_ | |';
    const updateRows = impact.filesToUpdate.map(f => `| \`${f.path}\` | ${f.reason} |`).join('\n') || '| _(none)_ | |';
    const reuseRows = impact.filesToReuse.map(f => `| \`${f.path}\` | ${f.reason} |`).join('\n') || '| _(none)_ | |';
    
    const reuse = impact.reuseOpportunity;
    const reuseBadge = reuse.level === 'HIGH' ? '✅ HIGH' : reuse.level === 'MEDIUM' ? '✔️ MEDIUM' : reuse.level === 'LOW' ? 'ℹ️ LOW' : '— NONE';
    const reuseAssetRows = reuse.assetsReused.length
      ? reuse.assetsReused.map(a => `| ✓ \`${a}\` |`).join('\n')
      : '| _(none)_ |';

    const qualMark = (s: string) => s === 'EXCELLENT' ? '✅' : s === 'GOOD' ? '✔️' : s === 'FAIR' ? 'ℹ️' : '—';

    // Framework Assets Catalog (the future Repository Intelligence overview)
    const cat = fw.catalog;
    const lastScanRow = cat.lastRepositoryScan ? `\n**Last Repository Scan:** ${cat.lastRepositoryScan}` : '';

    // Suite recommendation — derived from repository intelligence, not assumptions
    const existingSuitesStr = impact.existingSuites.length
      ? impact.existingSuites.map(s => `\`${s}\``).join(', ')
      : '_(none detected)_';
    const suiteNote = impact.suggestedSuiteExists ? '' : ' _(suggested — does not exist yet)_';

    frameworkSection = `

### 🏗️ Framework Analysis

**Framework Assets Catalog**

| Asset Type | Count |
|------------|-------|
| Page Objects | ${cat.pageObjects} |
| Fixtures | ${cat.fixtures} |
| Utilities | ${cat.utilities} |
| Data Files | ${cat.dataFiles} |
| Suites | ${cat.suites} |
| Tags | ${cat.tags} |
${lastScanRow}

**Generation Quality Report: ${quality.overallAssessment}**

| Category | Score | Detail |
|----------|-------|--------|
| Page Object Reuse | ${qualMark(quality.pageObjectReuse.score)} | ${quality.pageObjectReuse.detail} |
| Fixture Reuse | ${qualMark(quality.fixtureReuse.score)} | ${quality.fixtureReuse.detail} |
| Utility Reuse | ${qualMark(quality.utilityReuse.score)} | ${quality.utilityReuse.detail} |
| Data Reuse | ${qualMark(quality.dataReuse.score)} | ${quality.dataReuse.detail} |
| Convention Match | ${qualMark(quality.conventionMatch.score)} | ${quality.conventionMatch.detail} |

**Existing Assets Found:**

| Asset |
|-------|
${existingRows}${moreExisting}

**Files To Create:**

| File | Reason |
|------|--------|
${createRows}

**Files To Update:**

| File | Reason |
|------|--------|
${updateRows}

**Files Reused:**

| File | Reason |
|------|--------|
${reuseRows}

**Reuse Opportunity:** ${reuseBadge}

${reuse.summary}

| Asset Reused |
|--------------|
${reuseAssetRows}

**Risk Assessment:** ${riskBadge}

${riskReasons}

**Tags:** ${impact.suggestedTags.join(', ') || '_(none)_'}  
**Existing Suites:** ${existingSuitesStr}  
**Recommended Suite:** \`${impact.suggestedSuite}\`${suiteNote}
`;
  }

  return `## 🧪 AI-Generated Test Scripts

> Automated PR created by [LevelUp AI QA](https://app.leveluptesting.in) Test-to-Script Engine.
${intelligenceSection}${frameworkSection}

### 📋 Source

| Field | Value |
|-------|-------|
| **Requirement** | ${result.requirementTitle} |
| **Requirement ID** | #${requirementId} |
| **Total Test Cases** | ${coverage ? coverage.totalTestCases : result.totalTests} |
| **Files Generated** | ${result.totalFiles} |
${coverageSection}

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
