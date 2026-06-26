import { classifyFailure } from '../../src/core/failure-classifier';
import type { FailureDetails, FailureType } from '../../src/core/failure-analyzer';

function makeFailure(overrides: Partial<FailureDetails> = {}): FailureDetails {
  return {
    testName: 'login test',
    failureType: 'locator' as FailureType,
    failedLocator: '',
    errorMessage: '',
    errorPattern: '',
    filePath: '/repo/tests/login.spec.ts',
    lineNumber: 42,
    failedLineCode: '',
    surroundingCode: '',
    screenshotPath: null,
    url: null,
    timestamp: new Date().toISOString(),
    isTimingIssue: false,
    ...overrides,
  };
}

describe('classifyFailure — locator', () => {
  it('diagnoses a real locator-not-found as a healable locator failure', () => {
    const d = classifyFailure({
      failure: makeFailure({
        failureType: 'locator',
        failedLocator: '#missing-thing',
        errorMessage: "locator('#missing-thing') not found",
        failedLineCode: "await page.locator('#missing-thing').click();",
      }),
    });
    expect(d.category).toBe('locator');
    expect(d.locator).toBe('#missing-thing');
    expect(d.healableByLocatorSwap).toBe(true);
    expect(d.action).toBe('click');
  });

  it('resolves a Page Object locator when the inline locator is empty (the false-positive case)', () => {
    const d = classifyFailure({
      failure: makeFailure({
        failureType: 'locator_timeout',
        failedLocator: '',
        errorMessage: "Timeout 30000ms exceeded waiting for locator('#login-button')",
        failedLineCode: 'await this.loginBtn.click();',
      }),
      pageObject: {
        resolvedLocator: '#login-button',
        fieldName: 'loginBtn',
        action: 'click',
        builder: 'locator',
      },
    });
    expect(d.category).toBe('locator');
    expect(d.locator).toBe('#login-button');
    expect(d.locatorResolvedFromPageObject).toBe(true);
    expect(d.healableByLocatorSwap).toBe(true);
    expect(d.evidence.some((e) => e.kind === 'resolved_locator')).toBe(true);
  });

  it('does NOT mark a locator-type failure healable when no locator can be resolved', () => {
    const d = classifyFailure({
      failure: makeFailure({
        failureType: 'locator',
        failedLocator: '',
        errorMessage: 'element not found',
        failedLineCode: 'await this.unknownField.click();',
      }),
    });
    expect(d.category).toBe('locator');
    expect(d.locator).toBeNull();
    expect(d.healableByLocatorSwap).toBe(false);
  });
});

describe('classifyFailure — assertion / timing / navigation', () => {
  it('diagnoses an assertion failure and marks it NOT healable by locator swap', () => {
    const d = classifyFailure({
      failure: makeFailure({
        failureType: 'assertion',
        errorMessage: 'Expected: "Welcome"\nReceived: "Error: locked out"',
        failedLineCode: 'await expect(page.locator(".title")).toHaveText("Welcome");',
      }),
    });
    expect(d.category).toBe('assertion');
    expect(d.healableByLocatorSwap).toBe(false);
    expect(d.expected).toContain('Welcome');
    expect(d.actual).toBeTruthy();
  });

  it('diagnoses a pure timeout as timing, not locator', () => {
    const d = classifyFailure({
      failure: makeFailure({
        failureType: 'timeout',
        errorMessage: 'Timeout 30000ms exceeded.',
      }),
    });
    expect(d.category).toBe('timing');
    expect(d.healableByLocatorSwap).toBe(false);
  });

  it('diagnoses a navigation failure', () => {
    const d = classifyFailure({
      failure: makeFailure({
        failureType: 'navigation',
        errorMessage: 'net::ERR_CONNECTION_REFUSED at https://app.example.com',
      }),
    });
    expect(d.category).toBe('navigation');
    expect(d.healableByLocatorSwap).toBe(false);
  });
});

describe('classifyFailure — refined categories (api / environment / framework)', () => {
  it('refines an unknown-typed failure with API signals into api', () => {
    const d = classifyFailure({
      failure: makeFailure({
        failureType: 'unknown',
        errorMessage: 'API request failed with response status 500',
      }),
    });
    expect(d.category).toBe('api');
    expect(d.healableByLocatorSwap).toBe(false);
  });

  it('refines an unknown-typed failure with environment signals into environment', () => {
    const d = classifyFailure({
      failure: makeFailure({
        failureType: 'unknown',
        errorMessage: 'Missing environment variable API_KEY; unauthorized 401',
      }),
    });
    expect(d.category).toBe('environment');
  });

  it('refines a timeout-typed failure with framework signals into framework', () => {
    const d = classifyFailure({
      failure: makeFailure({
        failureType: 'timeout',
        errorMessage: 'Target page, context or browser has been closed (protocol error)',
      }),
    });
    expect(d.category).toBe('framework');
  });

  it('leaves a truly unknown failure as unknown with low confidence', () => {
    const d = classifyFailure({
      failure: makeFailure({
        failureType: 'unknown',
        errorMessage: 'something weird happened',
      }),
    });
    expect(d.category).toBe('unknown');
    expect(d.confidence).toBeLessThan(0.5);
    expect(d.healableByLocatorSwap).toBe(false);
  });
});
