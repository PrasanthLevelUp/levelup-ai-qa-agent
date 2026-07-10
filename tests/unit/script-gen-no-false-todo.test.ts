/**
 * Sprint 3 · PR 3.1 — Remove generated TODO noise by FIXING the cause.
 *
 * Defect: a boundary case whose step reads "Enter ' locked_user ' with
 * whitespace" produced a spurious `// TODO: Review locator` above a perfectly
 * good `loginPage.login(...)` call. Root cause: control-phrase extraction
 * distilled the step to the scenario QUALIFIER "whitespace", which
 * `looksLikeControlName` wrongly accepted as a UI control name. Grounding a
 * field literally named "whitespace" found nothing, fell back to the curated
 * username selector, and — because the phrase never matched — flagged it for
 * review. The fix teaches `looksLikeControlName` that pure input-mutation
 * qualifiers are NOT control names, so the caller grounds the canonical field
 * and no false flag is emitted.
 *
 * Two layers, matching the 2D.2 test style:
 *   1. Unit — `looksLikeControlName` rejects qualifier-only phrases but still
 *      accepts real control names (incl. phrases that embed a field noun).
 *   2. Integration — through public generate(): the whitespace spec is emitted
 *      WITHOUT any `// TODO: Review locator`, while still wrapping the username
 *      in whitespace and reusing loginPage.login().
 */

import { ScriptGenEngine } from '../../src/script-gen/script-gen-engine';

describe('PR 3.1 — looksLikeControlName rejects scenario qualifiers', () => {
  const engine = new ScriptGenEngine();
  const looks = (p: string): boolean => (engine as any).looksLikeControlName(p);

  it('rejects pure input-mutation qualifiers', () => {
    expect(looks('whitespace')).toBe(false);
    expect(looks('special characters')).toBe(false);
    expect(looks('leading trailing spaces')).toBe(false);
    expect(looks('uppercase')).toBe(false);
    expect(looks('256 characters')).toBe(false);
  });

  it('still accepts real control names', () => {
    expect(looks('username')).toBe(true);
    expect(looks('password')).toBe(true);
    expect(looks('coupon code')).toBe(true);
    expect(looks('search box')).toBe(true);
  });

  it('accepts a phrase that embeds a real field noun even with a qualifier', () => {
    // "maximum length username 256 characters" still names the username field,
    // so it must remain groundable (not collapse to a bare qualifier).
    expect(looks('maximum length username 256 characters')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration — through the public generate() entry point.
// ---------------------------------------------------------------------------

const mkMethod = (name: string): any => ({
  name, filePath: 'tests/pages/LoginPage.ts', isExported: true, isAsync: true,
  parameters: [], returnType: 'Promise<void>', jsdoc: '', lineNumber: 1,
  category: 'page-object', complexity: 1,
});

const repoProfile: any = {
  framework: 'playwright', language: 'typescript', testPattern: 'pom',
  helperFunctions: [], fixtures: [], sharedConstants: [], dataFiles: [], dependencies: [],
  pageObjects: [
    { name: 'LoginPage', filePath: 'tests/pages/LoginPage.ts', isExported: true, baseClass: null,
      methods: [mkMethod('open'), mkMethod('login'), mkMethod('getError')], properties: [] },
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

const testCases: any[] = [
  { id: 1396, title: 'Locked user login attempt with leading/trailing whitespace', priority: 'P1',
    preconditions: 'User is on the login page', test_data: 'locked_user',
    expected_result: 'Login should fail and an error message is displayed.',
    steps: ['Navigate to https://www.saucedemo.com', "Enter ' locked_user ' with whitespace", 'Enter valid password', 'Click the login button'] },
];

describe('PR 3.1 — whitespace boundary spec has no false-positive TODO', () => {
  it('emits the whitespace login WITHOUT a "// TODO: Review locator" flag', async () => {
    const engine = new ScriptGenEngine();
    const result = await engine.generate(
      { url: 'https://www.saucedemo.com', cachedCrawlData, repoProfile, testCases } as any,
    );
    const spec = result.generatedFiles.map((f: any) => f.content).join('\n');

    // The whole point of the fix: the review-TODO must be gone.
    expect(spec).not.toContain('// TODO: Review locator');
    // …and the scenario is still faithfully implemented: the username is wrapped
    // in leading/trailing whitespace via a template literal and the repository
    // login helper is reused. (The INNER credential expression varies with
    // dataset binding — that's exercised by the fidelity harness — so we assert
    // the whitespace-wrapping shape, not the specific variable.)
    expect(/\.login\(`\s\$\{[^`]+\}\s`,/.test(spec)).toBe(true);
    expect(spec).toContain('loginPage.login(');
  });
});
