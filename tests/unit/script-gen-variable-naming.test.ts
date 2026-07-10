/**
 * Sprint 3.5 — Variable Naming: dataset variables carry the business role.
 *
 * This is an EMITTER-QUALITY change, not an intelligence change. The Execution
 * Graph still owns WHICH business actor a scenario exercises (via the node's
 * `semantics.requiredDataRole`, authored in Sprint 2D). Script Gen still only
 * TRANSLATES that into code. The single thing 3.5 adds is the NAME of the const
 * that binds the resolved dataset record in the generated spec:
 *
 *   before →  const user = getRecord("locked_users")
 *   after  →  const lockedAccount = getRecord("locked_users")
 *
 * How the name is chosen (Rule #1 — never infer):
 *   • The name comes ONLY from existing metadata — the scenario's declared data
 *     ROLE — mechanically converted to an identifier by the single resolver
 *     `resolveDatasetVarName`. There is NO synonym/dictionary/NLP/AI step:
 *     `locked_account` → `lockedAccount` (NOT `lockedUser`).
 *   • The role source is read future-first: the Graph Schema 2.0 home
 *     `resources.dataRoles` is preferred, falling back to the @deprecated
 *     `semantics.requiredDataRole`, so the deprecated field can be removed later
 *     without touching Script Gen.
 *   • The generic `valid_data` role is not a business actor, so it keeps the
 *     historical neutral `user`.
 *   • Legacy / greenfield cases with no graph node also keep `user`, so every
 *     pre-graph spec and golden snapshot stays byte-identical.
 *
 * The invariants this suite locks in:
 *   (1) the resolver maps each real role to its camelCase name, deterministically
 *   (2) generic `valid_data`, empty, and absent nodes fall back to `user`
 *   (2c) `resources.dataRoles` is preferred over the deprecated `requiredDataRole`
 *   (3) end-to-end: the declaration AND every read use the SAME business name
 *   (4) no collisions / no `user2` suffixes, one object → one name (Rule #3/#5)
 *   (5) legacy path (no scenarioGraphNodes) still emits `const user` (back-compat)
 *   (6) deterministic — same node in ⇒ same name out
 *   (7) the same role resolved twice never gains a numeric suffix (registeredUser1)
 */

import { ScriptGenEngine } from '../../src/script-gen/script-gen-engine';

// ── Shared fixtures (deterministic, cached crawl — no network / LLM) ──────────
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

// A graph node exercising a given data role. Mirrors the Sprint 2D semantics
// contract (variableUnderTest / variation / expectedBehavior + requiredDataRole).
const mkNode = (role: string): any => ({
  semantics: {
    requiredDataRole: role,
    variableUnderTest: 'credentials',
    variation: 'valid',
    expectedBehavior: 'the account is locked out',
  },
});

// A Graph Schema 2.0 node that carries the role in the future `resources` home
// (an array, per the Execution Graph contract §3, e.g. ["registered_user"]).
const mkResourcesNode = (roles: string[] | string, semanticsRole?: string): any => ({
  resources: { dataRoles: roles },
  semantics: semanticsRole
    ? { requiredDataRole: semanticsRole, variableUnderTest: 'x', variation: 'y', expectedBehavior: 'z' }
    : undefined,
});

// The "locked valid-credentials" case forces the getRecord READ path (login
// reads <var>.username / <var>.password), so we can assert the reads rename too.
const LOCKED_TITLE = 'Locked user login attempt with valid credentials';
const lockedCase = (): any => ({
  id: 1392, title: LOCKED_TITLE, priority: 'P0',
  preconditions: 'User is on the login page', test_data: 'locked_user',
  expected_result: 'Login should fail and an error message is displayed indicating the account is locked out.',
  steps: [
    'Navigate to https://www.saucedemo.com',
    'Enter username from locked_users: locked_out_user',
    'Enter valid password', 'Click the login button',
  ],
});

async function generateLocked(role: string | null): Promise<string> {
  const engine = new ScriptGenEngine();
  const scenarioGraphNodes = role
    ? new Map<string, any>([[LOCKED_TITLE, mkNode(role)]]) // legacy title-keyed node
    : undefined;
  const result = await engine.generate({
    url: 'https://www.saucedemo.com', cachedCrawlData, repoProfile,
    testCases: [lockedCase()], scenarioGraphNodes,
  } as any);
  return result.generatedFiles.map((f: any) => f.content).join('\n');
}

