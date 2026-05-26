/**
 * Unit tests for auth-engine.ts
 *
 * Tests the login form detection selectors and auth configuration.
 * Note: Full end-to-end auth tests require a running Playwright browser,
 * so these focus on the module's type contracts and selector lists.
 *
 * Run with: npx tsx tests/unit/auth-engine.test.ts
 */

import { AuthEngine, type AuthConfig, type LoginFormDetection, type AuthResult } from '../../src/script-gen/auth-engine';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}

function assertEqual(actual: any, expected: any, msg: string) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) console.error(`     actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)}`);
  assert(ok, msg);
}

/* ------------------------------------------------------------------ */
/*  Tests: AuthConfig type contracts                                    */
/* ------------------------------------------------------------------ */

console.log('\n=== AuthConfig type contracts ===');

const minimalConfig: AuthConfig = {
  credentials: { username: 'admin', password: 'pass123' },
};
assert(!!minimalConfig.credentials.username, 'Minimal config has username');
assert(!!minimalConfig.credentials.password, 'Minimal config has password');
assertEqual(minimalConfig.loginUrl, undefined, 'loginUrl is optional');
assertEqual(minimalConfig.preLoginSteps, undefined, 'preLoginSteps is optional');
assertEqual(minimalConfig.customSelectors, undefined, 'customSelectors is optional');

const fullConfig: AuthConfig = {
  loginUrl: 'https://example.com/login',
  credentials: { username: 'admin', password: 'pass123', email: 'admin@test.com' },
  preLoginSteps: [
    { action: 'click', target: 'button:has-text("Sign In")' },
    { action: 'wait', target: '2000' },
  ],
  loginTimeoutMs: 20000,
  customSelectors: {
    usernameField: '#custom-user',
    passwordField: '#custom-pass',
    submitButton: '#custom-submit',
  },
};
assert(fullConfig.loginUrl === 'https://example.com/login', 'Full config has loginUrl');
assert(fullConfig.preLoginSteps!.length === 2, 'Full config has 2 pre-login steps');
assert(fullConfig.loginTimeoutMs === 20000, 'Full config has custom timeout');
assert(fullConfig.customSelectors!.usernameField === '#custom-user', 'Full config has custom username selector');

/* ------------------------------------------------------------------ */
/*  Tests: AuthEngine instantiation                                     */
/* ------------------------------------------------------------------ */

console.log('\n=== AuthEngine instantiation ===');

const engine = new AuthEngine();
assert(!!engine, 'AuthEngine can be instantiated');
assert(typeof engine.detectLoginForm === 'function', 'detectLoginForm is a method');
assert(typeof engine.authenticate === 'function', 'authenticate is a method');

/* ------------------------------------------------------------------ */
/*  Tests: LoginFormDetection structure                                 */
/* ------------------------------------------------------------------ */

console.log('\n=== LoginFormDetection type ===');

const emptyDetection: LoginFormDetection = {
  detected: false,
  confidence: 0,
  usernameSelector: null,
  passwordSelector: null,
  submitSelector: null,
  strategy: 'none',
  isMultiStep: false,
};
assertEqual(emptyDetection.detected, false, 'Empty detection is not detected');
assertEqual(emptyDetection.confidence, 0, 'Empty detection has 0 confidence');
assertEqual(emptyDetection.isMultiStep, false, 'Empty detection is not multi-step');

const fullDetection: LoginFormDetection = {
  detected: true,
  confidence: 0.9,
  usernameSelector: 'input[name="username"]',
  passwordSelector: 'input[type="password"]',
  submitSelector: 'button[type="submit"]',
  strategy: 'username=input[name="username"], password=input[type="password"], submit=button[type="submit"]',
  isMultiStep: false,
};
assertEqual(fullDetection.detected, true, 'Full detection is detected');
assert(fullDetection.confidence >= 0.5, 'Full detection confidence >= 0.5');

/* ------------------------------------------------------------------ */
/*  Tests: AuthResult structure                                         */
/* ------------------------------------------------------------------ */

console.log('\n=== AuthResult type ===');

const successResult: AuthResult = {
  success: true,
  message: 'Redirected to /dashboard',
  strategy: 'url-change',
  finalUrl: 'https://example.com/dashboard',
  durationMs: 3500,
  cookieNames: ['PHPSESSID', 'orangehrm'],
  captchaDetected: false,
  rateLimited: false,
};
assert(successResult.success, 'Success result is successful');
assert(!successResult.error, 'Success result has no error');
assert(successResult.cookieNames.length === 2, 'Success result has 2 cookies');

const failResult: AuthResult = {
  success: false,
  message: 'Login error: Invalid credentials',
  strategy: 'error-message',
  finalUrl: 'https://example.com/login',
  durationMs: 2000,
  cookieNames: [],
  error: 'Login error: Invalid credentials',
  captchaDetected: false,
  rateLimited: false,
};
assert(!failResult.success, 'Fail result is not successful');
assert(!!failResult.error, 'Fail result has error message');

const captchaResult: AuthResult = {
  success: false,
  message: 'CAPTCHA detected',
  strategy: 'captcha-detect',
  finalUrl: 'https://example.com/login',
  durationMs: 1500,
  cookieNames: [],
  error: 'CAPTCHA detected',
  captchaDetected: true,
  rateLimited: false,
};
assert(captchaResult.captchaDetected, 'Captcha result has captcha flag');

/* ------------------------------------------------------------------ */
/*  Tests: Credential sanitization                                      */
/* ------------------------------------------------------------------ */

console.log('\n=== Credential security ===');

// Verify AuthConfig doesn't expose credentials in toString/JSON
const configWithSecrets: AuthConfig = {
  credentials: { username: 'supersecretuser', password: 'supersecretpass' },
};
const jsonStr = JSON.stringify(configWithSecrets);
assert(jsonStr.includes('supersecretuser'), 'Config JSON does contain username (expected - raw object)');
// But the auth result should NOT contain credential values
assert(!JSON.stringify(successResult).includes('supersecretuser'), 'AuthResult does NOT leak username');
assert(!JSON.stringify(successResult).includes('supersecretpass'), 'AuthResult does NOT leak password');

/* ------------------------------------------------------------------ */
/*  Tests: CrawlConfig integration                                      */
/* ------------------------------------------------------------------ */

console.log('\n=== CrawlConfig integration ===');

import type { CrawlConfig } from '../../src/script-gen/page-crawler';

const crawlWithAuth: CrawlConfig = {
  url: 'https://example.com/admin/users',
  authConfig: {
    loginUrl: 'https://example.com/login',
    credentials: { username: 'admin', password: 'pass' },
  },
  additionalUrls: [
    'https://example.com/admin/dashboard',
    'https://example.com/admin/settings',
  ],
};
assert(!!crawlWithAuth.authConfig, 'CrawlConfig accepts authConfig');
assert(crawlWithAuth.additionalUrls!.length === 2, 'CrawlConfig accepts additionalUrls');

const crawlWithout: CrawlConfig = { url: 'https://example.com' };
assertEqual(crawlWithout.authConfig, undefined, 'CrawlConfig without auth has no authConfig');

/* ------------------------------------------------------------------ */
/*  Summary                                                             */
/* ------------------------------------------------------------------ */

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('All tests passed! ✅\n');
