import {
  EvidenceCollector,
  extractNetworkErrors,
  extractConsoleErrors,
} from '../../src/core/evidence-collector';
import type { FailureDetails } from '../../src/core/failure-analyzer';

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
    screenshotPath: '/artifacts/login.png',
    url: 'https://app.example.com/login',
    ...overrides,
  } as FailureDetails;
}

describe('extractNetworkErrors', () => {
  it('extracts net::ERR_ codes', () => {
    const out = extractNetworkErrors('Failed: net::ERR_CONNECTION_REFUSED at https://x');
    expect(out.some((e) => e.detail === 'net::ERR_CONNECTION_REFUSED')).toBe(true);
  });

  it('extracts HTTP 5xx status', () => {
    const out = extractNetworkErrors('Request failed with status code 500');
    expect(out.some((e) => e.status === 500 && e.detail === 'HTTP 500')).toBe(true);
  });

  it('extracts ECONNREFUSED', () => {
    const out = extractNetworkErrors('connect ECONNREFUSED 127.0.0.1:8080');
    expect(out.some((e) => /ECONNREFUSED/.test(e.detail))).toBe(true);
  });

  it('returns empty for clean text', () => {
    expect(extractNetworkErrors('all good')).toEqual([]);
  });
});

describe('extractConsoleErrors', () => {
  it('extracts an Uncaught TypeError', () => {
    const out = extractConsoleErrors("Uncaught TypeError: Cannot read properties of undefined");
    expect(out.length).toBeGreaterThan(0);
  });

  it('returns empty for clean text', () => {
    expect(extractConsoleErrors('nothing to see')).toEqual([]);
  });
});

describe('EvidenceCollector.collect', () => {
  it('produces hard locator-state facts from a DOM snapshot (overlay case)', async () => {
    const failure = makeFailure();
    const domSnapshot = `
      <button id="login-button">Login</button>
      <div class="loading-overlay">Loading…</div>`;
    const bundle = await new EvidenceCollector().collect({ failure, domSnapshot });
    expect(bundle.locatorState).not.toBeNull();
    expect(bundle.locatorState!.exists).toBe(true);
    expect(bundle.locatorState!.clickable).toBe(false);
    expect(bundle.locatorState!.interceptedBy).toMatch(/overlay/i);
    expect(bundle.summary.join(' ')).toMatch(/Locator state/);
  });

  it('degrades gracefully with no DOM snapshot', async () => {
    const failure = makeFailure();
    const bundle = await new EvidenceCollector().collect({ failure, domSnapshot: null });
    expect(bundle.locatorState?.source).toBe('unknown');
    expect(bundle.artifacts.domSnapshotPresent).toBe(false);
  });

  it('records artifact paths for Failure Replay', async () => {
    const failure = makeFailure();
    const bundle = await new EvidenceCollector().collect({
      failure,
      domSnapshot: null,
      tracePath: '/artifacts/trace.zip',
      videoPath: '/artifacts/video.webm',
    });
    expect(bundle.artifacts.screenshotPath).toBe('/artifacts/login.png');
    expect(bundle.artifacts.tracePath).toBe('/artifacts/trace.zip');
    expect(bundle.artifacts.videoPath).toBe('/artifacts/video.webm');
  });

  it('surfaces network failures from the error message', async () => {
    const failure = makeFailure({
      errorMessage: 'page.goto failed: net::ERR_NAME_NOT_RESOLVED',
    });
    const bundle = await new EvidenceCollector().collect({ failure, domSnapshot: null });
    expect(bundle.networkErrors.length).toBeGreaterThan(0);
  });

  it('prefers a live locator probe when provided', async () => {
    const failure = makeFailure();
    const bundle = await new EvidenceCollector().collect({
      failure,
      domSnapshot: '<button id="login-button">Login</button>',
      locatorProbe: {
        probe: () => ({
          exists: true,
          visible: true,
          enabled: true,
          receivesPointerEvents: false,
          clickable: false,
          interceptedBy: 'live overlay',
          source: 'live_probe',
          notes: [],
        }),
      },
    });
    expect(bundle.locatorState!.source).toBe('live_probe');
    expect(bundle.locatorState!.interceptedBy).toBe('live overlay');
  });
});
