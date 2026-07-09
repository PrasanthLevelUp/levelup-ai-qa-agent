/**
 * Unit tests for the Dataset Resolver — Sprint 2C.
 *
 * The resolver has ONE job: turn a `RequiredDataRole` into a concrete
 * `ResolvedDatasetRecord` (dataset + record + values), deterministically, with
 * NO business logic anywhere else. These tests lock the guarantees that make it
 * safe to sit between the FormatterInput and the LLM:
 *
 *   1. registered_user  → valid_users   → standard_user
 *   2. locked_account   → locked_users  → locked_out_user
 *   3. no matching dataset → null (the formatter must keep working)
 *   4. two matching datasets → the highest deterministic score wins
 *   5. same inputs → same record (pure & reproducible)
 *   6. never mutates the Dataset[] it is given
 *   7. never mutates the ScenarioSemantics (resolution is additive)
 *
 * Run with: npx jest tests/unit/dataset-resolver.test.ts
 */

import {
  DatasetResolver,
  datasetResolver,
  type Dataset,
} from '../../src/engines/dataset-resolver';
import {
  buildDraftTestCases,
  buildDeterministicOutput,
  buildFormatterInputs,
} from '../../src/engines/scenario-builder';
import { planScenarios } from '../../src/engines/scenario-planner';

/* ------------------------------------------------------------------ */
/*  Fixtures — role-tagged datasets (the DATA declares the role)       */
/* ------------------------------------------------------------------ */

/** A users dataset that declares "registered_user" at the dataset level and
 *  carries several records, one of which additionally tags "registered_user". */
const VALID_USERS: Dataset = {
  datasetId: 'valid_users',
  name: 'valid_users',
  roles: ['registered_user'],
  records: [
    { recordId: 'standard_user', values: { username: 'standard_user', password: 'secret_sauce' }, tags: ['registered_user'] },
    { recordId: 'problem_user', values: { username: 'problem_user', password: 'secret_sauce' }, tags: ['registered_user'] },
  ],
  metadata: ['staging'],
};

/** A dataset whose RECORD (not the dataset) declares "locked_account". */
const LOCKED_USERS: Dataset = {
  datasetId: 'locked_users',
  name: 'locked_users',
  records: [
    { recordId: 'locked_out_user', values: { username: 'locked_out_user', password: 'secret_sauce' }, tags: ['locked_account'] },
  ],
  metadata: ['staging'],
};

/** An unrelated dataset that declares no role we ask for. */
const ADMIN_USERS: Dataset = {
  datasetId: 'admin_users',
  name: 'admin_users',
  roles: ['admin_user'],
  records: [{ recordId: 'root_admin', values: { username: 'root', password: 'toor' }, tags: ['admin_user'] }],
};

const ALL_DATASETS: Dataset[] = [VALID_USERS, LOCKED_USERS, ADMIN_USERS];

