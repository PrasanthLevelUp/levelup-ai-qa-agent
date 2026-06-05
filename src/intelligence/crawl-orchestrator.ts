/**
 * Smart Crawl Orchestrator
 *
 * Intercepts the crawl step in script generation to provide:
 * - FAST PATH: return cached profile data (~1s DB lookup)
 * - SLOW PATH: trigger full crawl, store results (~30s)
 *
 * Performance: 30x faster script generation for repeat applications.
 */

import { logger } from '../utils/logger';
import { ProfileService, type SaveProfileInput } from './profile-service';
import { updateProfileStatus } from '../db/postgres';
import type { ApplicationProfile } from '../db/postgres';

const MOD = 'CrawlOrchestrator';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface CrawlDecision {
  /** Whether cached data was used */
  usedCache: boolean;
  /** The application profile (new or existing) */
  profile: ApplicationProfile | null;
  /** Crawl data to use for script generation */
  crawlData: any;
  /** Time taken for the decision (ms) */
  decisionTimeMs: number;
  /** Reason for the decision */
  reason: string;
}

export interface OrchestratorConfig {
  /** Force a fresh crawl even if cache is fresh */
  forceFreshCrawl?: boolean;
  /** Custom TTL in days (default 30) */
  ttlDays?: number;
  /** Auth config for authenticated crawls */
  authConfig?: any;
}

/* -------------------------------------------------------------------------- */
/*  Orchestrator                                                              */
/* -------------------------------------------------------------------------- */

export class CrawlOrchestrator {
  private readonly profileService: ProfileService;

  constructor(profileService?: ProfileService) {
    this.profileService = profileService || new ProfileService();
  }

  /**
   * Decide whether to use cached data or trigger a new crawl.
   * Returns crawl data ready for script generation.
   *
   * Does NOT perform the actual crawl — returns `null` crawlData when
   * a fresh crawl is needed, so the caller (script-gen route) can run
   * the PageCrawler and then call `saveCrawlResult`.
   */
  async decideCrawlStrategy(
    baseUrl: string,
    companyId?: number,
    config?: OrchestratorConfig,
    projectId?: number,
  ): Promise<CrawlDecision> {
    const start = Date.now();

    // Force fresh crawl requested
    if (config?.forceFreshCrawl) {
      logger.info(MOD, 'Force fresh crawl requested', { url: baseUrl, projectId });
      return {
        usedCache: false,
        profile: null,
        crawlData: null,
        decisionTimeMs: Date.now() - start,
        reason: 'Force fresh crawl requested by user',
      };
    }

    // Check for existing profile (project-scoped)
    // Wrapped in try-catch: if the application_profiles table doesn't exist yet
    // (e.g. migration hasn't run), script generation should still work via fresh crawl.
    let profile: ApplicationProfile | null = null;
    try {
      profile = await this.profileService.getOrCreateProfile(baseUrl, companyId, projectId);
    } catch (profileErr: any) {
      const isTableMissing = profileErr?.message?.includes('application_profiles') || profileErr?.code === '42P01';
      logger.warn(MOD, 'Profile lookup failed (non-blocking)', {
        url: baseUrl,
        error: profileErr.message,
        isTableMissing,
      });
      return {
        usedCache: false,
        profile: null,
        crawlData: null,
        decisionTimeMs: Date.now() - start,
        reason: isTableMissing
          ? 'application_profiles table not yet created — proceeding with fresh crawl'
          : `Profile lookup error: ${profileErr.message} — proceeding with fresh crawl`,
      };
    }

    if (!profile) {
      logger.info(MOD, 'No cached profile found — fresh crawl needed', { url: baseUrl });
      return {
        usedCache: false,
        profile: null,
        crawlData: null,
        decisionTimeMs: Date.now() - start,
        reason: 'No cached profile exists for this URL',
      };
    }

    // Check if profile needs re-crawl
    if (this.profileService.shouldRecrawl(profile)) {
      logger.info(MOD, 'Profile expired — fresh crawl needed', {
        url: baseUrl,
        status: profile.status,
        expiresAt: profile.expires_at,
      });
      return {
        usedCache: false,
        profile,
        crawlData: null,
        decisionTimeMs: Date.now() - start,
        reason: `Profile status: ${profile.status} — needs re-crawl`,
      };
    }

    // FAST PATH: use cached data
    const ageMs = Date.now() - new Date(profile.crawled_at).getTime();
    const ageDays = Math.round(ageMs / (1000 * 60 * 60 * 24));

    logger.info(MOD, 'Using cached profile (FAST PATH)', {
      url: baseUrl,
      profileId: profile.id,
      ageDays,
      pageCount: profile.page_count,
      totalElements: profile.total_elements,
    });

    return {
      usedCache: true,
      profile,
      crawlData: typeof profile.crawl_data === 'string'
        ? JSON.parse(profile.crawl_data)
        : profile.crawl_data,
      decisionTimeMs: Date.now() - start,
      reason: `Cached profile used (crawled ${ageDays} day${ageDays !== 1 ? 's' : ''} ago)`,
    };
  }

