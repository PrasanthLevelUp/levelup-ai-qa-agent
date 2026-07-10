/**
 * Sprint 2D.2 — Execution Graph owns the Resolved Dataset
 *
 * Validates that Script Generation consumes `execution.resolvedDataset` from the
 * Execution Graph as the single canonical source for the VALID baseline
 * credential VALUES, instead of re-deriving them from step text / env vars.
 *
 * This sprint is strictly ADDITIVE: when no resolvedDataset is present (older
 * graphs / non-graph runs) the legacy record / env extraction still drives the
 * output. Two layers are proven here:
 *
 *   1. Unit — `resolveDatasetCredential` maps the resolved record's (opaque)
 *      field names onto canonical username / password values, with a defined
 *      priority order and a null fallback contract.
 *   2. Integration — through the PUBLIC generate() entry point: a login spec
 *      generated WITH a resolvedDataset emits the graph's credential values;
 *      the SAME case generated WITHOUT one falls back to the legacy chain
 *      (no regression, values NOT sourced from the graph).
 */

import { ScriptGenEngine } from '../../src/script-gen/script-gen-engine';

describe('Sprint 2D.2 — resolveDatasetCredential (field-name mapping)', () => {
  const engine = new ScriptGenEngine();
  const resolve = (values: any, kind: 'username' | 'password') =>
    (engine as any).resolveDatasetCredential(values, kind);

  it('maps canonical { username, password } fields directly', () => {
    const values = { username: 'graph_user', password: 'graph_pass' };
    expect(resolve(values, 'username')).toBe('graph_user');
    expect(resolve(values, 'password')).toBe('graph_pass');
  });

  it('recognises common alias field names (user / email / pwd)', () => {
    expect(resolve({ user: 'u1' }, 'username')).toBe('u1');
    expect(resolve({ email: 'e@x.io' }, 'username')).toBe('e@x.io');
    expect(resolve({ pwd: 'p1' }, 'password')).toBe('p1');
  });

  it('prefers the canonical key over aliases when both are present', () => {
    const values = { username: 'canonical', user: 'alias' };
    expect(resolve(values, 'username')).toBe('canonical');
  });

  it('returns null when the dataset is absent or the field is missing/empty', () => {
    expect(resolve(null, 'username')).toBeNull();
    expect(resolve(undefined, 'password')).toBeNull();
    expect(resolve({}, 'username')).toBeNull();
    expect(resolve({ username: '' }, 'username')).toBeNull(); // empty is not a usable value
    expect(resolve({ password: 'x' }, 'username')).toBeNull(); // no username field
  });
});

// ---------------------------------------------------------------------------
// Integration — through the public generate() entry point.
// ---------------------------------------------------------------------------

const mkMethod = (name: string, filePath: string): any => ({
  name, filePath, isExported: true, isAsync: true, parameters: [],
  returnType: 'Promise<void>', jsdoc: '', lineNumber: 1, category: 'page-object', complexity: 1,
});

const repoProfile: any = {
  framework: 'playwright', language: 'typescript', testPattern: 'pom',
  helperFunctions: [], fixtures: [], sharedConstants: [], dataFiles: [], dependencies: [],
  pageObjects: [
    { name: 'LoginPage', filePath: 'tests/pages/LoginPage.ts', isExported: true, baseClass: null,
      methods: [
        mkMethod('open', 'tests/pages/LoginPage.ts'),
        mkMethod('login', 'tests/pages/LoginPage.ts'),
        mkMethod('getError', 'tests/pages/LoginPage.ts'),
      ], properties: [] },
  ],
};

const cachedCrawlData: any = {
  url: 'https://www.saucedemo.com', finalUrl: 'https://www.saucedemo.com',
  title: 'Swag Labs', pageType: 'login', pageTypeConfidence: 0.9,
  elements: [
    { tag: 'input', id: 'user-name', name: 'user-name', type: 'text', attributes: { 'data-test': 'username' } },
    { tag: 'input', id: 'password', name: 'password', type: 'password', attributes: { 'data-test': 'password' } },
    { tag: 'input', id: 'login-button', type: 'submit', attributes: { 'data-test': 'login-button' } },
  ],
  forms: [], navigationLinks: [], buttons: [], inputs: [], headings: [],
  htmlSnapshot: '', totalElements: 3, interactiveElements: 3,
};

const mkTestCase = (): any => ({
  id: 5001, title: 'Valid credentials login', priority: 'P0', scenarioId: 'login-valid',
  preconditions: 'User is on the login page',
  expected_result: 'User is successfully authenticated and redirected to the products page.',
  steps: [
    'Navigate to https://www.saucedemo.com',
    'Enter a valid username',
    'Enter a valid password',
    'Click the login button',
  ],
});

// A positive scenario's semantics — no variation, all valid. The valid baseline
// VALUES are what 2D.2 sources from execution.resolvedDataset.
const positiveSemantics = {
  variableUnderTest: 'none',
  preconditions: 'valid username + valid password',
  variation: 'none',
  expectedBehavior: 'successfully authenticated and redirected',
  requiredDataRole: 'registered_user',
};

async function generateLoginSpec(withResolvedDataset: boolean): Promise<string> {
  const engine = new ScriptGenEngine();
  const tc = mkTestCase();
  const config: any = {
    url: 'https://www.saucedemo.com', cachedCrawlData, repoProfile, testCases: [tc],
  };
  if (withResolvedDataset) {
    config.scenarioGraphNodes = new Map<string, any>([
      ['login-valid', {
        semantics: positiveSemantics,
        execution: {
          resolvedDataset: {
            datasetId: 'ds-1', recordId: 'rec-1', reason: 'role-match',
            values: { username: 'graph_user', password: 'graph_pass' },
          },
        },
      }],
    ]);
  } else {
    // Graph carries the SAME semantics but NO execution/resolvedDataset, so the
    // valid baseline must come from the legacy chain (env / ctx.creds).
    config.scenarioGraphNodes = new Map<string, any>([
      ['login-valid', { semantics: positiveSemantics }],
    ]);
  }
  const result = await engine.generate(config);
  return result.generatedFiles.map((f: any) => f.content).join('\n\n');
}

describe('Sprint 2D.2 — generate() consumes execution.resolvedDataset', () => {
  it('emits the graph-resolved credential VALUES when resolvedDataset is present', async () => {
    const code = await generateLoginSpec(true);
    // The single high-level login() call carries the values owned by the graph.
    expect(code).toMatch(/\.login\('graph_user',\s*'graph_pass'\)/);
    // And it does NOT fall back to the env-var placeholders for the valid baseline.
    expect(code).not.toMatch(/process\.env\.TEST_USERNAME/);
    expect(code).not.toMatch(/process\.env\.TEST_PASSWORD/);
  });

  it('falls back to the legacy chain when no resolvedDataset is present (no regression)', async () => {
    const code = await generateLoginSpec(false);
    // A login() call is still emitted...
    expect(code).toMatch(/\.login\(/);
    // ...but the graph values are NOT used (they were never provided).
    expect(code).not.toMatch(/graph_user/);
    expect(code).not.toMatch(/graph_pass/);
  });
});