describe('DatasetResolver — deterministic role → record resolution', () => {
  const resolver = new DatasetResolver();

  it('1) resolves registered_user → valid_users → standard_user', () => {
    const record = resolver.resolve('registered_user', ALL_DATASETS);
    expect(record).not.toBeNull();
    expect(record!.datasetId).toBe('valid_users');
    expect(record!.recordId).toBe('standard_user');
    expect(record!.values).toEqual({ username: 'standard_user', password: 'secret_sauce' });
    expect(record!.confidence).toBeGreaterThan(0);
    expect(record!.reason).toContain('registered_user');
    expect(record!.reason).toContain('valid_users');
  });

  it('2) resolves locked_account → locked_users → locked_out_user (record-level tag)', () => {
    const record = resolver.resolve('locked_account', ALL_DATASETS);
    expect(record).not.toBeNull();
    expect(record!.datasetId).toBe('locked_users');
    expect(record!.recordId).toBe('locked_out_user');
    expect(record!.values.username).toBe('locked_out_user');
    // The reason should reflect it matched via a record tag, not a dataset role.
    expect(record!.reason).toContain('record tag');
  });

  it('3) returns null when NO dataset declares the role', () => {
    const record = resolver.resolve('premium_user', ALL_DATASETS);
    expect(record).toBeNull();
    // ...and also for empty inputs (best-effort, never throws).
    expect(resolver.resolve('registered_user', [])).toBeNull();
    expect(resolver.resolve('', ALL_DATASETS)).toBeNull();
  });

  it('3b) formatter still works when resolution yields null (no resolvedDataset attached)', () => {
    const plan = planScenarios(LOGIN_REQ, ['positive'], 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    const out = buildDeterministicOutput(drafts);
    // Pass datasets that declare NONE of the requested roles → resolve() = null.
    const inputs = buildFormatterInputs(out.testCases, undefined, [ADMIN_USERS]);
    expect(inputs.length).toBe(out.testCases.length);
    for (const input of inputs) {
      expect(input.resolvedDataset).toBeUndefined();
      // The contract is still total and valid.
      expect(typeof input.dataRole).toBe('string');
      expect(input.title.length).toBeGreaterThan(0);
    }
  });

  it('4) when TWO datasets match the role, the highest deterministic score wins', () => {
    // Both datasets declare registered_user. RICH has full values (higher key
    // completeness) so it must win on score, regardless of array order.
    const RICH: Dataset = {
      datasetId: 'rich_users',
      name: 'rich_users',
      roles: ['registered_user'],
      records: [{ recordId: 'full', values: { username: 'u', password: 'p' }, tags: ['registered_user'] }],
    };
    const SPARSE: Dataset = {
      datasetId: 'sparse_users',
      name: 'sparse_users',
      roles: ['registered_user'],
      records: [{ recordId: 'empty', values: { username: '', password: '' }, tags: ['registered_user'] }],
    };
    const winnerA = resolver.resolve('registered_user', [SPARSE, RICH]);
    const winnerB = resolver.resolve('registered_user', [RICH, SPARSE]);
    expect(winnerA!.datasetId).toBe('rich_users');
    expect(winnerB!.datasetId).toBe('rich_users'); // order-independent
    expect(winnerA!.confidence).toBeGreaterThan(
      resolver.resolve('registered_user', [SPARSE])!.confidence,
    );
  });

  it('5) same inputs → same record, every time (pure & deterministic)', () => {
    const a = resolver.resolve('registered_user', ALL_DATASETS);
    const b = resolver.resolve('registered_user', ALL_DATASETS);
    const c = datasetResolver.resolve('registered_user', ALL_DATASETS);
    expect(a).toEqual(b);
    expect(a).toEqual(c);
  });

  it('6) never mutates the Dataset[] it is given', () => {
    const snapshot = JSON.stringify(ALL_DATASETS);
    resolver.resolve('registered_user', ALL_DATASETS);
    resolver.resolve('locked_account', ALL_DATASETS);
    resolver.resolve('premium_user', ALL_DATASETS);
    expect(JSON.stringify(ALL_DATASETS)).toBe(snapshot);
    // The returned values are a frozen COPY — mutating them cannot reach back
    // into the source dataset record.
    const record = resolver.resolve('registered_user', ALL_DATASETS)!;
    expect(Object.isFrozen(record.values)).toBe(true);
    try { (record.values as Record<string, string>).username = 'HACKED'; } catch { /* frozen */ }
    expect(VALID_USERS.records[0].values.username).toBe('standard_user');
  });

  it('7) resolution is additive — it never mutates ScenarioSemantics', () => {
    const plan = planScenarios(LOGIN_REQ, ['positive'], 'authentication');
    const { drafts } = buildDraftTestCases(plan, LOGIN_KNOWLEDGE, LOGIN_REQ);
    const out = buildDeterministicOutput(drafts);
    const semantics = new Map([
      [out.testCases[0].scenarioId, {
        variation: 'valid credentials',
        expectedBehavior: 'the user is authenticated and lands on the dashboard',
        requiredDataRole: 'registered_user',
      } as any],
    ]);
    const semanticsSnapshot = JSON.stringify(Array.from(semantics.entries()));
    buildFormatterInputs(out.testCases, semantics, ALL_DATASETS);
    expect(JSON.stringify(Array.from(semantics.entries()))).toBe(semanticsSnapshot);
  });
});

/* ------------------------------------------------------------------ */
/*  Fixtures for the formatter-integration tests (mirror builder test) */
/* ------------------------------------------------------------------ */

const LOGIN_REQ = {
  title: 'User Login',
  description: 'A registered user logs in with their email and password to access the dashboard.',
  acceptanceCriteria: 'Valid credentials authenticate; invalid credentials are rejected with an error.',
  businessFlow: 'Open login page → enter email + password → submit → land on dashboard.',
};

const LOGIN_KNOWLEDGE: any = {
  applicationProfile: {
    baseUrl: 'https://app.example.com',
    name: 'Example App',
    loginUrl: 'https://app.example.com/login',
    username: 'standard_user',
    pages: [{ url: 'https://app.example.com/login', title: 'Login', pageType: 'auth' }],
    forms: [
      {
        page: 'https://app.example.com/login',
        action: '/session',
        method: 'POST',
        submitSelector: '#login-btn',
        fields: [
          { name: 'email', type: 'email', required: true, selector: '#email', label: 'Email' },
          { name: 'password', type: 'password', required: true, selector: '#password', label: 'Password' },
        ],
      },
    ],
    keyElements: [{ label: 'Login', tag: 'button', selector: '#login-btn', role: 'button' }],
  },
  testData: [
    { name: 'standard_user', environment: 'staging', recordCount: 1, sampleKeys: ['email', 'password'] },
  ],
};
