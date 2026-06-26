/**
 * Execution Records endpoints.
 *
 * Mounted at `/api/execution-records`. Serves the CANONICAL per-test execution
 * record — the single lifecycle document (artifacts → observations → diagnosis →
 * healing → validation → learning) the dashboard reads instead of stitching
 * together separate diagnosis / healing / evidence / artifact tables.
 *
 * Records are scoped to the request's company + project (set by middleware).
 */
import { Router, type Request, type Response } from 'express';
import { logger } from '../../utils/logger';
import { listExecutionRecords, getExecutionRecord } from '../../db/postgres';

const MOD = 'execution-records-route';

export function createExecutionRecordsRouter(): Router {
  const router = Router();

  /* ---- GET / — recent execution records for this company/project ---- */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId;
      const limitRaw = parseInt(String(req.query['limit'] ?? '50'), 10);
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
      const records = await listExecutionRecords(companyId, projectId, limit);
      return res.json({ records, count: records.length });
    } catch (err: any) {
      logger.error(MOD, 'Failed to list execution records', { error: err.message });
      return res.status(500).json({ error: 'Failed to list execution records', details: err.message });
    }
  });

  /* ---- GET /:executionId — one canonical record by id ---- */
  router.get('/:executionId', async (req: Request, res: Response) => {
    try {
      const { executionId } = req.params;
      const record = await getExecutionRecord(String(executionId));
      if (!record) {
        return res.status(404).json({ error: 'Execution record not found', executionId });
      }
      return res.json({ record });
    } catch (err: any) {
      logger.error(MOD, 'Failed to load execution record', { error: err.message });
      return res.status(500).json({ error: 'Failed to load execution record', details: err.message });
    }
  });

  return router;
}
