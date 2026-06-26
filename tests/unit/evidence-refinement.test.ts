import {
  classifyFailure,
  refineDiagnosisWithEvidence,
} from '../../src/core/failure-classifier';
import type { FailureDetails } from '../../src/core/failure-analyzer';
import type { EvidenceBundle } from '../../src/core/evidence-collector';
import type { LocatorState } from '../../src/core/locator-state-analyzer';

function makeFailure(overrides: Partial<FailureDetails> = {}): FailureDetails {
  return {
    testName: 'login test',
    failureType: 'locator_timeout',
    failedLocator: '#login-button',
    errorMessage: 'Timeout 30000ms exceeded waiting for locator #login-button',
    errorPattern: 'timeout',
    isTimingIssue: true,
    filePath: '/repo/tests/login.spec.ts',
    lineNumber: 42,
    failedLineCode: 'await page.click("#login-button")',
    surroundingCode: '',
    screenshotPath: null,
    url: 'https://app.example.com/login',
    ...overrides,
  } as FailureDetails;
}

function locatorState(overrides: Partial<LocatorState> = {}): LocatorState {
  return {
    exists: true,
    visible: true,
    enabled: true,
    receivesPointerEvents: true,
    clickable: true,
    interceptedBy: null,
    source: 'dom_snapshot',
    notes: [],
    ...overrides,
  };
}

function bundle(overrides: Partial<EvidenceBundle> = {}): EvidenceBundle {
  return {
    locatorState: null,
    consoleErrors: [],
    networkErrors: [],
    artifacts: { screenshotPath: null, tracePath: null, videoPath: null, domSnapshotPresent: false },
    summary: [],
    ...overrides,
  };
}

describe('refineDiagnosisWithEvidence', () => {
  it('the canonical overlay case → timing / wait_for_overlay with high confidence', () => {
    const base = classifyFailure({ failure: makeFailure() });
    const refined = refineDiagnosisWithEvidence(
      base,
      bundle({
        locatorState: locatorState({
          receivesPointerEvents: false,
          clickable: false,
          interceptedBy: 'loading-overlay',
        }),
        summary: ['Locator state — exists:✔ visible:✔ enabled:✔ clickable:✖ (intercepted by loading-overlay)'],
      }),
    );
    expect(refined.category).toBe('timing');
    expect(refined.recommendedStrategy).toBe('wait_for_overlay');
    expect(refined.healableByLocatorSwap).toBe(false);
    expect(refined.confidence).toBeGreaterThanOrEqual(0.95);
    expect(refined.evidenceBased).toBe(true);
    expect(refined.rootCause).toMatch(/overlay|pointer/i);
  });

  it('element absent → locator / locator_swap', () => {
    const base = classifyFailure({ failure: makeFailure() });
    const refined = refineDiagnosisWithEvidence(
      base,
      bundle({ locatorState: locatorState({ exists: false, visible: false, enabled: false, clickable: false }) }),
    );
    expect(refined.category).toBe('locator');
    expect(refined.recommendedStrategy).toBe('locator_swap');
    expect(refined.evidenceBased).toBe(true);
  });

  it('element exists but not visible → wait_for_visible', () => {
    const base = classifyFailure({ failure: makeFailure() });
    const refined = refineDiagnosisWithEvidence(
      base,
      bundle({ locatorState: locatorState({ visible: false, clickable: false }) }),
    );
    expect(refined.category).toBe('timing');
    expect(refined.recommendedStrategy).toBe('wait_for_visible');
    expect(refined.healableByLocatorSwap).toBe(false);
  });

  it('element visible but disabled → wait_for_enabled', () => {
    const base = classifyFailure({ failure: makeFailure() });
    const refined = refineDiagnosisWithEvidence(
      base,
      bundle({ locatorState: locatorState({ enabled: false, clickable: false }) }),
    );
    expect(refined.recommendedStrategy).toBe('wait_for_enabled');
  });

  it('network errors re-categorise an ambiguous diagnosis to api', () => {
    const base = classifyFailure({ failure: makeFailure({ failureType: 'unknown', errorMessage: 'net::ERR_CONNECTION_REFUSED' }) });
    const refined = refineDiagnosisWithEvidence(
      base,
      bundle({ networkErrors: [{ detail: 'net::ERR_CONNECTION_REFUSED' }] }),
    );
    expect(refined.category).toBe('api');
    expect(refined.recommendedStrategy).toBe('report_only');
    expect(refined.healableByLocatorSwap).toBe(false);
  });

  it('element fully interactable yet test failed → assertion (not a broken locator)', () => {
    const base = classifyFailure({ failure: makeFailure() });
    // base.category is 'locator'; clickable element flips it to assertion.
    const refined = refineDiagnosisWithEvidence(base, bundle({ locatorState: locatorState() }));
    expect(refined.category).toBe('assertion');
    expect(refined.healableByLocatorSwap).toBe(false);
    expect(refined.recommendedStrategy).toBe('report_only');
  });

  it('does not mutate the input diagnosis', () => {
    const base = classifyFailure({ failure: makeFailure() });
    const before = JSON.stringify(base);
    refineDiagnosisWithEvidence(base, bundle({ locatorState: locatorState({ exists: false }) }));
    expect(JSON.stringify(base)).toBe(before);
  });

  it('with no evidence (source unknown) leaves the parser-based diagnosis essentially intact', () => {
    const base = classifyFailure({ failure: makeFailure() });
    const refined = refineDiagnosisWithEvidence(base, bundle({ locatorState: locatorState({ source: 'unknown' }) }));
    expect(refined.category).toBe(base.category);
    expect(refined.evidenceBased).toBe(false);
  });
});
