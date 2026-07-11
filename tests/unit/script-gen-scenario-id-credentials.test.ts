/**
 * Sprint 3.6 · Business Correctness — scenarioId drives the credential COMBO
 * ============================================================================
 *
 * THE DEFECT:
 * The emitter picked the auth credential combination from fuzzy title/keyword
 * matching. A "wrong password" case, an "unknown user" case and a "locked
 * account" case all look similar in prose, so the wrong combo leaked into the
 * generated `login(...)` (e.g. an unknown-user test emitting a valid user +
 * wrong password).
 *
 * THE FIX (this sprint):
 * When the case carries a stable KB `scenarioId` we recognise, select the combo
 * DIRECTLY from that id — deterministic, no keyword guessing, no new inference.
 * The KB-resolved dataset (execution.resolvedDataset) supplies the actual
 * values; the emitter only decides WHICH field to keep valid vs. mutate:
 *   auth-neg-wrong-password → registered user + deliberately wrong password
 *   auth-neg-unknown-user   → the unregistered user (verbatim from the dataset)
 *   auth-sec-locked-account → the locked user (verbatim from the dataset)
 *
 * These tests exercise the page-object login path (loginPage.login(u, p)),
 * which is the single point where the credential combination is emitted.
 */

import { ScriptGenEngine } from '../../src/script-gen/script-gen-engine';
import type { GenerationConfig } from '../../src/script-gen/script-gen-engine';

