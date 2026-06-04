/**
 * Release Signoff Assistant — API Routes
 *
 * GET /api/release-signoff/generate?days=30   — Generate full signoff report
 * GET /api/release-signoff/decision?days=30   — Quick signoff decision only
 */

import { Router, type Request, type Response } from 'express';
import {
  getReleaseRiskData,
  getFlakyTests,
  getLearningStats,
} from '../../db/postgres';
import { generateSignoffReport } from '../../engines/release-signoff-engine';
import { logger } from '../../utils/logger';

const MOD = 'release-signoff-routes';

export function createReleaseSignoffRouter(): Router {
  const router = Router();

  /**
   * GET /generate?days=30
   * Generate a full release signoff report.
   */
  router.get('/generate', async (req: Request, res: Response) => {
    try {
      const cid = (req as any).companyId;
      const pid = (req as any).projectId;
      const days = parseInt(req.query.days as string, 10) || 30;

      // Gather all data sources in parallel
      const [riskData, flakyTests, learningStats] = await Promise.all([
        getReleaseRiskData(days, cid, pid),
        getFlakyTests(cid, pid),
        getLearningStats(cid),
      ]);

      const report = generateSignoffReport({
        riskData,
        flakyTests: flakyTests.map(f => ({
          test_name: f.test_name,
          flaky_count: f.flaky_count,
          flaky_rate: f.flaky_rate,
        })),
        learningStats: {
          totalPatterns: learningStats.totalPatterns,
          totalUsages: learningStats.totalUsages,
          totalTokensSaved: learningStats.totalTokensSaved,
        },
        windowDays: days,
      });

      res.json(report);
    } catch (err) {
      logger.error(MOD, 'Failed to generate signoff report', { error: err });
      res.status(500).json({ error: 'Failed to generate signoff report' });
    }
  });

  /**
   * GET /decision?days=30
   * Quick signoff decision without full report details.
   */
  router.get('/decision', async (req: Request, res: Response) => {
    try {
      const cid = (req as any).companyId;
      const pid = (req as any).projectId;
      const days = parseInt(req.query.days as string, 10) || 30;

      const [riskData, flakyTests, learningStats] = await Promise.all([
        getReleaseRiskData(days, cid, pid),
        getFlakyTests(cid, pid),
        getLearningStats(cid),
      ]);

      const report = generateSignoffReport({
        riskData,
        flakyTests: flakyTests.map(f => ({
          test_name: f.test_name,
          flaky_count: f.flaky_count,
          flaky_rate: f.flaky_rate,
        })),
        learningStats: {
          totalPatterns: learningStats.totalPatterns,
          totalUsages: learningStats.totalUsages,
          totalTokensSaved: learningStats.totalTokensSaved,
        },
        windowDays: days,
      });

      res.json({
        decision: report.decision,
        decisionReason: report.decisionReason,
        grade: report.riskAssessment.grade,
        overallScore: report.riskAssessment.overallScore,
        executiveSummary: report.executiveSummary,
        generatedAt: report.generatedAt,
      });
    } catch (err) {
      logger.error(MOD, 'Failed to get signoff decision', { error: err });
      res.status(500).json({ error: 'Failed to get signoff decision' });
    }
  });

  return router;
}
