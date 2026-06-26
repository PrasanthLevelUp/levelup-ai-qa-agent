/**
 * Execution Settings — domain model + resolution logic.
 *
 * Separate from healing settings because execution is used by many consumers:
 * script validation, healing, regression, smoke, nightly, GitHub Actions, etc.
 *
 * These are *project-level DEFAULTS*. The same project frequently runs under
 * different profiles (CI smoke wants `fast`, an investigation wants `debug`),
 * so every execution request MAY override them. Use the resolve* helpers to
 * compute the effective values for a given request rather than reading the
 * settings directly.
 *
 * Persistence of these settings lives in src/db/postgres.ts
 * (get/upsertExecutionSettings). This module owns only the business model.
 */
import type { ExecutionProfile } from './execution-profile';

export interface ExecutionSettings {
  /**
   * Default execution profile — controls baseline artifact collection when a
   * request does not specify its own. Authorization layer should enforce which
   * profiles are available per plan.
   */
  executionProfile: ExecutionProfile;
  /**
   * Explicit opt-in for additional artifacts during healing attempts.
   * When true, healing runs collect trace/video/HAR (regardless of profile).
   * When false, only the base profile artifacts are collected.
   * Makes artifact collection behavior explicit and visible to users.
   */
  collectHealingArtifacts: boolean;
}

export const DEFAULT_EXECUTION_SETTINGS: ExecutionSettings = {
  executionProfile: 'standard', // Safe default: screenshots + DOM on failure
  collectHealingArtifacts: true, // Default: collect additional diagnostics during healing
};

/**
 * Resolve the effective execution profile for a single execution request.
 *
 * Precedence (highest wins):
 *   1. requested      — the profile attached to this specific execution request
 *   2. projectDefault — the project-level ExecutionSettings default
 *   3. system default ('standard')
 */
export function resolveExecutionProfile(
  requested?: ExecutionProfile | null,
  projectDefault?: ExecutionProfile | null
): ExecutionProfile {
  return requested || projectDefault || DEFAULT_EXECUTION_SETTINGS.executionProfile;
}

/**
 * Resolve the effective "collect healing artifacts" flag for a single request.
 * Same precedence model as the profile: an explicit per-request value wins over
 * the project default, which wins over the system default.
 */
export function resolveCollectHealingArtifacts(
  requested?: boolean | null,
  projectDefault?: boolean | null
): boolean {
  if (typeof requested === 'boolean') return requested;
  if (typeof projectDefault === 'boolean') return projectDefault;
  return DEFAULT_EXECUTION_SETTINGS.collectHealingArtifacts;
}
