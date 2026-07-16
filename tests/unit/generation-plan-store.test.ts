import {
  savePlan,
  getPlan,
  planFingerprint,
  __clearPlanStore,
} from '../../src/requirement-intelligence/generation-plan-store';

/** Minimal stand-ins — the store treats these as opaque payloads. */
const intelligence: any = { coverage: { coverage: 91 } };
const plan: any = { decision: 'EXTEND', testCaseIdsToGenerate: ['tc-2'] };
const view: any = { decision: 'extend', repositoryCoverage: 91 };

describe('generation-plan-store', () => {
  beforeEach(() => __clearPlanStore());

  it('saves a plan and retrieves it by id', () => {
    const fingerprint = planFingerprint({ requirementId: 'REQ-1', repoId: 'repo-1' });
    const planId = savePlan({ fingerprint, intelligence, plan, view });

    const stored = getPlan(planId);
    expect(stored).toBeDefined();
    expect(stored!.intelligence).toBe(intelligence);
    expect(stored!.plan).toBe(plan);
    expect(stored!.view).toBe(view);
    expect(stored!.fingerprint).toBe(fingerprint);
  });

  it('returns undefined for an unknown or empty id', () => {
    expect(getPlan('does-not-exist')).toBeUndefined();
    expect(getPlan(undefined)).toBeUndefined();
    expect(getPlan(null)).toBeUndefined();
  });

  it('produces a stable fingerprint regardless of testCaseIds order', () => {
    const a = planFingerprint({ requirementId: 'REQ-1', testCaseIds: ['b', 'a', 'c'] });
    const b = planFingerprint({ requirementId: 'REQ-1', testCaseIds: ['c', 'b', 'a'] });
    expect(a).toBe(b);
  });

  it('produces different fingerprints for different requests', () => {
    const a = planFingerprint({ requirementId: 'REQ-1', repoId: 'repo-1' });
    const b = planFingerprint({ requirementId: 'REQ-2', repoId: 'repo-1' });
    const c = planFingerprint({ requirementId: 'REQ-1', repoId: 'repo-2' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('coerces number and string ids to the same fingerprint', () => {
    const a = planFingerprint({ requirementId: 123, testCaseIds: [1, 2] });
    const b = planFingerprint({ requirementId: '123', testCaseIds: ['1', '2'] });
    expect(a).toBe(b);
  });

  it('a fingerprint mismatch means the approved plan should not be reused', () => {
    const savedFingerprint = planFingerprint({ requirementId: 'REQ-1', testCaseIds: ['tc-1'] });
    const planId = savePlan({ fingerprint: savedFingerprint, intelligence, plan, view });

    // A later /generate for a DIFFERENT scope computes a different fingerprint.
    const nowFingerprint = planFingerprint({ requirementId: 'REQ-1', testCaseIds: ['tc-1', 'tc-2'] });
    const stored = getPlan(planId);
    expect(stored).toBeDefined();
    expect(stored!.fingerprint).not.toBe(nowFingerprint);
  });
});
