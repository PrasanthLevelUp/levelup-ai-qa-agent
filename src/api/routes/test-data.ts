/**
 * Test Data Store API
 *
 * Project-scoped, environment-aware test data consumed by Script Generation and
 * discoverable by the Framework Auditor (once datasets are materialized to
 * data/*.json). Loop: Test Data Store → Auditor discovers → Test Cases reference
 * → Generation uses.
 *
 * Scope note: this is Script Generation Intelligence. Healing does NOT yet
 * consume test data during recovery — that integration is future work and must
 * not be marketed as Healing Intelligence until healing truly reads datasets.
 */

import { Router, Request, Response } from 'express';
import {
  createTestDataSet, getTestDataSet, listTestDataSets, updateTestDataSet, deleteTestDataSet,
  createTestDataRecord, getTestDataRecords, updateTestDataRecord, deleteTestDataRecord,
  resolveTestData,
  linkTestCaseToDataset, unlinkTestCaseFromDataset, getLinkedDatasets,
  getTestCasesForDatasetDetailed, listTestCasesForProject,
} from '../../db/postgres';

export function createTestDataRouter(): Router {
  const router = Router();

  // ── Runtime Resolution ──────────────────────────────────────────────────────
  // Registered before `/:id` so the literal `/resolve` path is never captured by
  // the parameterized dataset-by-id route.

  /**
   * GET /api/test-data/resolve?name=valid_users&environment=prod
   * Resolve test data with environment fallback and secret hydration.
   *
   * Returns records from the target environment, falls back to 'shared' if not
   * found, and hydrates secret_ref values from Railway env vars.
   */
  router.get('/resolve', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number;
      const projectId = (req as any).projectId as number | undefined;
      const name = req.query.name as string;
      const environment = (req.query.environment as string) || 'shared';

      if (!name) {
        return res.status(400).json({ error: 'name query parameter is required' });
      }

      const data = await resolveTestData(name, companyId, projectId, environment);
      if (!data) {
        return res.status(404).json({ error: 'Test data set not found' });
      }

      return res.json({ name, environment, data });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to resolve test data', details: err.message });
    }
  });

  // ── Test Case ↔ Dataset Linkage ─────────────────────────────────────────────
  // Registered before the parameterized `/:id` routes so the multi-segment
  // linkage paths are never shadowed by `/:id`.

  /**
   * GET /api/test-data/link/test-cases
   * List candidate test cases for the active project so the dashboard can offer a
   * picker when linking a test case to a dataset. Project-scoped via middleware.
   */
  router.get('/link/test-cases', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number;
      const projectId = (req as any).projectId as number | undefined;
      const testCases = await listTestCasesForProject(companyId, projectId);
      return res.json({ testCases });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to list test cases', details: err.message });
    }
  });

  /**
   * GET /api/test-data/test-case/:testCaseId/datasets
   * List datasets linked to a test case.
   */
  router.get('/test-case/:testCaseId/datasets', async (req: Request, res: Response) => {
    try {
      const testCaseId = parseInt(String(req.params.testCaseId), 10);
      if (Number.isNaN(testCaseId)) {
        return res.status(400).json({ error: 'Invalid test case id' });
      }
      const datasets = await getLinkedDatasets(testCaseId);
      return res.json({ datasets });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to fetch linked datasets', details: err.message });
    }
  });

  /**
   * POST /api/test-data/test-case/:testCaseId/datasets/:datasetId
   * Link a test case to a dataset. Validates dataset ownership (company + project)
   * so a test case can never be linked to another tenant's dataset.
   */
  router.post('/test-case/:testCaseId/datasets/:datasetId', async (req: Request, res: Response) => {
    try {
      const testCaseId = parseInt(String(req.params.testCaseId), 10);
      const datasetId = parseInt(String(req.params.datasetId), 10);
      if (Number.isNaN(testCaseId) || Number.isNaN(datasetId)) {
        return res.status(400).json({ error: 'Invalid test case id or dataset id' });
      }
      const companyId = (req as any).companyId as number;
      const projectId = (req as any).projectId as number | undefined;

      // Ownership check: the dataset must be visible to this company/project.
      const dataset = await getTestDataSet(datasetId, companyId, projectId);
      if (!dataset) {
        return res.status(404).json({ error: 'Dataset not found or not accessible' });
      }

      await linkTestCaseToDataset(testCaseId, datasetId);
      return res.status(201).json({ success: true, testCaseId, datasetId });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to link test case to dataset', details: err.message });
    }
  });

  /**
   * DELETE /api/test-data/test-case/:testCaseId/datasets/:datasetId
   * Unlink a test case from a dataset.
   */
  router.delete('/test-case/:testCaseId/datasets/:datasetId', async (req: Request, res: Response) => {
    try {
      const testCaseId = parseInt(String(req.params.testCaseId), 10);
      const datasetId = parseInt(String(req.params.datasetId), 10);
      if (Number.isNaN(testCaseId) || Number.isNaN(datasetId)) {
        return res.status(400).json({ error: 'Invalid test case id or dataset id' });
      }
      await unlinkTestCaseFromDataset(testCaseId, datasetId);
      return res.json({ success: true });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to unlink test case from dataset', details: err.message });
    }
  });

  // ── Datasets CRUD ──────────────────────────────────────────────────────────

  /**
   * POST /api/test-data
   * Create a new test data set (project-scoped).
   */
  router.post('/', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number;
      const projectId = (req as any).projectId as number | undefined;
      const { name, description, environment, records } = req.body;

      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }

      const dataset = await createTestDataSet({
        companyId,
        projectId,
        name,
        description,
        environment: environment || 'shared',
        createdBy: (req as any).userId,
      });

      // Bulk-insert records if provided.
      if (Array.isArray(records) && records.length > 0) {
        for (const rec of records) {
          await createTestDataRecord({
            datasetId: dataset.id,
            key: rec.key,
            value: rec.value,
            dataType: rec.dataType,
            isSecret: rec.isSecret ?? false,
            secretRef: rec.secretRef,
            tags: rec.tags,
          });
        }
      }

      const fullRecords = await getTestDataRecords(dataset.id);
      return res.status(201).json({ dataset, records: fullRecords });
    } catch (err: any) {
      if (err.code === '23505') { // unique violation
        return res.status(409).json({ error: 'Dataset with this name+environment already exists in this project' });
      }
      return res.status(500).json({ error: 'Failed to create test data set', details: err.message });
    }
  });

  /**
   * GET /api/test-data
   * List all test data sets (project-scoped, optionally filtered by environment).
   */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number;
      const projectId = (req as any).projectId as number | undefined;
      const environment = req.query.environment as string | undefined;

      const datasets = await listTestDataSets(companyId, projectId, environment);
      return res.json({ datasets });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to list test data sets', details: err.message });
    }
  });

  /**
   * GET /api/test-data/:id
   * Get a single test data set with its records.
   */
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const companyId = (req as any).companyId as number;
      const projectId = (req as any).projectId as number | undefined;

      const dataset = await getTestDataSet(id, companyId, projectId);
      if (!dataset) {
        return res.status(404).json({ error: 'Test data set not found' });
      }

      const records = await getTestDataRecords(dataset.id);
      return res.json({ dataset, records });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to fetch test data set', details: err.message });
    }
  });

  /**
   * GET /api/test-data/:id/usage
   * Show which test cases consume this dataset (impact view). Verifies dataset
   * ownership first so usage can't be probed across tenants.
   */
  router.get('/:id/usage', async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      if (Number.isNaN(id)) {
        return res.status(400).json({ error: 'Invalid dataset id' });
      }
      const companyId = (req as any).companyId as number;
      const projectId = (req as any).projectId as number | undefined;

      const dataset = await getTestDataSet(id, companyId, projectId);
      if (!dataset) {
        return res.status(404).json({ error: 'Test data set not found or not accessible' });
      }

      const testCases = await getTestCasesForDatasetDetailed(id);
      return res.json({ datasetId: id, testCaseCount: testCases.length, testCases });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to fetch dataset usage', details: err.message });
    }
  });

  /**
   * PUT /api/test-data/:id
   * Update a test data set (metadata only; use /api/test-data/:id/records for records).
   */
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const companyId = (req as any).companyId as number;
      const projectId = (req as any).projectId as number | undefined;
      const { name, description, environment, version, is_active } = req.body;

      const dataset = await updateTestDataSet(id, companyId, projectId, {
        name, description, environment, version, is_active,
      });

      if (!dataset) {
        return res.status(404).json({ error: 'Test data set not found or not accessible' });
      }

      return res.json({ dataset });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to update test data set', details: err.message });
    }
  });

  /**
   * DELETE /api/test-data/:id
   * Delete a test data set (cascade deletes records).
   */
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(String(req.params.id), 10);
      const companyId = (req as any).companyId as number;
      const projectId = (req as any).projectId as number | undefined;

      const deleted = await deleteTestDataSet(id, companyId, projectId);
      if (!deleted) {
        return res.status(404).json({ error: 'Test data set not found or not accessible' });
      }

      return res.json({ success: true });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to delete test data set', details: err.message });
    }
  });

  // ── Records CRUD ───────────────────────────────────────────────────────────

  /**
   * POST /api/test-data/:id/records
   * Add a record to a dataset.
   */
  router.post('/:id/records', async (req: Request, res: Response) => {
    try {
      const datasetId = parseInt(String(req.params.id), 10);
      const companyId = (req as any).companyId as number;
      const projectId = (req as any).projectId as number | undefined;
      const { key, value, dataType, isSecret, secretRef, tags } = req.body;

      if (!key) {
        return res.status(400).json({ error: 'key is required' });
      }

      // Verify dataset ownership.
      const dataset = await getTestDataSet(datasetId, companyId, projectId);
      if (!dataset) {
        return res.status(404).json({ error: 'Dataset not found or not accessible' });
      }

      const record = await createTestDataRecord({
        datasetId,
        key,
        value,
        dataType,
        isSecret,
        secretRef,
        tags,
      });

      return res.status(201).json({ record });
    } catch (err: any) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Record with this key already exists in this dataset' });
      }
      return res.status(500).json({ error: 'Failed to create test data record', details: err.message });
    }
  });

  /**
   * PUT /api/test-data/records/:recordId
   * Update a record.
   */
  router.put('/records/:recordId', async (req: Request, res: Response) => {
    try {
      const recordId = parseInt(String(req.params.recordId), 10);
      const { value, dataType, isSecret, secretRef, tags } = req.body;

      const record = await updateTestDataRecord(recordId, {
        value_jsonb: value,
        data_type: dataType,
        is_secret: isSecret,
        secret_ref: secretRef,
        tags,
      });

      if (!record) {
        return res.status(404).json({ error: 'Record not found' });
      }

      return res.json({ record });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to update test data record', details: err.message });
    }
  });

  /**
   * DELETE /api/test-data/records/:recordId
   * Delete a record.
   */
  router.delete('/records/:recordId', async (req: Request, res: Response) => {
    try {
      const recordId = parseInt(String(req.params.recordId), 10);
      const deleted = await deleteTestDataRecord(recordId);
      if (!deleted) {
        return res.status(404).json({ error: 'Record not found' });
      }
      return res.json({ success: true });
    } catch (err: any) {
      return res.status(500).json({ error: 'Failed to delete test data record', details: err.message });
    }
  });

  return router;
}
