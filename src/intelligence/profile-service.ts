/**
 * Application Profile Service
 *
 * Manages cached application intelligence — crawl data stored and reused
 * across script generations for 30x faster repeat performance.
 *
 * Lifecycle: getOrCreate → shouldRecrawl → save/invalidate
 */

import * as crypto from 'crypto';
import { logger } from '../utils/logger';
import { normalizeBaseUrl } from '../utils/url-normalize';
import {
  getProfileByUrl,
  getProfileById,
  listProfiles,
  upsertProfile,
  updateProfile as dbUpdateProfile,
  updateProfileStatus,
  deleteProfile as dbDeleteProfile,
  invalidateProfile as dbInvalidateProfile,
  refreshExpiredProfiles,
  getPageSnapshots,
  upsertPageSnapshot,
  deletePageSnapshots,
  type ApplicationProfile,
} from '../db/postgres';

const MOD = 'ProfileService';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type ProfileStatus = 'cached' | 'expired' | 'not_exists' | 'crawling' | 'error';

export interface ProfileStatusResult {
  status: ProfileStatus;
  profile: ApplicationProfile | null;
  /** Milliseconds since last crawl */
  ageMs: number | null;
  /** Milliseconds until expiry (negative = already expired) */
  expiresInMs: number | null;
  pageCount: number;
}

export interface SaveProfileInput {
  baseUrl: string;
  crawlData: any;
  pages?: Array<{
    url: string;
    title?: string;
    pageType?: string;
    domStructure?: any;
    selectors?: any;
    elementsCount?: number;
    formsCount?: number;
    interactiveCount?: number;
  }>;
  authRequired?: boolean;
  authConfig?: any;
  totalElements?: number;
  totalForms?: number;
  totalInteractive?: number;
  ttlDays?: number;
  /** 'manual' (user-created) or 'auto' (background-created). Defaults to 'manual'. */
  source?: string;
}

export interface SaveProfileOptions {
  /**
   * When false, a profile is saved ONLY if one already exists for this URL/scope
   * (i.e. a refresh of cached crawl data). If no profile exists yet, the save is
   * skipped and `null` is returned — preventing background flows (such as URL
   * script generation) from silently creating brand-new profiles the user never
   * explicitly asked for. Defaults to true to preserve existing callers.
   */
  allowCreate?: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Service                                                                   */
/* -------------------------------------------------------------------------- */

export class ProfileService {
  /**
   * Get existing profile or return null — never triggers a crawl.
   * Automatically marks expired profiles.
   */
  async getOrCreateProfile(
    baseUrl: string,
    companyId?: number,
    projectId?: number,
  ): Promise<ApplicationProfile | null> {
    const normalizedUrl = this.normalizeUrl(baseUrl);
    const profile = await getProfileByUrl(normalizedUrl, companyId, projectId);
    if (!profile) return null;

    // Auto-mark expired profiles
    if (profile.status === 'fresh' && this.isExpired(profile)) {
      await updateProfileStatus(profile.id, 'expired');
      profile.status = 'expired';
    }

    return profile;
  }

  /**
   * Check whether a profile should be re-crawled.
   */
  shouldRecrawl(profile: ApplicationProfile | null): boolean {
    if (!profile) return true;
    if (profile.status === 'expired' || profile.status === 'error') return true;
    return this.isExpired(profile);
  }

  /**
   * Save crawl results as an application profile with page snapshots.
   */
  async saveProfile(
    input: SaveProfileInput,
    companyId?: number,
    projectId?: number,
    options?: SaveProfileOptions,
  ): Promise<ApplicationProfile | null> {
    const normalizedUrl = this.normalizeUrl(input.baseUrl);
    const fingerprint = this.computeFingerprint(input.crawlData);

    // Guard against silent auto-creation: when allowCreate is explicitly false,
    // only refresh an EXISTING profile. If none exists, skip the save entirely so
    // background flows never spawn profiles the user did not explicitly create.
    if (options?.allowCreate === false) {
      const existing = await getProfileByUrl(normalizedUrl, companyId, projectId);
      if (!existing) {
        logger.info(MOD, 'Skipping profile save — no existing profile and allowCreate=false', {
          url: normalizedUrl,
          projectId,
        });
        return null;
      }
    }

    logger.info(MOD, 'Saving application profile', {
      url: normalizedUrl,
      fingerprint,
      pages: input.pages?.length ?? 0,
      projectId,
      source: input.source ?? 'manual',
    });

    const profile = await upsertProfile({
      baseUrl: normalizedUrl,
      appFingerprint: fingerprint,
      crawlData: input.crawlData,
      authRequired: input.authRequired,
      authConfig: input.authConfig,
      pageCount: input.pages?.length ?? 1,
      totalElements: input.totalElements ?? 0,
      totalForms: input.totalForms ?? 0,
      totalInteractive: input.totalInteractive ?? 0,
      status: 'fresh',
      ttlDays: input.ttlDays ?? 30,
      projectId,
      source: input.source,
    }, companyId);

    // Save page snapshots
    if (input.pages?.length) {
      // Remove old snapshots first
      await deletePageSnapshots(profile.id);
      for (const page of input.pages) {
        await upsertPageSnapshot({
          profileId: profile.id,
          pageUrl: page.url,
          pageTitle: page.title,
          pageType: page.pageType,
          domStructure: page.domStructure,
          selectors: page.selectors,
          elementsCount: page.elementsCount,
          formsCount: page.formsCount,
          interactiveCount: page.interactiveCount,
        });
      }
    }

    logger.info(MOD, 'Profile saved successfully', { profileId: profile.id });
    return profile;
  }

