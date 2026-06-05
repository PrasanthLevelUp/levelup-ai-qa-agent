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
import * as path from 'path';
import * as fs from 'fs';
import multer from 'multer';
import { ProfileService } from '../../intelligence/profile-service';
import { CrawlOrchestrator } from '../../intelligence/crawl-orchestrator';
import { SelectorHealingEngine } from '../../intelligence/healing-engine';
import { PatternMatcher } from '../../intelligence/pattern-matcher';
import { findMatchingPatterns, migrateDataToDefaultProjects, getProjectStats, listProfiles, listRepositories, getKnowledgeStats, upsertProfile, getPool, getProfileById, updateProfileAuth, updateProfileStatus } from '../../db/postgres';
import { PageCrawler } from '../../script-gen/page-crawler';
import { IntelligenceHealthService } from '../../services/intelligence-health-service';

/* ──────────────────────────────────────────────────────────────────────────
 *  Screenshot upload configuration (multer → local disk)
 *
 *  NOTE: On platforms with an ephemeral filesystem (e.g. Railway), files
 *  written to local disk do NOT persist across deploys/restarts. The DB stores
 *  the screenshot descriptor (url/filename/caption) so the record survives, but
 *  the binary should be migrated to durable object storage (S3/GCS) for prod.
 *  The upload dir is overridable via PROFILE_UPLOAD_DIR.
 * ──────────────────────────────────────────────────────────────────────── */
export const PROFILE_SCREENSHOT_DIR =
  process.env.PROFILE_UPLOAD_DIR || path.join(process.cwd(), 'uploads', 'profile-screenshots');

try {
  fs.mkdirSync(PROFILE_SCREENSHOT_DIR, { recursive: true });
} catch {
  /* directory creation is best-effort; multer will surface errors at runtime */
}

const screenshotStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, PROFILE_SCREENSHOT_DIR),
  filename: (req, file, cb) => {
    const profileId = String((req.params as any).id || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '');
    const ext = (path.extname(file.originalname) || '.png').toLowerCase();
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${profileId}-${unique}${ext}`);
  },
});

const screenshotUpload = multer({
  storage: screenshotStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (/^image\/(png|jpe?g|gif|webp)$/i.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only PNG, JPG, GIF, or WEBP image files are allowed'));
  },
});

/**
 * Strip credential values from a profile before returning it to the client.
 * The presence of auth is exposed via `auth_required` and a boolean flag,
 * but raw username/password are never echoed back.
 */
function sanitizeProfileAuth(profile: any): any {
  if (!profile) return profile;
  const ac = profile.auth_config
    ? (typeof profile.auth_config === 'string' ? JSON.parse(profile.auth_config) : profile.auth_config)
    : null;
  return {
    ...profile,
    auth_config: ac
      ? {
          loginUrl: ac.loginUrl,
          hasCredentials: !!(ac.credentials && (ac.credentials.username || ac.credentials.email)),
          username: ac.credentials?.username || ac.credentials?.email || undefined, // username is not secret
          customSelectors: ac.customSelectors,
        }
      : null,
  };
}

export function createIntelligenceRouter(): Router {
  const router = Router();
  const profileService = new ProfileService();
  const crawlOrchestrator = new CrawlOrchestrator(profileService);
  const healingEngine = new SelectorHealingEngine(profileService);
  const patternMatcher = new PatternMatcher();

  /* ══════════════════════════════════════════════════════════════════
   *  PROFILE MANAGEMENT (project-scoped via x-project-id header)
   * ══════════════════════════════════════════════════════════════════ */

  /** List all application profiles (filtered by project if x-project-id set) */
  router.get('/profiles', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId as number | undefined;
      const status = req.query.status as string | undefined;
      const limit = parseInt(String(req.query.limit || '50'), 10);
      const offset = parseInt(String(req.query.offset || '0'), 10);

      const result = await profileService.listProfiles(companyId, { status, limit, offset, projectId });
      res.json({ success: true, data: result.profiles.map(sanitizeProfileAuth), total: result.total });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  /**
   * Manually create a human-curated application profile (no crawl required).
   * Only base_url is mandatory; all rich fields are optional. Re-using the same
   * base_url within a project upserts (preserving any crawl-supplied data).
   */
  router.post('/profiles', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId as number | undefined;
      const b = req.body || {};
      const baseUrl = String(b.baseUrl || b.base_url || '').trim();
      if (!baseUrl) {
        return res.status(400).json({ success: false, error: 'baseUrl is required' });
      }

      const profile = await upsertProfile(
        {
          baseUrl,
          crawlData: {},
          status: 'fresh',
          name: b.name,
          description: b.description,
          businessFlows: b.businessFlows,
          urlPatterns: b.urlPatterns,
          formFields: b.formFields,
          customMetadata: b.customMetadata,
          notes: b.notes,
          tags: b.tags,
          screenshots: b.screenshots,
          projectId,
        },
        companyId,
      );

      res.status(201).json({ success: true, data: profile });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  /** Get profile status for a URL (used by script generator) */
  router.get('/profiles/status', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId as number | undefined;
      const url = String(req.query.url || '');
      if (!url) return res.status(400).json({ success: false, error: 'url query parameter required' });

      const status = await profileService.getProfileStatus(url, companyId, projectId);
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
      res.json({ success: true, data: sanitizeProfileAuth(detail) });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  /** Force-invalidate a profile (triggers re-crawl on next generation) */
  router.post('/profiles/invalidate', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId as number | undefined;
      const { url } = req.body;
      if (!url) return res.status(400).json({ success: false, error: 'url is required' });

      await profileService.invalidateProfile(url, companyId, projectId);
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

  /**
   * Update editable / rich-schema fields of a profile.
   * Accepts any subset of: name, description, businessFlows, urlPatterns,
   * formFields, customMetadata, notes, tags, screenshots.
   */
  router.put('/profiles/:id', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const b = req.body || {};
      const updates: Record<string, unknown> = {};
      if (b.name !== undefined) updates.name = b.name;
      if (b.description !== undefined) updates.description = b.description;
      if (b.businessFlows !== undefined) updates.businessFlows = b.businessFlows;
      if (b.urlPatterns !== undefined) updates.urlPatterns = b.urlPatterns;
      if (b.formFields !== undefined) updates.formFields = b.formFields;
      if (b.customMetadata !== undefined) updates.customMetadata = b.customMetadata;
      if (b.notes !== undefined) updates.notes = b.notes;
      if (b.tags !== undefined) updates.tags = b.tags;
      if (b.screenshots !== undefined) updates.screenshots = b.screenshots;

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({ success: false, error: 'No updatable fields provided' });
      }

      const updated = await profileService.updateProfile(String(req.params.id), companyId, updates);
      if (!updated) return res.status(404).json({ success: false, error: 'Profile not found' });
      res.json({ success: true, data: updated });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  /**
   * Upload a screenshot for a profile (multipart/form-data, field name "screenshot").
   * Stores the file on disk and appends a descriptor to the profile's screenshots array.
   */
  router.post(
    '/profiles/:id/screenshots',
    screenshotUpload.single('screenshot'),
    async (req: Request, res: Response) => {
      const file = (req as any).file as Express.Multer.File | undefined;
      try {
        const companyId = (req as any).companyId;
        if (!file) return res.status(400).json({ success: false, error: 'No screenshot file uploaded (field name: "screenshot")' });

        const descriptor = {
          url: `/uploads/profile-screenshots/${file.filename}`,
          filename: file.filename,
          originalName: file.originalname,
          size: file.size,
          mimeType: file.mimetype,
          caption: (req.body && req.body.caption) || undefined,
          uploadedAt: new Date().toISOString(),
        };

        const updated = await profileService.addScreenshot(String(req.params.id), companyId, descriptor);
        if (!updated) {
          // Profile not found / not owned — clean up the orphaned file.
          fs.unlink(file.path, () => {});
          return res.status(404).json({ success: false, error: 'Profile not found' });
        }
        res.status(201).json({ success: true, data: { profile: updated, screenshot: descriptor } });
      } catch (err) {
        if (file) fs.unlink(file.path, () => {});
        res.status(500).json({ success: false, error: (err as Error).message });
      }
    },
  );

  /** Delete a screenshot from a profile by its array index (and unlink the file). */
  router.delete('/profiles/:id/screenshots/:index', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const index = parseInt(String(req.params.index), 10);
      if (Number.isNaN(index) || index < 0) {
        return res.status(400).json({ success: false, error: 'Invalid screenshot index' });
      }

      const result = await profileService.removeScreenshot(String(req.params.id), companyId, index);
      if (!result) return res.status(404).json({ success: false, error: 'Profile not found' });
      if (result.removed === null) {
        return res.status(404).json({ success: false, error: 'Screenshot index out of range' });
      }

      // Best-effort unlink of the underlying file.
      const fname = result.removed && result.removed.filename;
      if (fname) {
        fs.unlink(path.join(PROFILE_SCREENSHOT_DIR, String(fname)), () => {});
      }
      res.json({ success: true, data: result.profile });
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

  /**
   * Save authentication config for a profile (used by the "Configure Auth" UI).
   *
   * Body: { username, password, loginUrl?, usernameSelector?, passwordSelector?,
   *         submitSelector?, authRequired? }
   *
   * SECURITY: credentials are stored in the auth_config JSONB column and are
   * never echoed back in responses or logs.
   */
  router.post('/profiles/:id/auth', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const id = String(req.params.id);
      const b = req.body || {};

      const profile = await getProfileById(id);
      if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

      const username = String(b.username || b.email || '').trim();
      const password = String(b.password || '').trim();
      const authRequired = b.authRequired !== undefined ? !!b.authRequired : true;

      // Allow clearing auth entirely.
      if (!authRequired) {
        const cleared = await updateProfileAuth(id, false, null, companyId);
        return res.json({ success: true, data: sanitizeProfileAuth(cleared) });
      }

      if (!username || !password) {
        return res.status(400).json({ success: false, error: 'username and password are required when authRequired is true' });
      }

      const customSelectors: Record<string, string> = {};
      if (b.usernameSelector) customSelectors.usernameField = String(b.usernameSelector);
      if (b.passwordSelector) customSelectors.passwordField = String(b.passwordSelector);
      if (b.submitSelector) customSelectors.submitButton = String(b.submitSelector);

      const authConfig: any = {
        loginUrl: b.loginUrl ? String(b.loginUrl).trim() : undefined,
        credentials: { username, password },
      };
      if (Object.keys(customSelectors).length) authConfig.customSelectors = customSelectors;

      const updated = await updateProfileAuth(id, true, authConfig, companyId);
      if (!updated) return res.status(404).json({ success: false, error: 'Profile not found' });

      // Never return credential values to the client.
      res.json({ success: true, data: sanitizeProfileAuth(updated) });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  /**
   * Manually trigger a real DEEP crawl for a profile (the "Crawl Now" button).
   *
   * Runs asynchronously: the profile is immediately marked `crawling` and the
   * crawl proceeds in the background (it can take 30s+). The UI polls
   * GET /profiles/:id to observe status transition to `fresh` (or `error`).
   *
   * If the profile has auth_config saved, the crawl authenticates first, then
   * autonomously discovers and visits internal pages in the same session.
   */
  router.post('/profiles/:id/crawl', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId as number | undefined;
      const id = String(req.params.id);
      const b = req.body || {};

      const profile = await getProfileById(id);
      if (!profile) return res.status(404).json({ success: false, error: 'Profile not found' });

      const baseUrl = profile.base_url;
      const maxPages = Math.min(parseInt(String(b.maxPages || 12), 10) || 12, 15);
      const maxDepth = Math.min(parseInt(String(b.maxDepth || 2), 10) || 2, 3);
      const authConfig = profile.auth_config
        ? (typeof profile.auth_config === 'string' ? JSON.parse(profile.auth_config) : profile.auth_config)
        : undefined;

      // Mark crawling immediately so the UI reflects progress.
      await updateProfileStatus(id, 'crawling');

      // Fire-and-forget: run the deep crawl in the background.
      (async () => {
        const t0 = Date.now();
        try {
          console.log(`[intelligence] 🕷️  Manual deep crawl started for ${baseUrl} (profile=${id}, auth=${!!authConfig}, maxPages=${maxPages}, maxDepth=${maxDepth})`);
          const crawler = new PageCrawler({
            url: baseUrl,
            authConfig,
            maxPages,
            maxDepth,
            captureScreenshot: true,
          });
          const result = await crawler.crawlDeepAuthenticated();
          await crawlOrchestrator.saveDeepCrawlResult(
            baseUrl,
            result,
            companyId,
            { authConfig },
            projectId ?? profile.project_id ?? undefined,
          );
          console.log(`[intelligence] ✅ Manual deep crawl finished for ${baseUrl}: pages=${result.pages.length}, authed=${result.authenticated}, ${Date.now() - t0}ms`);
        } catch (crawlErr: any) {
          console.error(`[intelligence] ❌ Manual deep crawl failed for ${baseUrl}: ${crawlErr.message}`);
          await updateProfileStatus(id, 'error', crawlErr.message).catch(() => {});
        }
      })();

      res.status(202).json({
        success: true,
        message: 'Crawl started — poll GET /profiles/:id for status',
        data: { id, status: 'crawling', baseUrl, authenticated: !!authConfig, maxPages, maxDepth },
      });
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

  /** List learned patterns (project-scoped + shared) */
  router.get('/patterns', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId as number | undefined;
      const type = String(req.query.type || 'login_form');
      const patterns = await findMatchingPatterns(type || 'login_form', companyId, projectId);
      res.json({ success: true, data: patterns });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  /** Detect patterns from crawl data (can be called after a crawl) */
  router.post('/patterns/detect', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId as number | undefined;
      const { crawlData } = req.body;
      if (!crawlData) {
        return res.status(400).json({ success: false, error: 'crawlData is required' });
      }

      const detected = patternMatcher.detectPatterns(crawlData);
      // Store learned patterns (project-scoped)
      const stored = await patternMatcher.learnPatterns(crawlData, companyId, projectId);

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

  /* ══════════════════════════════════════════════════════════════════
   *  MULTI-PROJECT MANAGEMENT
   * ══════════════════════════════════════════════════════════════════ */

  /** Migrate orphaned data to default projects */
  router.post('/migrate', async (_req: Request, res: Response) => {
    try {
      const result = await migrateDataToDefaultProjects();
      res.json({ success: true, data: result });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  /** Get project-scoped stats */
  router.get('/project-stats', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId as number | undefined;
      if (!projectId) {
        return res.status(400).json({ success: false, error: 'x-project-id header is required' });
      }
      const stats = await getProjectStats(projectId, companyId);
      res.json({ success: true, data: stats });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  /* ══════════════════════════════════════════════════════════════════
   *  VERIFY INTELLIGENCE SETUP — one-call health check
   * ══════════════════════════════════════════════════════════════════ */

  /** Check what intelligence sources are available for the current project */
  router.get('/verify', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number;
      const projectId = (req as any).projectId as number | undefined;

      // 1. Repository Intelligence
      let repositoryConnected = false;
      let repositoryName: string | null = null;
      let detectedFramework: string | null = null;
      let patternsCount = 0;
      let helpersCount = 0;
      let pageObjectsCount = 0;
      let repoId: string | null = null;

      if (projectId) {
        try {
          const repos = await listRepositories(projectId, companyId);
          if (repos.length > 0) {
            const repo = repos[0]; // primary repo
            repositoryConnected = true;
            repositoryName = repo.full_name || repo.name || null;
            repoId = repo.id?.toString() || null;
            // Try to get scan results
            if (repo.scan_results) {
              const scan = typeof repo.scan_results === 'string' ? JSON.parse(repo.scan_results) : repo.scan_results;
              detectedFramework = scan?.framework || scan?.testingFramework || null;
              patternsCount = scan?.patterns?.length ?? scan?.testPatterns?.length ?? 0;
              helpersCount = scan?.helpers?.length ?? scan?.helperFunctions?.length ?? 0;
              pageObjectsCount = scan?.pageObjects?.length ?? 0;
            }
          }
        } catch { /* repos table might not exist */ }
      }

      // 2. Application Profiles
      let profilesCount = 0;
      let freshProfilesCount = 0;
      try {
        const profiles = await listProfiles(companyId, { projectId, limit: 100 });
        profilesCount = profiles.total;
        freshProfilesCount = profiles.profiles.filter(p => p.status === 'fresh').length;
      } catch { /* table might not exist */ }

      // 3. App Knowledge
      let appKnowledgeCount = 0;
      let knowledgeCategories = 0;
      try {
        const kStats = await getKnowledgeStats(companyId, projectId);
        appKnowledgeCount = kStats.total;
        knowledgeCategories = Object.keys(kStats.byCategory || {}).length;
      } catch { /* table might not exist */ }

      res.json({
        success: true,
        data: {
          // Repository Intelligence
          repositoryConnected,
          repositoryName,
          repoId,
          detectedFramework,
          patternsCount,
          helpersCount,
          pageObjectsCount,
          // Application Profiles
          profilesCount,
          freshProfilesCount,
          // App Knowledge
          appKnowledgeCount,
          knowledgeCategories,
          // Overall readiness
          overallScore: (repositoryConnected ? 33 : 0) + (profilesCount > 0 ? 33 : 0) + (appKnowledgeCount > 0 ? 34 : 0),
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: (err as Error).message });
    }
  });

  /* ══════════════════════════════════════════════════════════════════
   *  INTELLIGENCE HEALTH SCORE & RECOMMENDATIONS
   * ══════════════════════════════════════════════════════════════════ */

  /**
   * GET /api/intelligence/health
   * Full intelligence health report — per-source scores, overall score,
   * actionable recommendations and usage statistics for the current
   * company/project scope.
   */
  router.get('/health', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number;
      const projectId = (req as any).projectId as number | undefined;

      const healthService = new IntelligenceHealthService(getPool());
      const health = await healthService.calculateHealth(companyId, projectId);

      res.json({ success: true, data: health });
    } catch (error) {
      console.error('Intelligence health check error:', error);
      res.status(500).json({ success: false, error: 'Failed to calculate intelligence health' });
    }
  });

  /**
   * GET /api/intelligence/stats
   * Intelligence usage statistics only (subset of /health).
   */
  router.get('/stats', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number;
      const projectId = (req as any).projectId as number | undefined;

      const healthService = new IntelligenceHealthService(getPool());
      const health = await healthService.calculateHealth(companyId, projectId);

      res.json({ success: true, data: health.stats });
    } catch (error) {
      console.error('Intelligence stats error:', error);
      res.status(500).json({ success: false, error: 'Failed to get intelligence stats' });
    }
  });

  return router;
}
