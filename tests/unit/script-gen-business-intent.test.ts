/**
 * Sprint 3 · PR 3.2 — Business Intent Correctness
 * ============================================================================
 *
 * THE DEFECT:
 * A "Locked User" scenario incorrectly binds to `invalid_users` dataset instead
 * of `locked_users`. The generator produces code that performs the WRONG
 * business scenario — `getRecord("invalid_users")` inside a locked-account test.
 *
 * THE ROOT CAUSE:
 * Script Gen was ignoring the Scenario Graph's already-resolved dataset
 * (`execution.resolvedDataset`) and re-inferring from text, picking the wrong
 * dataset bucket when multiple negative datasets exist.
 *
 * THE FIX:
 * 1. When the graph has already resolved a dataset record, REUSE it directly.
 * 2. When the graph didn't resolve (thin fixtures), use `semantics.requiredDataRole`
 *    to filter candidate datasets before text matching.
 * 3. Legacy text-matching heuristic operates within the filtered candidates.
 *
 * EXPECTED OUTCOME:
 * - "Locked User" scenario → `getRecord("locked_users")` (correct dataset!)
 * - "Valid Credentials" → `getRecord("valid_users")` (representative)
 * - No more silent fallback to wrong business intent
 */

import { ScriptGenEngine } from '../../src/script-gen/script-gen-engine';
import type { GenerationConfig } from '../../src/script-gen/script-gen-engine';