describe('Sprint 3.6 — scenarioId selects the credential combination', () => {
  const mockCrawl = JSON.stringify({
    url: 'https://www.saucedemo.com',
    title: 'Swag Labs',
    domSnapshot: '<html></html>',
    controls: [
      { id: 'user-name', type: 'input', label: 'Username', role: 'textbox' },
      { id: 'password', type: 'input', label: 'Password', role: 'textbox' },
      { id: 'login-button', type: 'button', label: 'Login', role: 'button' },
    ],
  });

  // Minimal repo profile carrying a LoginPage.login(username, password) so the
  // emitter takes the page-object login path (where the combo is emitted).
  const repoProfile = {
    framework: 'playwright',
    language: 'typescript',
    testPattern: 'page-object-model',
    locatorStrategy: 'data-testid',
    folderStructure: {
      testDir: 'tests', pageObjectDir: 'tests/pages', fixtureDir: 'tests/fixtures',
      helperDir: 'tests/helpers', utilityDir: 'tests/utils', dataDir: 'tests/data',
    },
    totalFiles: 10, totalTestFiles: 5, totalHelperFiles: 1, totalLineCount: 500,
    codingStyle: {
      indent: 2, quotes: 'single', semi: true, trailingComma: 'all',
      asyncStyle: 'async-await', namingConvention: 'camelCase',
    },
    pageObjects: [
      {
        name: 'LoginPage', filePath: 'tests/pages/LoginPage.ts', isExported: true,
        baseClass: 'BasePage',
        methods: [
          {
            name: 'login', filePath: 'tests/pages/LoginPage.ts', isExported: false,
            isAsync: true,
            parameters: [{ name: 'username', type: 'string' }, { name: 'password', type: 'string' }],
            returnType: 'Promise<void>', jsdoc: 'Logs in', lineNumber: 10,
            category: 'page-object', complexity: 3,
          },
          {
            name: 'open', filePath: 'tests/pages/LoginPage.ts', isExported: false,
            isAsync: true, parameters: [], returnType: 'Promise<void>',
            jsdoc: 'Opens login page', lineNumber: 5, category: 'page-object', complexity: 1,
          },
        ],
        properties: [
          { name: 'usernameInput', type: 'Locator', isReadonly: true, selector: '#user-name', locatorType: 'locator' },
          { name: 'passwordInput', type: 'Locator', isReadonly: true, selector: '#password', locatorType: 'locator' },
          { name: 'loginButton', type: 'Locator', isReadonly: true, selector: '#login-button', locatorType: 'locator' },
        ],
        category: 'page-object', lineNumber: 1,
      },
    ],
    helperFunctions: [], fixtures: [], customCommands: [], sharedConstants: [],
    dataFiles: [],
    environment: { envFiles: ['.env'], usesDotenv: true, configModule: 'tests/config/env.ts', envVars: ['TEST_USERNAME', 'TEST_PASSWORD'] },
    businessFlows: [], testSuites: [],
    preferredLocators: [{ pattern: 'data-testid', count: 10, example: '[data-testid="login-button"]' }],
    avoidPatterns: [], dependencies: [{ name: '@playwright/test', version: '1.40.0', isDev: true }],
    assertionLibrary: '@playwright/test', hasApiLayer: false, hasCustomFixtures: false,
    hasMocking: false, hasVisualTesting: false, ciIntegration: 'github-actions',
  } as any;

  const loginSteps = [
    'Navigate to https://www.saucedemo.com',
    'Enter username',
    'Enter password',
    'Click Login',
  ];

  // Build a config for a single auth case identified purely by scenarioId, with
  // the KB-resolved dataset values the resolver's base() will bind.
  function configFor(scenarioId: string, values: { username: string; password: string }): GenerationConfig {
    return {
      url: 'https://www.saucedemo.com',
      cachedCrawlData: mockCrawl,
      repoProfile,
      testCases: [{
        title: 'Login attempt', // deliberately generic — the id must drive the combo
        scenarioId,
        steps: loginSteps,
        expected_result: 'The login outcome matches the scenario',
        test_data: '',
      }],
      scenarioGraphNodes: new Map([
        [scenarioId, {
          id: scenarioId,
          semantics: {
            variableUnderTest: 'user_credentials',
            preconditions: 'Valid login page',
            variation: scenarioId,
            expectedBehavior: 'Login outcome per scenario',
          },
          execution: {
            resolvedDataset: {
              datasetId: 'auth_dataset',
              recordId: values.username,
              values,
              reason: `scenarioId ${scenarioId} → dataset record`,
            },
          },
        }],
      ]),
    } as any;
  }

  function loginArgs(spec: string): string {
    const m = spec.match(/loginPage\.login\(([^)]*)\)/);
    return m ? m[1] : '';
  }

  test('auth-neg-wrong-password → registered username kept valid, password deliberately wrong', async () => {
    const engine = new ScriptGenEngine();
    const result = await engine.generate(
      configFor('auth-neg-wrong-password', { username: 'standard_user', password: 'secret_sauce' }),
    );
    const spec = result.generatedFiles.find((f: any) => f.path.endsWith('.spec.ts'))!.content as string;
    const args = loginArgs(spec);
    expect(args).toContain("'standard_user'");       // registered user stays valid
    expect(args).toContain("'wrong_password'");        // password is the deliberate mutation
    expect(args).not.toContain("'secret_sauce'");      // the real password must NOT be used
  });

  test('auth-neg-unknown-user → uses the unregistered user verbatim (no mutation)', async () => {
    const engine = new ScriptGenEngine();
    const result = await engine.generate(
      configFor('auth-neg-unknown-user', { username: 'ghost_user', password: 'ghost_pass' }),
    );
    const spec = result.generatedFiles.find((f: any) => f.path.endsWith('.spec.ts'))!.content as string;
    const args = loginArgs(spec);
    expect(args).toContain("'ghost_user'");
    expect(args).toContain("'ghost_pass'");
    expect(args).not.toContain("'wrong_password'");    // never mutate an unknown-user case
  });

  test('auth-sec-locked-account → uses the locked user verbatim (no mutation)', async () => {
    const engine = new ScriptGenEngine();
    const result = await engine.generate(
      configFor('auth-sec-locked-account', { username: 'locked_out_user', password: 'secret_sauce' }),
    );
    const spec = result.generatedFiles.find((f: any) => f.path.endsWith('.spec.ts'))!.content as string;
    const args = loginArgs(spec);
    expect(args).toContain("'locked_out_user'");
    expect(args).toContain("'secret_sauce'");
    expect(args).not.toContain("'wrong_password'");    // locked account is NOT a wrong-password case
  });

  test('unrecognised scenarioId → falls through to existing path unchanged (no throw, valid login emitted)', async () => {
    const engine = new ScriptGenEngine();
    const result = await engine.generate(
      configFor('auth-pos-valid-login', { username: 'standard_user', password: 'secret_sauce' }),
    );
    const spec = result.generatedFiles.find((f: any) => f.path.endsWith('.spec.ts'))!.content as string;
    // The credential-combo override returns null for this id, so the existing
    // semantics path runs and still emits a coherent login (regression guard).
    expect(spec).toMatch(/loginPage\.login\(/);
  });
});
