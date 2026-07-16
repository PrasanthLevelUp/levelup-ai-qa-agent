/**
 * Requirement Intelligence — rollout mode.
 *
 * A three-mode switch (NOT a boolean) that governs how the intelligence-driven
 * Script Generation path is rolled out, so we can prove it before it controls
 * anything users see:
 *
 *   legacy   — Old flow ONLY. Intelligence is not computed. Zero behavior change.
 *              This is the DEFAULT — production is unaffected until we opt in.
 *
 *   shadow   — Old flow still controls generation. Intelligence is ALSO computed
 *              and its decision + telemetry are logged, but it does NOT change
 *              what the user gets. This is the measurement window: skip rate,
 *              would-be token savings, decision distribution — all observed on
 *              real traffic with zero risk.
 *
 *   enabled  — Intelligence CONTROLS generation (SKIP / EXTEND / GENERATE).
 *
 * Rollout path: legacy → shadow (measure) → enabled (once the data shows the
 * intelligence path is consistently better). Kept as its own tiny module so the
 * route just asks "which mode?" and never parses env inline.
 */

export type RequirementIntelligenceMode = 'legacy' | 'shadow' | 'enabled';

/** The env var that selects the mode. */
export const REQUIREMENT_INTELLIGENCE_MODE_ENV = 'REQUIREMENT_INTELLIGENCE_MODE';

/** The safe default — production behavior is unchanged until explicitly opted in. */
export const DEFAULT_REQUIREMENT_INTELLIGENCE_MODE: RequirementIntelligenceMode = 'legacy';

const VALID_MODES: readonly RequirementIntelligenceMode[] = ['legacy', 'shadow', 'enabled'];

/**
 * Parse a raw mode string (typically from the environment) into a valid mode.
 * Unknown/empty values fall back to `legacy` (the safe default) so a typo can
 * never silently hand control to the new path. Case/whitespace insensitive.
 *
 * @param raw          The raw value (e.g. process.env.REQUIREMENT_INTELLIGENCE_MODE).
 * @param onInvalid    Optional sink for a warning when `raw` is non-empty but
 *                     not a valid mode (lets the caller log without this module
 *                     depending on a logger).
 */
export function parseRequirementIntelligenceMode(
  raw: string | undefined | null,
  onInvalid?: (message: string) => void,
): RequirementIntelligenceMode {
  if (raw == null) return DEFAULT_REQUIREMENT_INTELLIGENCE_MODE;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '') return DEFAULT_REQUIREMENT_INTELLIGENCE_MODE;
  if ((VALID_MODES as readonly string[]).includes(normalized)) {
    return normalized as RequirementIntelligenceMode;
  }
  onInvalid?.(
    `Unknown ${REQUIREMENT_INTELLIGENCE_MODE_ENV}="${raw}" — expected one of ` +
      `${VALID_MODES.join(' | ')}; falling back to "${DEFAULT_REQUIREMENT_INTELLIGENCE_MODE}".`,
  );
  return DEFAULT_REQUIREMENT_INTELLIGENCE_MODE;
}

/** Read the mode from the current environment. */
export function resolveRequirementIntelligenceMode(
  env: NodeJS.ProcessEnv = process.env,
  onInvalid?: (message: string) => void,
): RequirementIntelligenceMode {
  return parseRequirementIntelligenceMode(env[REQUIREMENT_INTELLIGENCE_MODE_ENV], onInvalid);
}

/** True when intelligence should be COMPUTED (shadow observes; enabled controls). */
export function isIntelligenceComputed(mode: RequirementIntelligenceMode): boolean {
  return mode === 'shadow' || mode === 'enabled';
}

/** True when intelligence should CONTROL generation (only in `enabled`). */
export function isIntelligenceControlling(mode: RequirementIntelligenceMode): boolean {
  return mode === 'enabled';
}
