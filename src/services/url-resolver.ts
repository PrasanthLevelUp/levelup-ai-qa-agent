/**
 * URL Resolution Service (Sprint 4B — Script Gen UX Improvements)
 * ================================================================================
 *
 * PURPOSE
 * -------
 * The Target URL for script generation is, in practice, already known to the
 * system: it lives on the active *environment* (Sprint 4A) or, failing that, on
 * the *project context*. Forcing the user to retype it is redundant and error
 * prone. This service centralises the resolution so both the API
 * (`POST /api/scripts/generate`) and any future caller share one source of truth.
 *
 * RESOLUTION PRIORITY (spec §5.3)
 * -------------------------------
 *   1. Selected environment's base_url      (project_environments.base_url)
 *   2. Project's default environment base_url
 *   3. Project context app_url               (project_contexts.app_url — fallback)
 *
 * An explicit, user-supplied URL ALWAYS wins and is never overridden here — the
 * caller should only invoke this resolver when the user left the field blank.
 *
 * SAFETY GUARANTEES
 * -----------------
 * • Best-effort & non-throwing — every DB lookup is guarded; on any error the
 *   resolver simply falls through to the next source and ultimately returns an
 *   empty string. It must never block script generation.
 * • Additive — it only *reads*; it changes no state.
 */

import {
  getEnvironment,
  getDefaultEnvironment,
  getProjectContextAppUrl,
} from '../db/postgres';

export interface ResolveBaseUrlParams {
  /** Project the generation runs under (required for any environment lookup). */
  projectId?: number | null;
  /** Specific environment selected in the workspace context (optional). */
  environmentId?: number | null;
  /** Company scope — used for the project-context fallback. */
  companyId?: number | null;
}

export type UrlResolutionSource = 'environment' | 'default-environment' | 'project-context' | 'none';

export interface ResolvedBaseUrl {
  /** The resolved base URL, or '' when nothing could be determined. */
  url: string;
  /** Which source the URL came from (useful for logging / UX hints). */
  source: UrlResolutionSource;
  /** Human-friendly label of the source (e.g. environment name). */
  label: string | null;
}

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Resolve the base URL for script generation following the spec priority chain.
 * Never throws — returns `{ url: '', source: 'none', label: null }` if unresolved.
 */
export async function resolveBaseUrl(params: ResolveBaseUrlParams): Promise<ResolvedBaseUrl> {
  const projectId = params.projectId != null ? Number(params.projectId) : null;
  const environmentId = params.environmentId != null ? Number(params.environmentId) : null;
  const companyId = params.companyId != null ? Number(params.companyId) : null;

  // 1 & 2 — environment base_url (selected env first, else the default env).
  if (projectId != null && !Number.isNaN(projectId)) {
    // 1. Explicitly selected environment.
    if (environmentId != null && !Number.isNaN(environmentId)) {
      try {
        const env = await getEnvironment(environmentId, projectId);
        const url = clean(env?.base_url);
        if (url) return { url, source: 'environment', label: env?.name ?? null };
      } catch { /* fall through */ }
    }

    // 2. Project's default environment.
    try {
      const env = await getDefaultEnvironment(projectId);
      const url = clean(env?.base_url);
      if (url) return { url, source: 'default-environment', label: env?.name ?? null };
    } catch { /* fall through */ }
  }

  // 3. Project context app_url (fallback).
  try {
    const appUrl = await getProjectContextAppUrl(projectId, companyId);
    const url = clean(appUrl);
    if (url) return { url, source: 'project-context', label: 'project context' };
  } catch { /* fall through */ }

  return { url: '', source: 'none', label: null };
}