describe('Sprint 3.5 — ScriptGen dataset variable naming (role → camelCase)', () => {
  const engine = new ScriptGenEngine();
  const resolve = (role?: string): string =>
    (engine as any).resolveDatasetVarName(role ? { semantics: { requiredDataRole: role } } : undefined);

  // (1) the resolver maps each REAL role (the only four the KB authors) to its
  //     mechanical camelCase name — no synonym rewriting.
  it('(1) resolver maps each real data role to its camelCase identifier', () => {
    expect(resolve('registered_user')).toBe('registeredUser');
    expect(resolve('unregistered_user')).toBe('unregisteredUser');
    // `locked_account` becomes `lockedAccount`, NOT `lockedUser` — no dictionary.
    expect(resolve('locked_account')).toBe('lockedAccount');
  });

  // (2) generic / empty / absent → neutral `user` (business role → default).
  it('(2) generic `valid_data`, empty, and absent roles fall back to `user`', () => {
    expect(resolve('valid_data')).toBe('user');
    expect(resolve('')).toBe('user');
    expect(resolve(undefined)).toBe('user');
    expect((engine as any).resolveDatasetVarName({ semantics: {} })).toBe('user');
    expect((engine as any).resolveDatasetVarName({})).toBe('user');
  });

  // (2b) casing / whitespace robustness — still purely mechanical.
  it('(2b) role tokenisation is case/format tolerant but never inferential', () => {
    expect(resolve('Registered_User')).toBe('registeredUser');
    expect(resolve('  locked_account  ')).toBe('lockedAccount');
  });

  // (2c) FUTURE-PROOF source: the resolver reads the Graph Schema 2.0 home
  //      (`resources.dataRoles`) FIRST, and only falls back to the deprecated
  //      `semantics.requiredDataRole`. This lets the deprecated field be deleted
  //      later without touching Script Gen.
  it('(2c) resources.dataRoles is preferred over the deprecated requiredDataRole', () => {
    const R = (node: any) => (engine as any).resolveDatasetVarName(node);
    // array form (contract shape) — first non-empty role wins
    expect(R(mkResourcesNode(['registered_user']))).toBe('registeredUser');
    // resources present → deprecated field is ignored even if it disagrees
    expect(R(mkResourcesNode(['locked_account'], 'registered_user'))).toBe('lockedAccount');
    // empty/garbage resources → fall back to the deprecated field
    expect(R(mkResourcesNode([], 'registered_user'))).toBe('registeredUser');
    expect(R(mkResourcesNode([''], 'unregistered_user'))).toBe('unregisteredUser');
    // string form (defensive) is also accepted
    expect(R({ resources: { dataRoles: 'locked_account' } })).toBe('lockedAccount');
  });

  // (3) end-to-end: the DECLARATION and the READS both use the business name.
  it('(3) end-to-end: declaration and reads both use the business-role name', async () => {
    const spec = await generateLocked('locked_account');
    expect(spec).toContain('const lockedAccount = getRecord("locked_users")');
    expect(spec).toContain('lockedAccount.username');
    expect(spec).toContain('lockedAccount.password');
  });

  // (4) one object → ONE name: no bare `user.` reads, no `user2`/`user3` suffix.
  it('(4) no collisions and no leftover generic `user` reference', async () => {
    const spec = await generateLocked('locked_account');
    expect(spec).not.toMatch(/\buser\d\b/);              // no user2 / user3
    expect(spec).not.toMatch(/\buser\.(username|password)\b/); // no stale bare user.
    expect(spec).not.toContain('const user = getRecord'); // renamed, not duplicated
  });

  // (5) back-compat: with NO graph node the spec keeps the neutral `user` — the
  //     exact shape every pre-Sprint-3.5 spec (and golden snapshot) already had.
  it('(5) legacy path with no graph node still emits `const user`', async () => {
    const spec = await generateLocked(null);
    expect(spec).toContain('const user = getRecord("locked_users")');
    expect(spec).toContain('user.username');
    expect(spec).not.toContain('lockedAccount');
  });

  // (6) deterministic — identical node in ⇒ identical name & identical spec out.
  it('(6) deterministic across engine instances and repeated generation', async () => {
    const a = new ScriptGenEngine();
    const b = new ScriptGenEngine();
    expect((a as any).resolveDatasetVarName(mkNode('registered_user')))
      .toBe((b as any).resolveDatasetVarName(mkNode('registered_user')));
    const [s1, s2] = await Promise.all([generateLocked('locked_account'), generateLocked('locked_account')]);
    expect(s1).toBe(s2);
  });

  // (7) the SAME role resolved twice yields the IDENTICAL name — never a
  //     disambiguating numeric suffix (`registeredUser1`). The resolver is a pure
  //     function of the role, so repetition is stable by construction: two calls
  //     both return `registeredUser`, proving no hidden counter/uniquifier state.
  it('(7) the same role never gains a numeric suffix on repeat resolution', () => {
    const first = resolve('registered_user');
    const second = resolve('registered_user');
    expect(first).toBe('registeredUser');
    expect(second).toBe('registeredUser'); // NOT registeredUser1
    expect(first).toBe(second);
    expect(second).not.toMatch(/\d$/); // categorically no trailing digit
  });
});