  /**
   * Force-invalidate a profile so next generation triggers a fresh crawl.
   */
  async invalidateProfile(baseUrl: string, companyId?: number, projectId?: number): Promise<void> {
    const normalizedUrl = this.normalizeUrl(baseUrl);
    await dbInvalidateProfile(normalizedUrl, companyId, projectId);
    logger.info(MOD, 'Profile invalidated', { url: normalizedUrl, projectId });
  }

  /**
   * Get detailed profile status for a URL.
   */
  async getProfileStatus(baseUrl: string, companyId?: number, projectId?: number): Promise<ProfileStatusResult> {
    const normalizedUrl = this.normalizeUrl(baseUrl);
    const profile = await getProfileByUrl(normalizedUrl, companyId, projectId);

    if (!profile) {
      return { status: 'not_exists', profile: null, ageMs: null, expiresInMs: null, pageCount: 0 };
    }

    const now = Date.now();
    const crawledAt = new Date(profile.crawled_at).getTime();
    const expiresAt = new Date(profile.expires_at).getTime();
    const ageMs = now - crawledAt;
    const expiresInMs = expiresAt - now;

    let status: ProfileStatus;
    if (profile.status === 'error') {
      status = 'error';
    } else if (profile.status === 'crawling') {
      status = 'crawling';
    } else if (expiresInMs <= 0) {
      status = 'expired';
    } else {
      status = 'cached';
    }

    return {
      status,
      profile,
      ageMs,
      expiresInMs,
      pageCount: profile.page_count,
    };
  }

  /**
   * List all profiles for a company.
   */
  async listProfiles(companyId?: number, opts?: { status?: string; limit?: number; offset?: number; projectId?: number }) {
    return listProfiles(companyId, opts);
  }

  /**
   * Get a profile by ID with its page snapshots.
   */
  async getProfileDetail(id: string) {
    const profile = await getProfileById(id);
    if (!profile) return null;
    const pages = await getPageSnapshots(id);
    return { ...profile, pages };
  }

  /**
   * Update editable / rich-schema fields of a profile (name, description,
   * business flows, URL patterns, form fields, custom metadata, notes, tags,
   * and the screenshots array). Company-scoped to prevent cross-tenant edits.
   */
  async updateProfile(
    id: string,
    companyId: number | undefined,
    updates: {
      name?: string;
      description?: string;
      screenshots?: any[];
      businessFlows?: any[];
      urlPatterns?: any;
      formFields?: any[];
      customMetadata?: any;
      notes?: string;
      tags?: string[];
    },
  ): Promise<ApplicationProfile | null> {
    return dbUpdateProfile(id, companyId, updates);
  }

  /**
   * Append a screenshot descriptor to a profile's screenshots array.
   * Returns the updated profile, or null if not found / not owned.
   */
  async addScreenshot(
    id: string,
    companyId: number | undefined,
    screenshot: { url: string; filename?: string; caption?: string; uploadedAt?: string },
  ): Promise<ApplicationProfile | null> {
    const profile = await getProfileById(id);
    if (!profile) return null;
    if (companyId !== undefined && (profile.company_id ?? 0) !== (companyId ?? 0)) return null;
    const existing = Array.isArray((profile as any).screenshots) ? (profile as any).screenshots : [];
    const next = [...existing, { uploadedAt: new Date().toISOString(), ...screenshot }];
    return dbUpdateProfile(id, companyId, { screenshots: next });
  }

  /**
   * Remove a screenshot at the given index from a profile's screenshots array.
   * Returns { profile, removed } — `removed` is the descriptor that was deleted
   * (so the caller can unlink the file), or null if index was out of range.
   */
  async removeScreenshot(
    id: string,
    companyId: number | undefined,
    index: number,
  ): Promise<{ profile: ApplicationProfile | null; removed: any } | null> {
    const profile = await getProfileById(id);
    if (!profile) return null;
    if (companyId !== undefined && (profile.company_id ?? 0) !== (companyId ?? 0)) return null;
    const existing = Array.isArray((profile as any).screenshots) ? (profile as any).screenshots : [];
    if (index < 0 || index >= existing.length) return { profile, removed: null };
    const removed = existing[index];
    const next = existing.filter((_: any, i: number) => i !== index);
    const updated = await dbUpdateProfile(id, companyId, { screenshots: next });
    return { profile: updated, removed };
  }

  /**
   * Delete a profile and all associated snapshots.
   */
  async deleteProfile(id: string, companyId?: number): Promise<boolean> {
    return dbDeleteProfile(id, companyId);
  }

  /**
   * Background job: mark expired profiles.
   */
  async markExpiredProfiles(): Promise<number> {
    const count = await refreshExpiredProfiles();
    if (count > 0) {
      logger.info(MOD, `Marked ${count} profiles as expired`);
    }
    return count;
  }

  /* ── Helpers ──────────────────────────────────────────────────── */

  private normalizeUrl(url: string): string {
    // Delegate to the shared canonical normalizer so reads (getProfileByUrl,
    // getProfileStatus) and writes (upsertProfile) always agree on the key.
    return normalizeBaseUrl(url);
  }

  private isExpired(profile: ApplicationProfile): boolean {
    return new Date(profile.expires_at).getTime() < Date.now();
  }

  private computeFingerprint(crawlData: any): string {
    // Hash key structural elements to detect app changes
    const sig = JSON.stringify({
      forms: crawlData?.forms?.length ?? 0,
      buttons: crawlData?.buttons?.length ?? 0,
      inputs: crawlData?.inputs?.length ?? 0,
      navLinks: crawlData?.navigationLinks?.length ?? 0,
      pageType: crawlData?.pageType,
    });
    return crypto.createHash('sha256').update(sig).digest('hex').slice(0, 16);
  }
}