  /**
   * Save crawl results after a fresh crawl completes.
   * Called by the script-gen route after PageCrawler finishes.
   */
  async saveCrawlResult(
    baseUrl: string,
    crawlResult: any,
    companyId?: number,
    config?: OrchestratorConfig,
    projectId?: number,
  ): Promise<ApplicationProfile | null> {
    const input: SaveProfileInput = {
      baseUrl,
      crawlData: crawlResult,
      authRequired: !!config?.authConfig,
      authConfig: config?.authConfig,
      totalElements: crawlResult?.elements?.length ?? 0,
      totalForms: crawlResult?.forms?.length ?? 0,
      totalInteractive: crawlResult?.interactiveElements ?? 0,
      ttlDays: config?.ttlDays ?? 30,
      pages: [{
        url: crawlResult?.url || baseUrl,
        title: crawlResult?.title,
        pageType: crawlResult?.pageType,
        domStructure: {
          totalElements: crawlResult?.totalElements,
          interactiveElements: crawlResult?.interactiveElements,
          headings: crawlResult?.headings,
        },
        selectors: {
          forms: crawlResult?.forms,
          buttons: crawlResult?.buttons,
          inputs: crawlResult?.inputs,
          navigationLinks: crawlResult?.navigationLinks,
        },
        elementsCount: crawlResult?.elements?.length ?? 0,
        formsCount: crawlResult?.forms?.length ?? 0,
        interactiveCount: crawlResult?.interactiveElements ?? 0,
      }],
    };

    try {
      console.log(`[CrawlOrchestrator] 💾 Saving profile for ${baseUrl} (project=${projectId ?? 'none'}, company=${companyId ?? 'none'}, elements=${input.totalElements}, forms=${input.totalForms})`);
      const profile = await this.profileService.saveProfile(input, companyId, projectId);
      console.log(`[CrawlOrchestrator] ✅ Profile saved: id=${profile.id}, status=${profile.status}`);
      logger.info(MOD, 'Crawl result saved to profile', {
        profileId: profile.id,
        url: baseUrl,
        projectId,
      });
      return profile;
    } catch (saveErr: any) {
      // Non-blocking: if application_profiles table doesn't exist, log and continue.
      // Surface full Postgres error detail (code + constraint) so silent failures such as
      // an ON CONFLICT / unique-index mismatch are diagnosable from the logs.
      console.error(
        `[CrawlOrchestrator] ❌ Profile save failed for ${baseUrl}: ${saveErr.message}` +
          (saveErr.code ? ` [code=${saveErr.code}]` : '') +
          (saveErr.constraint ? ` [constraint=${saveErr.constraint}]` : ''),
      );
      logger.warn(MOD, 'Could not save crawl result to profile (non-blocking)', {
        url: baseUrl,
        companyId,
        projectId,
        error: saveErr.message,
        code: saveErr.code,
        constraint: saveErr.constraint,
        detail: saveErr.detail,
      });
      return null;
    }
  }