describe('Sprint 3.2 — Business Intent Correctness', () => {
  // ── Test fixtures ──────────────────────────────────────────────────────
  const mockResolvedTestData = [
    {
      name: 'valid_users',
      records: [
        { key: 'standard_user', value: { username: 'standard_user', password: 'secret_sauce' } },
      ],
    },
    {
      name: 'locked_users',
      records: [
        { key: 'locked_out_user', value: { username: 'locked_out_user', password: 'secret_sauce' } },
      ],
    },
    {
      name: 'invalid_users',
      records: [
        { key: 'invalid_user', value: { username: 'invalid_user', password: 'wrong_password' } },
      ],
    },
  ];

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

  // ── Core fix: graph-resolved dataset is used directly ─────────────────
  test('locked user scenario uses graph-resolved locked_users dataset (not invalid_users)', async () => {
    const engine = new ScriptGenEngine();
    const config: GenerationConfig = {
      url: 'https://www.saucedemo.com',
      cachedCrawlData: mockCrawl,
      testCases: [{
        title: 'Login - Locked User',
        steps: [
          'Navigate to https://www.saucedemo.com',
          'Enter username',
          'Enter password',
          'Click Login',
        ],
        expected_result: 'Error message: "Epic sadface: Sorry, this user has been locked out."',
        test_data: '',
      }],
      resolvedTestData: mockResolvedTestData,
      scenarioGraphNodes: new Map([
        [
          'Login - Locked User',
          {
            semantics: {
              variableUnderTest: 'user_credentials',
              preconditions: 'Valid login page',
              variation: 'Locked account',
              expectedBehavior: 'Login rejected with locked-account message',
              requiredDataRole: 'locked_user',
            },
            execution: {
              resolvedDataset: {
                datasetId: 'locked_users',
                recordId: 'locked_out_user',
                values: { username: 'locked_out_user', password: 'secret_sauce' },
                reason: 'Role "locked_user" → dataset "locked_users" → record "locked_out_user"',
              },
            },
          },
        ],
      ]),
    } as any;

    const result = await engine.generate(config);
    const spec = result.generatedFiles.find((f: any) => f.path.endsWith('.spec.ts'));
    expect(spec).toBeDefined();

    // ✅ THE FIX: must bind to locked_users (the graph-resolved CORRECT dataset)
    expect(spec!.content).toContain(`getRecord("locked_users")`);
    // ❌ MUST NOT fall back to invalid_users (the wrong dataset)
    expect(spec!.content).not.toContain(`getRecord("invalid_users"`);
  });

  test('valid credentials scenario uses graph-resolved valid_users dataset', async () => {
    const engine = new ScriptGenEngine();
    const config: GenerationConfig = {
      url: 'https://www.saucedemo.com',
      cachedCrawlData: mockCrawl,
      testCases: [{
        title: 'Login - Valid Credentials',
        steps: [
          'Navigate to https://www.saucedemo.com',
          'Enter username',
          'Enter password',
          'Click Login',
        ],
        expected_result: 'User is logged in and redirected to inventory page',
        test_data: '',
      }],
      resolvedTestData: mockResolvedTestData,
      scenarioGraphNodes: new Map([
        [
          'Login - Valid Credentials',
          {
            semantics: {
              variableUnderTest: 'user_credentials',
              preconditions: 'Valid login page',
              variation: 'Valid registered user',
              expectedBehavior: 'Login succeeds',
              requiredDataRole: 'registered_user',
            },
            execution: {
              resolvedDataset: {
                datasetId: 'valid_users',
                recordId: 'standard_user',
                values: { username: 'standard_user', password: 'secret_sauce' },
                reason: 'Role "registered_user" → dataset "valid_users" → record "standard_user"',
              },
            },
          },
        ],
      ]),
    } as any;

    const result = await engine.generate(config);
    const spec = result.generatedFiles.find((f: any) => f.path.endsWith('.spec.ts'));
    expect(spec).toBeDefined();

    // ✅ Must bind to valid_users (representative record, no selector)
    expect(spec!.content).toContain(`getRecord("valid_users")`);
    // ❌ MUST NOT bind to locked_users or invalid_users
    expect(spec!.content).not.toContain(`getRecord("locked_users"`);
    expect(spec!.content).not.toContain(`getRecord("invalid_users"`);
  });

  // ── Semantic filtering: requiredDataRole guides dataset selection ─────
  test('requiredDataRole filters datasets when graph has no resolved record (thin fixtures)', async () => {
    const engine = new ScriptGenEngine();
    const config: GenerationConfig = {
      url: 'https://www.saucedemo.com',
      cachedCrawlData: mockCrawl,
      testCases: [{
        title: 'Login - Locked User',
        steps: [
          'Navigate to https://www.saucedemo.com',
          'Enter locked user credentials',
          'Click Login',
        ],
        expected_result: 'Error message about locked account',
        test_data: '',
      }],
      resolvedTestData: mockResolvedTestData,
      scenarioGraphNodes: new Map([
        [
          'Login - Locked User',
          {
            semantics: {
              variableUnderTest: 'user_credentials',
              preconditions: 'Valid login page',
              variation: 'Locked account',
              expectedBehavior: 'Login rejected with locked-account message',
              requiredDataRole: 'locked_user',
            },
            // No execution.resolvedDataset (thin fixture)
          },
        ],
      ]),
    } as any;

    const result = await engine.generate(config);
    const spec = result.generatedFiles.find((f: any) => f.path.endsWith('.spec.ts'));
    expect(spec).toBeDefined();

    // ✅ Even without a graph-resolved record, requiredDataRole="locked_user"
    //    should filter candidates to locked_users dataset
    expect(spec!.content).toContain(`getRecord("locked_users"`);
    // ❌ MUST NOT silently fall back to invalid_users or valid_users
    expect(spec!.content).not.toContain(`getRecord("invalid_users"`);
    expect(spec!.content).not.toContain(`getRecord("valid_users"`);
  });

  test('requiredDataRole "registered_user" filters to valid_users dataset', async () => {
    const engine = new ScriptGenEngine();
    const config: GenerationConfig = {
      url: 'https://www.saucedemo.com',
      cachedCrawlData: mockCrawl,
      testCases: [{
        title: 'Login - Valid Credentials',
        steps: [
          'Navigate to https://www.saucedemo.com',
          'Enter valid credentials',
          'Click Login',
        ],
        expected_result: 'User is logged in',
        test_data: '',
      }],
      resolvedTestData: mockResolvedTestData,
      scenarioGraphNodes: new Map([
        [
          'Login - Valid Credentials',
          {
            semantics: {
              variableUnderTest: 'user_credentials',
              preconditions: 'Valid login page',
              variation: 'Valid registered user',
              expectedBehavior: 'Login succeeds',
              requiredDataRole: 'registered_user',
            },
            // No execution.resolvedDataset
          },
        ],
      ]),
    } as any;

    const result = await engine.generate(config);
    const spec = result.generatedFiles.find((f: any) => f.path.endsWith('.spec.ts'));
    expect(spec).toBeDefined();

    // ✅ requiredDataRole="registered_user" should map to valid_users
    expect(spec!.content).toContain(`getRecord("valid_users")`);
    // ❌ MUST NOT bind to negative datasets
    expect(spec!.content).not.toContain(`getRecord("locked_users"`);
    expect(spec!.content).not.toContain(`getRecord("invalid_users"`);
  });
});
