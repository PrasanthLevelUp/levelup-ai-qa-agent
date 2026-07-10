/**
 * Generation Metrics — the Generation Cost Tracker model.
 *
 * Locks in the rules that make token reporting trustworthy to a CTO:
 *   (1) aggregation across multiple LLM calls sums the provider's real usage
 *   (2) `null` (unknown) is NEVER conflated with `0` (genuinely zero) — an
 *       unknown call does not drag a known total down to a lie
 *   (3) a deterministic (no-LLM) generation reports 0 tokens + cacheHit, not null
 *   (4) formatTokens renders `1.7K tokens` / `420 tokens` / `0 tokens` / `Unknown`
 *   (5) end-to-end: a deterministic Script Gen run exposes result.generationMetrics
 */

import {
  deterministicMetrics,
  newGenerationMetrics,
  recordLlmCall,
  formatTokens,
  type TokenUsage,
} from '../../src/ai/generation-metrics';
import { ScriptGenEngine } from '../../src/script-gen/script-gen-engine';

const usage = (p: number | null, c: number | null, t: number | null, model = 'gpt-4o'): TokenUsage => ({
  promptTokens: p, completionTokens: c, totalTokens: t, model,
});

describe('Generation Metrics — cost tracker model', () => {
  // (1) aggregate three real calls (plan + review + repair) into one total.
  it('(1) aggregates provider usage across multiple LLM calls', () => {
    const m = newGenerationMetrics({ provider: 'openai', model: 'gpt-4o' });
    recordLlmCall(m, usage(1000, 240, 1240));
    recordLlmCall(m, usage(180, 40, 220));
    recordLlmCall(m, usage(70, 25, 95));
    expect(m.llmCalls).toBe(3);
    expect(m.promptTokens).toBe(1250);
    expect(m.completionTokens).toBe(305);
    expect(m.totalTokens).toBe(1555);
    expect(m.provider).toBe('openai');
  });

  // (2) an unknown call (provider returned no usage) stays unknown-aware: known
  //     contributions still sum, the unknown one is skipped — never treated as 0.
  it('(2) null (unknown) is not conflated with 0', () => {
    const m = newGenerationMetrics({ provider: 'openai', model: 'gpt-4o' });
    // First call: provider returned NO usage at all → everything unknown.
    recordLlmCall(m, usage(null, null, null));
    expect(m.llmCalls).toBe(1);
    expect(m.totalTokens).toBeNull();       // unknown, NOT 0
    expect(m.promptTokens).toBeNull();
    // Second call reports real usage → the known part surfaces.
    recordLlmCall(m, usage(100, 20, 120));
    expect(m.llmCalls).toBe(2);
    expect(m.totalTokens).toBe(120);        // the known call's tokens, not null
  });

  // (3) deterministic (no-LLM) run: 0 tokens (a KNOWN quantity) + cacheHit badge.
  it('(3) deterministic metrics report 0 tokens with cacheHit, never null', () => {
    const m = deterministicMetrics({ model: 'deterministic-requirement-batch', durationMs: 12 });
    expect(m.llmCalls).toBe(0);
    expect(m.totalTokens).toBe(0);          // 0 = genuinely no LLM tokens
    expect(m.promptTokens).toBe(0);
    expect(m.completionTokens).toBe(0);
    expect(m.cacheHit).toBe(true);
    expect(m.provider).toBe('deterministic');
    expect(m.durationMs).toBe(12);
  });

  // (4) presentation formatting.
  it('(4) formatTokens renders human-friendly strings', () => {
    expect(formatTokens(1720)).toBe('1.7K tokens');
    expect(formatTokens(420)).toBe('420 tokens');
    expect(formatTokens(0)).toBe('0 tokens');
    expect(formatTokens(null)).toBe('Unknown');   // unknown ≠ 0
    expect(formatTokens(1000)).toBe('1.0K tokens');
  });
});

describe('Generation Metrics — end-to-end (deterministic Script Gen)', () => {
  const mkMethod = (name: string): any => ({
    name, filePath: 'tests/pages/LoginPage.ts', isExported: true, isAsync: true,
    parameters: [], returnType: 'Promise<void>', jsdoc: '', lineNumber: 1, category: 'page-object', complexity: 1,
  });
  const repoProfile: any = {
    framework: 'playwright', language: 'typescript', testPattern: 'pom',
    helperFunctions: [], fixtures: [], sharedConstants: [], dataFiles: [], dependencies: [],
    pageObjects: [{ name: 'LoginPage', filePath: 'tests/pages/LoginPage.ts', isExported: true, baseClass: null,
      methods: [mkMethod('open'), mkMethod('login'), mkMethod('getError')], properties: [] }],
  };
  const cachedCrawlData: any = {
    url: 'https://www.saucedemo.com', finalUrl: 'https://www.saucedemo.com', title: 'Swag Labs',
    pageType: 'login', pageTypeConfidence: 0.9,
    elements: [
      { tag: 'input', id: 'user-name', name: 'user-name', type: 'text', attributes: { 'data-test': 'username' } },
      { tag: 'input', id: 'password', name: 'password', type: 'password', attributes: { 'data-test': 'password' } },
      { tag: 'input', id: 'login-button', type: 'submit', attributes: { 'data-test': 'login-button' } },
    ],
    forms: [], navigationLinks: [], buttons: [], inputs: [], headings: [],
    htmlSnapshot: '', totalElements: 3, interactiveElements: 3,
  };

  it('(5) a deterministic generation exposes generationMetrics (0 tokens, cacheHit, no LLM)', async () => {
    const engine = new ScriptGenEngine();
    const testCases = [{
      id: 1, title: 'Login attempt', priority: 'P0',
      preconditions: 'User is on the login page', test_data: 'standard_user',
      expected_result: 'Login succeeds and the inventory page is shown.',
      steps: ['Navigate to https://www.saucedemo.com', 'Enter username from valid_users: standard_user', 'Enter valid password', 'Click the login button'],
    }];
    const result = await engine.generate({ url: 'https://www.saucedemo.com', cachedCrawlData, repoProfile, testCases } as any);
    expect(result.generationMetrics).toBeDefined();
    expect(result.generationMetrics.llmCalls).toBe(0);
    expect(result.generationMetrics.totalTokens).toBe(0);
    expect(result.generationMetrics.cacheHit).toBe(true);
    expect(result.generationMetrics.durationMs).toBeGreaterThanOrEqual(0);
    expect(formatTokens(result.generationMetrics.totalTokens)).toBe('0 tokens');
  });
});
