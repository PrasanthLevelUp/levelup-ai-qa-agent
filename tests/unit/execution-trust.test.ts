/**
 * Unit tests for the Execution Trust Assessment (the INCONCLUSIVE primitive).
 *
 * These lock in the central principle of the refactor:
 *
 *   "Absence of a passing result is NOT the same as a failing test."
 *
 * A run is only trustworthy when it either exits cleanly (everything passed) or
 * produces at least one parseable failure artifact (a real, evidence-backed
 * failure). Everything else — crashes, timeouts-without-evidence, missing
 * binaries, missing results files, spec-load errors — must be reported as
 * INCONCLUSIVE, never as `framework` / `fail` / "unhealable locator".
 */

import { assessRunTrust, type RunTrustInput } from '../../src/core/execution-trust';

/** Convenience builder so each test only states the fields it cares about. */
function input(overrides: Partial<RunTrustInput>): RunTrustInput {
  return {
    exitCode: 0,
    hasFailureArtifacts: false,
    resultsFileExists: true,
    loadErrorCount: 0,
    ...overrides,
  };
}

describe('assessRunTrust', () => {
  it('trusts a run with a real failure artifact (even on a non-zero exit)', () => {
    const result = assessRunTrust(input({ exitCode: 1, hasFailureArtifacts: true }));
    expect(result.trustworthy).toBe(true);
    expect(result.signal).toBe('ok');
    expect(result.inconclusive).toBe(false);
  });

  it('trusts a clean exit (0) with no failure artifacts (everything passed)', () => {
    const result = assessRunTrust(input({ exitCode: 0, hasFailureArtifacts: false }));
    expect(result.trustworthy).toBe(true);
    expect(result.signal).toBe('ok');
    expect(result.inconclusive).toBe(false);
  });

  it('prefers the failure-artifact signal over the exit code (artifact + exit 0)', () => {
    // A weird-but-possible combination: artifacts present, exit 0. The presence
    // of a real artifact should still make it trustworthy.
    const result = assessRunTrust(input({ exitCode: 0, hasFailureArtifacts: true }));
    expect(result.trustworthy).toBe(true);
    expect(result.signal).toBe('ok');
  });

  it('marks exit 127 (command not found) as INCONCLUSIVE', () => {
    const result = assessRunTrust(input({ exitCode: 127, hasFailureArtifacts: false }));
    expect(result.trustworthy).toBe(false);
    expect(result.signal).toBe('command_not_found');
    expect(result.inconclusive).toBe(true);
  });

  it('marks exit 124 (timeout, no evidence) as INCONCLUSIVE', () => {
    const result = assessRunTrust(input({ exitCode: 124, hasFailureArtifacts: false }));
    expect(result.trustworthy).toBe(false);
    expect(result.signal).toBe('timeout_no_evidence');
    expect(result.inconclusive).toBe(true);
  });

  it('marks a spec-load / global-setup error as INCONCLUSIVE', () => {
    const result = assessRunTrust(
      input({ exitCode: 1, hasFailureArtifacts: false, loadErrorCount: 2 }),
    );
    expect(result.trustworthy).toBe(false);
    expect(result.signal).toBe('spec_load_error');
    expect(result.inconclusive).toBe(true);
  });

  it('marks a missing results file as INCONCLUSIVE', () => {
    const result = assessRunTrust(
      input({ exitCode: 1, hasFailureArtifacts: false, resultsFileExists: false }),
    );
    expect(result.trustworthy).toBe(false);
    expect(result.signal).toBe('no_results_file');
    expect(result.inconclusive).toBe(true);
  });

  it('marks a non-zero exit with a results file but no artifacts as crashed_before_tests', () => {
    const result = assessRunTrust(
      input({ exitCode: 1, hasFailureArtifacts: false, resultsFileExists: true }),
    );
    expect(result.trustworthy).toBe(false);
    expect(result.signal).toBe('crashed_before_tests');
    expect(result.inconclusive).toBe(true);
  });

  it('prioritises spec-load errors over the generic missing-results signal', () => {
    // Both loadErrorCount>0 and resultsFileExists=false: the more specific
    // spec_load_error signal should win because it explains the root cause.
    const result = assessRunTrust(
      input({
        exitCode: 1,
        hasFailureArtifacts: false,
        resultsFileExists: false,
        loadErrorCount: 1,
      }),
    );
    expect(result.signal).toBe('spec_load_error');
  });

  it('always provides a human-readable reason', () => {
    for (const exitCode of [0, 1, 124, 127]) {
      const result = assessRunTrust(input({ exitCode }));
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});
