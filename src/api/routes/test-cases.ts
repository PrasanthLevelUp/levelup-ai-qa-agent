/**
 * API Routes — Test Cases (Sprint 4: Enterprise Script Generation Enhancement)
 * =============================================================================
 *
 * Exposes a single-test-case fetch endpoint used by the Script Generation page
 * to load the full Requirement → Test Case → Steps context in one round-trip
 * before generating a script.
 *
 *   GET /api/test-cases/:id
 *     → { success: true, data: <test case + steps + scenario + requirement> }
 *
 * The handler is company-scoped (multi-tenant isolation) and tolerant of legacy
 * rows whose company_id is NULL (see getTestCaseById). It never leaks the
 * existence of another company's test case — unknown / cross-company ids return
 * a 404.
 */

import { Router, type Request, type Response } from 'express';
import { logger } from '../../utils/logger';
import { getTestCaseById } from '../../db/postgres';

const MOD = 'test-cases-routes';

export function createTestCasesRouter(): Router {
  const router = Router();

  /* ---- GET /:id — fetch a single test case (+ steps, scenario, requirement) ---- */
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ success: false, error: 'A valid numeric test case id is required' });
      }

      const companyId = (req as any).companyId;
      logger.info(MOD, 'Fetching test case', { id, companyId });

      const testCase = await getTestCaseById(id, companyId);
      if (!testCase) {
        return res.status(404).json({ success: false, error: 'Test case not found' });
      }

      return res.json({ success: true, data: testCase });
    } catch (error: any) {
      logger.error(MOD, 'Failed to fetch test case', { error: error?.message });
      return res.status(500).json({ success: false, error: 'Failed to fetch test case' });
    }
  });

  return router;
}
