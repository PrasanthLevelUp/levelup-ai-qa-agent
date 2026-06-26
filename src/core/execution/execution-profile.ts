/**
 * Execution Profile — domain model.
 *
 * Controls what artifacts are captured during a test execution. Tiered to
 * balance storage cost against diagnostic richness:
 *  - fast:     CI pipelines — metadata only (Tier 1)
 *  - standard: default — metadata + failure screenshots + DOM (Tier 1+2)
 *  - healing:  healing mode — standard + trace + video (Tier 1+2+3, used
 *              explicitly, never auto-upgraded)
 *  - debug:    investigation — everything (trace/video/HAR always on, Tier 4)
 *
 * Profiles are project-level *defaults* that may be overridden per execution
 * request (see execution-settings.ts → resolveExecutionProfile).
 */
export type ExecutionProfile = 'fast' | 'standard' | 'healing' | 'debug';

/** All valid profiles, handy for request validation at API boundaries. */
export const EXECUTION_PROFILES: ReadonlyArray<ExecutionProfile> = [
  'fast',
  'standard',
  'healing',
  'debug',
];

/** Type guard for a client-supplied profile string. */
export function isExecutionProfile(value: unknown): value is ExecutionProfile {
  return typeof value === 'string' && (EXECUTION_PROFILES as readonly string[]).includes(value);
}
