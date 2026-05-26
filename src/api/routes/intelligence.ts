/**
 * Application Intelligence API Routes
 *
 * Profile Management:
 *   GET  /api/intelligence/profiles              — List all profiles
 *   GET  /api/intelligence/profiles/:id           — Get profile detail
 *   GET  /api/intelligence/profiles/status        — Get profile status for URL
 *   POST /api/intelligence/profiles/invalidate    — Force-invalidate a profile
 *   DELETE /api/intelligence/profiles/:id         — Delete a profile
 *
 * Self-Healing (Phase 2 Foundation):
 *   POST /api/intelligence/healing/analyze        — Analyze test file for broken selectors
 *   POST /api/intelligence/healing/fix            — Get fix suggestions for a selector
 *
 * Pattern Recognition (Phase 3 Foundation):
 *   GET  /api/intelligence/patterns               — List learned patterns
 *   POST /api/intelligence/patterns/detect        — Detect patterns in crawl data
 */

import { Router, type Request, type Response } from 'express';
import { ProfileService } from '../../intelligence/profile-service';
import { CrawlOrchestrator } from '../../intelligence/crawl-orchestrator';
import { SelectorHealingEngine } from '../../intelligence/healing-engine';
import { PatternMatcher } from '../../intelligence/pattern-matcher';
import { findMatchingPatterns } from '../../db/postgres';

export function createIntelligenceRouter(): Router {
  const router = Router();
  const profileService = new ProfileService();
  const crawlOrchestrator = new CrawlOrchestrator(profileService);
  const healingEngine = new SelectorHealingEngine(profileService);
  const patternMatcher = new PatternMatcher();

  /* ══════════════════════════════════════════════════════════════════
   *  PROFILE MANAGEMENT
   * ══════════════════════════════════════════════════════════════════ */

  /** List all application profiles */
  router.get('/profiles', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const status = req.query.status as string | undefined;
      const limit = parseInt(String(req.query.limit || '50'), 10);
      const offset = parseInt(String(req.query.offset || '0'), 10);

      const result = await profileService.listProfiles(companyId, { status, limit, offset });
      res.json({ success: true, data: result.profiles, total: result.total });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  /** Get profile status for a URL (used by script generator) */
  router.get('/profiles/status', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const url = String(req.query.url || '');
      if (!url) return res.status(400).json({ success: false, error: 'url query parameter required' });

      const status = await profileService.getProfileStatus(url, companyId);
      res.json({ success: true, data: status });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  /** Get profile detail with page snapshots */
  router.get('/profiles/:id', async (req: Request, res: Response) => {
    try {
      const detail = await profileService.getProfileDetail(String(req.params.id));
      if (!detail) return res.status(404).json({ success: false, error: 'Profile not found' });
      res.json({ success: true, data: detail });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  /** Force-invalidate a profile (triggers re-crawl on next generation) */
  router.post('/profiles/invalidate', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const { url } = req.body;
      if (!url) return res.status(400).json({ success: false, error: 'url is required' });

      await profileService.invalidateProfile(url, companyId);
      res.json({ success: true, message: 'Profile invalidated — next generation will re-crawl' });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  /** Delete a profile and all snapshots */
  router.delete('/profiles/:id', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const deleted = await profileService.deleteProfile(String(req.params.id), companyId);
      if (!deleted) return res.status(404).json({ success: false, error: 'Profile not found' });
      res.json({ success: true, message: 'Profile deleted' });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  /** Get crawl decision for a URL (preview — does not execute crawl) */
  router.post('/profiles/crawl-decision', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const { url, forceFreshCrawl, ttlDays } = req.body;
      if (!url) return res.status(400).json({ success: false, error: 'url is required' });

      const decision = await crawlOrchestrator.decideCrawlStrategy(url, companyId, {
        forceFreshCrawl,
        ttlDays,
      });
      res.json({ success: true, data: decision });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  /* ══════════════════════════════════════════════════════════════════
   *  SELF-HEALING (Phase 2 Foundation)
   * ══════════════════════════════════════════════════════════════════ */

  /** Analyze a test file for broken selectors */
  router.post('/healing/analyze', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const { testContent, baseUrl } = req.body;
      if (!testContent || !baseUrl) {
        return res.status(400).json({ success: false, error: 'testContent and baseUrl are required' });
      }

      const suggestions = await healingEngine.analyzeTestFile(testContent, baseUrl, companyId);
      res.json({
        success: true,
        data: {
          suggestions,
          totalBroken: suggestions.length,
          autoFixable: suggestions.filter(s => s.confidence >= 0.8).length,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  /** Get fix suggestions for a specific broken selector */
  router.post('/healing/fix', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const { selector, baseUrl } = req.body;
      if (!selector || !baseUrl) {
        return res.status(400).json({ success: false, error: 'selector and baseUrl are required' });
      }

      const analysis = await healingEngine.analyzeSelector(selector, baseUrl, companyId);
      res.json({ success: true, data: analysis });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  /* ══════════════════════════════════════════════════════════════════
   *  PATTERN RECOGNITION (Phase 3 Foundation)
   * ══════════════════════════════════════════════════════════════════ */

  /** List learned patterns */
  router.get('/patterns', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const type = String(req.query.type || 'login_form');
      const patterns = await findMatchingPatterns(type || 'login_form', companyId);
      res.json({ success: true, data: patterns });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  /** Detect patterns from crawl data (can be called after a crawl) */
  router.post('/patterns/detect', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const { crawlData } = req.body;
      if (!crawlData) {
        return res.status(400).json({ success: false, error: 'crawlData is required' });
      }

      const detected = patternMatcher.detectPatterns(crawlData);
      // Store learned patterns
      const stored = await patternMatcher.learnPatterns(crawlData, companyId);

      res.json({
        success: true,
        data: {
          detected,
          storedCount: stored,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  return router;
}
