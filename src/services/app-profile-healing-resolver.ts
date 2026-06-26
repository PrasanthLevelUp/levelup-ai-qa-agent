/**
 * App Profile Healing Resolver
 *
 * Resolves the Application Profile for a test failure using a deterministic
 * URL cascade: failure URL → execution base URL → latest active project profile.
 *
 * WHY THIS EXISTS
 * ---------------
 * Locator timeouts (the most common failure type) carry NO URL in the error
 * message — just "locator.click: Timeout 30000ms exceeded." The old logic:
 *
 *   if (!failure?.url) return EMPTY;
 *
 * ...immediately gave up. But the REAL page URL exists in the Playwright trace
 * (via TraceParser), and if that's missing we have other sources: the execution's
 * configured base URL, or the project's latest active profile (single-app repos).
 *
 * This resolver implements a healing-specific cascade that maximizes profile
 * resolution without guessing or ambiguity.
 *
 * DESIGN CONSTRAINTS (from review / requirements)
 * ------------------------------------------------
 * 1. DETERMINISTIC: no "newest crawl across all apps" — that silently switches
 *    contexts in multi-app projects. The latest-active fallback is PROJECT-scoped.
 * 2. HEALING-SPECIFIC: this resolver is tailored to the healing use case (where
 *    we have execution context). Generic profile queries (e.g., from the UI or
 *    API) should use the main profile service directly.
 * 3. NO MULTI-APP AMBIGUITY: if no URL matches and the project has multiple apps,
 *    the fallback returns NONE (explicit signal) instead of guessing.
 *
 * CASCADE
 * -------
 * 1. failure.url (REAL page URL, extracted from trace via TraceParser)
 *    → most specific; this is the page that was rendered when the test failed
 * 2. execution base URL (from playwright.config baseURL or BASE_URL env)
 *    → project-level default when the trace has no URL or is missing
 * 3. latest active project profile (most-recently-crawled profile for this project)
 *    → last resort for single-app projects; avoids multi-app guessing
 *
 * Each step returns immediately on a match. URLs are de-duped to avoid redundant
 * lookups (e.g., if failure.url === execution.baseUrl).
 */

import { findProfileForUrl, getLatestActiveProjectProfile } from './app-profile-healing';
import type { ApplicationProfile } from '../db/postgres';

export interface ProfileResolutionSignal {
  /** The URL that triggered this signal (null for project-level fallback). */
  url: string | null;
  /** Human-readable label for observability (e.g., "Failure URL", "Execution Base URL"). */
  source: 'failure_url' | 'execution_base_url' | 'project_latest_active' | 'none';
}

export interface ProfileResolutionResult {
  /** The resolved profile (null if no match). */
  profile: ApplicationProfile | null;
  /** The signal that led to this resolution (for observability). */
  signal: ProfileResolutionSignal;
}

const NONE: ProfileResolutionResult = {
  profile: null,
  signal: { url: null, source: 'none' },
};

/**
 * Resolve the Application Profile for a test failure using the URL cascade.
 *
 * @param failureUrl The REAL page URL from the trace (via TraceParser); null if unavailable.
 * @param executionBaseUrl The execution's base URL (from config or env); null if unconfigured.
 * @param companyId The company owning the test project.
 * @param projectId The test project; used for the latest-active fallback.
 * @returns The resolved profile + the signal that led to it (for observability).
 */
export async function resolveProfileForHealing(
  failureUrl: string | null,
  executionBaseUrl: string | null,
  companyId: string,
  projectId: string,
): Promise<ProfileResolutionResult> {
  // De-dupe URL signals to avoid redundant DB lookups (e.g., if failureUrl === executionBaseUrl).
  const urlSignals: Array<{ url: string; source: 'failure_url' | 'execution_base_url' }> = [];
  const seen = new Set<string>();

  if (failureUrl) {
    urlSignals.push({ url: failureUrl, source: 'failure_url' });
    seen.add(failureUrl);
  }
  if (executionBaseUrl && !seen.has(executionBaseUrl)) {
    urlSignals.push({ url: executionBaseUrl, source: 'execution_base_url' });
    seen.add(executionBaseUrl);
  }

  // Convert to numbers for findProfileForUrl (which expects number | undefined).
  const companyIdNum = companyId ? Number(companyId) : undefined;
  const projectIdNum = projectId ? Number(projectId) : undefined;

  // 1. Try each URL signal in order (failure → execution base).
  for (const sig of urlSignals) {
    const profile = await findProfileForUrl(sig.url, companyIdNum, projectIdNum);
    if (profile) {
      return { profile, signal: { url: sig.url, source: sig.source } };
    }
  }

  // 2. LAST RESORT: latest active project profile (most-recently-crawled for this project).
  //    This is safe for single-app projects; explicit NONE for multi-app avoids guessing.
  const latestProfile = await getLatestActiveProjectProfile(companyId, projectId);
  if (latestProfile) {
    return {
      profile: latestProfile,
      signal: { url: latestProfile.base_url ?? null, source: 'project_latest_active' },
    };
  }

  // 3. No profile resolved at any level.
  return NONE;
}
