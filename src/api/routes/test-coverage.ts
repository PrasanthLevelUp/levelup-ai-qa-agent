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
} from '../../db/postgres';

const MOD = 'test-coverage-routes';

export function createTestCoverageRouter(): Router {
  const router = Router();
  let engine: TestCoverageEngine | null = null;

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
      } = req.body;

      if (!title || !description) {
        return res.status(400).json({ error: 'title and description are required' });
      }

      const selectedTypes: CoverageType[] = coverageTypes?.length
        ? coverageTypes
        : ['positive', 'negative', 'edge_cases'];

      const companyId = (req as any).companyId;

      // Fetch app knowledge for context
      const knowledgeRows = await getApplicationKnowledge(companyId);
      const knowledge: KnowledgeContext = {
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

      const input: RequirementInput = {
        title, description, jiraId, businessFlow,
        acceptanceCriteria, apiDocs, releaseNotes, module: mod,
      };

      logger.info(MOD, 'Generating test coverage', { title, coverageTypes: selectedTypes });
      const result = await getEngine().generateFullCoverage(input, selectedTypes, knowledge);

      // Persist to DB
      const reqId = await createTestRequirement({
        title, description, jiraId, businessFlow, acceptanceCriteria,
        apiDocs, releaseNotes, module: mod,
        featureType: result.requirementAnalysis.featureType,
        riskLevel: result.requirementAnalysis.riskLevel,
        analysis: result.requirementAnalysis,
        companyId,
      });

      // Insert scenarios
      const scenarioIds = await insertTestScenarios(reqId, result.scenarios.map(s => ({
        scenario: s.scenario,
        coverageType: s.coverageType,
        priority: s.priority,
        riskArea: s.riskArea,
      })), companyId);

      // Map test cases to scenarios (distribute evenly if no direct mapping)
      if (result.testCases.length > 0 && scenarioIds.length > 0) {
        // Group test cases by matching coverage type with scenario
        const scenariosWithType = result.scenarios.map((s, i) => ({ ...s, dbId: scenarioIds[i] }));
        for (const tc of result.testCases) {
          // Find best matching scenario by tags/coverage type
          const matchingScenario = scenariosWithType.find(s => {
            if (tc.tags?.length) {
              return tc.tags.some(t => s.coverageType.includes(t) || s.scenario.toLowerCase().includes(t.toLowerCase()));
            }
            return false;
          }) || scenariosWithType[0];

          await insertTestCases(matchingScenario.dbId, [{
            title: tc.title,
            preconditions: tc.preconditions,
            steps: tc.steps,
            expectedResult: tc.expectedResult,
            testData: tc.testData,
            priority: tc.priority,
            severity: tc.severity,
            tags: tc.tags,
            automationReady: tc.automationReady,
            automationComplexity: tc.automationComplexity,
            selectorAvailability: tc.selectorAvailability,
          }], companyId);
        }
      }

      return res.json({
        requirementId: reqId,
        ...result,
      });
    } catch (err: any) {
      logger.error(MOD, 'Generation failed', { error: err.message });
      return res.status(500).json({ error: 'Generation failed', details: err.message });
    }
  });

  /* ---- GET /requirements — List all requirements ---- */
  router.get('/requirements', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const reqs = await getTestRequirements(companyId);
      return res.json(reqs);
    } catch (err: any) {
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
      const stats = await getTestCoverageStats(companyId);
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

  return router;
}
