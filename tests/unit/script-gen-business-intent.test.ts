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
 * THE FIX (clean two-tier — dataset knowledge stays in the graph):
 * 1. When the graph has already resolved a dataset record
 *    (`execution.resolvedDataset`), REUSE it directly. The graph is the single
 *    source of dataset truth.
 * 2. Otherwise, fall back to the pre-existing legacy text heuristic.
 *
 * Script Gen deliberately does NOT translate `semantics.requiredDataRole`
 * (a deprecated business role) into a dataset — mapping a role like
 * "locked_user" to the "locked_users" bucket is Dataset-Resolver knowledge, and
 * baking it into the emitter would re-introduce the business coupling Sprint 2
 * removed. When the Dataset Resolver later exposes a resolved
 * `execution.datasetCategory` for thin fixtures, Script Gen will consume that
 * instead of re-inferring.
 *
 * EXPECTED OUTCOME:
 * - "Locked User" scenario → `getRecord("locked_users")` (correct dataset!)
 * - "Valid Credentials" → `getRecord("valid_users")` (representative)
 * - No more silent fallback to wrong business intent
 * - Script Gen never reads the deprecated `requiredDataRole` field
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

  // ── Legacy fallback: no graph-resolved dataset, no role coupling ──────
  // When the graph carries NO `execution.resolvedDataset` (thin fixtures), Script
  // Gen falls back to the pre-existing text heuristic. It must NOT translate the
  // deprecated `requiredDataRole` into a dataset — dataset knowledge lives in the
  // graph, not the emitter.
  test('falls back to legacy text inference (locked) when the graph has no resolvedDataset', async () => {
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
              // requiredDataRole intentionally OMITTED: Script Gen must reach the
              // correct dataset from the case text alone, with zero role coupling.
            },
            // No execution.resolvedDataset (thin fixture)
          },
        ],
      ]),
    } as any;

    const result = await engine.generate(config);
    const spec = result.generatedFiles.find((f: any) => f.path.endsWith('.spec.ts'));
    expect(spec).toBeDefined();

    // ✅ Legacy text inference (title/steps say "locked") → locked_users
    expect(spec!.content).toContain(`getRecord("locked_users"`);
    // ❌ MUST NOT silently fall back to invalid_users or valid_users
    expect(spec!.content).not.toContain(`getRecord("invalid_users"`);
    expect(spec!.content).not.toContain(`getRecord("valid_users"`);
  });

  test('legacy fallback (valid) binds to valid_users when the graph has no resolvedDataset', async () => {
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
              // requiredDataRole intentionally OMITTED (see above).
            },
            // No execution.resolvedDataset
          },
        ],
      ]),
    } as any;

    const result = await engine.generate(config);
    const spec = result.generatedFiles.find((f: any) => f.path.endsWith('.spec.ts'));
    expect(spec).toBeDefined();

    // ✅ Legacy text inference (title/steps say "valid") → valid_users
    expect(spec!.content).toContain(`getRecord("valid_users")`);
    // ❌ MUST NOT bind to negative datasets
    expect(spec!.content).not.toContain(`getRecord("locked_users"`);
    expect(spec!.content).not.toContain(`getRecord("invalid_users"`);
  });

  // ── Architecture guard: the deprecated role must NOT drive dataset choice ─
  // Even when `requiredDataRole` disagrees with the case text, Script Gen must
  // ignore the role entirely (no mapRoleToCategory). Here the role says
  // "registered_user" but the case is clearly a locked-account scenario — the
  // emitted script must follow the SCENARIO, never the role.
  test('ignores requiredDataRole entirely — role must not override scenario text', async () => {
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
        expected_result: 'Error message: account is locked out',
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
              // Deliberately WRONG/contradictory deprecated role. If Script Gen
              // still consumed it, we'd wrongly bind to valid_users.
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

    // ✅ Scenario wins: locked-account text → locked_users
    expect(spec!.content).toContain(`getRecord("locked_users"`);
    // ❌ The deprecated role ("registered_user") must NOT have pulled valid_users
    expect(spec!.content).not.toContain(`getRecord("valid_users"`);
    expect(spec!.content).not.toContain(`getRecord("invalid_users"`);
  });
});