  /**
   * Save the result of a DEEP multi-page authenticated crawl.
   *
   * Aggregates every crawled page into a single profile: the crawl_data blob
   * holds the sitemap + per-page selector intelligence, and one page snapshot
   * row is written per discovered page.
   */
  async saveDeepCrawlResult(
    baseUrl: string,
    multi: {
      pages: any[];
      navigationGraph?: any[];
      siteMap?: any[];
      authenticated?: boolean;
      authResult?: any;
      totalCrawlTimeMs?: number;
    },
    companyId?: number,
    config?: OrchestratorConfig,
    projectId?: number,
  ): Promise<ApplicationProfile | null> {
    const pages = Array.isArray(multi?.pages) ? multi.pages : [];
    const totalElements = pages.reduce((s, p) => s + (p?.elements?.length ?? 0), 0);
    const totalForms = pages.reduce((s, p) => s + (p?.forms?.length ?? 0), 0);
    const totalInteractive = pages.reduce((s, p) => s + (p?.interactiveElements ?? 0), 0);

    // Compact crawl_data blob (omit heavy screenshot buffers / raw html).
    const crawlData = {
      multiPage: true,
      entryUrl: baseUrl,
      authenticated: !!multi?.authenticated,
      pageCount: pages.length,
      totalElements,
      totalForms,
      totalInteractive,
      siteMap: multi?.siteMap ?? [],
      navigationGraph: multi?.navigationGraph ?? [],
      crawlTimeMs: multi?.totalCrawlTimeMs,
      pages: pages.map((p) => ({
        url: p?.url,
        finalUrl: p?.finalUrl,
        title: p?.title,
        pageType: p?.pageType,
        elements: p?.elements,           // includes multi-strategy selectors
        forms: p?.forms,
        buttons: p?.buttons,
        inputs: p?.inputs,
        navigationLinks: p?.navigationLinks,
        headings: p?.headings,
        interactiveElements: p?.interactiveElements,
      })),
    };

    const input: SaveProfileInput = {
      baseUrl,
      crawlData,
      authRequired: !!config?.authConfig,
      authConfig: config?.authConfig,
      totalElements,
      totalForms,
      totalInteractive,
      ttlDays: config?.ttlDays ?? 30,
      pages: pages.map((p) => ({
        url: p?.finalUrl || p?.url || baseUrl,
        title: p?.title,
        pageType: p?.pageType,
        domStructure: {
          totalElements: p?.totalElements,
          interactiveElements: p?.interactiveElements,
          headings: p?.headings,
        },
        selectors: {
          forms: p?.forms,
          buttons: p?.buttons,
          inputs: p?.inputs,
          navigationLinks: p?.navigationLinks,
          // Per-element multi-strategy locators (id/data-testid/css/xpath).
          elements: p?.elements,
        },
        elementsCount: p?.elements?.length ?? 0,
        formsCount: p?.forms?.length ?? 0,
        interactiveCount: p?.interactiveElements ?? 0,
      })),
    };

    try {
      console.log(`[CrawlOrchestrator] 💾 Saving DEEP crawl for ${baseUrl} (pages=${pages.length}, elements=${totalElements}, forms=${totalForms}, authed=${!!multi?.authenticated})`);
      const profile = await this.profileService.saveProfile(input, companyId, projectId);
      console.log(`[CrawlOrchestrator] ✅ Deep profile saved: id=${profile.id}, status=${profile.status}, pages=${pages.length}`);
      logger.info(MOD, 'Deep crawl result saved to profile', { profileId: profile.id, url: baseUrl, pages: pages.length, projectId });
      return profile;
    } catch (saveErr: any) {
      console.error(
        `[CrawlOrchestrator] ❌ Deep profile save failed for ${baseUrl}: ${saveErr.message}` +
          (saveErr.code ? ` [code=${saveErr.code}]` : '') +
          (saveErr.constraint ? ` [constraint=${saveErr.constraint}]` : ''),
      );
      logger.warn(MOD, 'Could not save deep crawl result (non-blocking)', {
        url: baseUrl, companyId, projectId, error: saveErr.message, code: saveErr.code,
      });
      return null;
    }
  }

  /**
   * Mark a profile as currently being crawled (for long-running crawls).
   */
  async markCrawling(profileId: string): Promise<void> {
    try {
      await updateProfileStatus(profileId, 'crawling');
    } catch (err: any) {
      logger.warn(MOD, 'Could not mark profile as crawling (non-blocking)', { profileId, error: err.message });
    }
  }

  /**
   * Mark a profile crawl as failed.
   */
  async markCrawlError(profileId: string, error: string): Promise<void> {
    try {
      await updateProfileStatus(profileId, 'error', error);
    } catch (err: any) {
      logger.warn(MOD, 'Could not mark profile error (non-blocking)', { profileId, error: err.message });
    }
  }
}
