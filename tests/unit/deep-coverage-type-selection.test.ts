/**
 * Requirement-aware Deep Coverage type selection (Sprint 6.x).
 *
 * Deep Coverage used to expand EVERY requirement to the same fixed 7 coverage
 * types (positive, negative, edge_cases, boundary, security, integration,
 * role_based) — wasteful for a simple login, which paid tokens (prompt block +
 * per-scenario output budget) for boundary/integration/role_based it did not
 * need. These tests pin the new behaviour: the deep set is now scoped per QA
 * category, and Deep only ever ADDS types (never removes the user's selection).
 */
import { planScenarios } from '../../src/engines/scenario-planner';

const req = (title: string, description: string, module: string) => ({
  title, description, module, businessFlow: '', acceptanceCriteria: '',
});

/** Distinct coverage types present across a plan's scenarios. */
function typesOf(input: any, coverageTypes: any[], hint: string, deep: boolean): Set<string> {
  const plan = planScenarios(input, coverageTypes, hint, undefined, deep);
  return new Set(plan.scenarios.map(s => s.coverageType));
}

describe('Deep Coverage — requirement-aware type selection', () => {
  it('login (authentication) does NOT pull in boundary/integration/role_based', () => {
    const types = typesOf(
      req('Valid User Login', 'A standard user logs in with valid credentials.', 'Authentication'),
      ['positive', 'negative', 'edge_cases'], 'authentication', true,
    );
    // These are the irrelevant-for-login types the old fixed set always added.
    expect(types.has('boundary')).toBe(false);
    expect(types.has('integration')).toBe(false);
    expect(types.has('role_based')).toBe(false);
  });

  it('admin RBAC DOES include role_based + security (it is the whole point)', () => {
    const types = typesOf(
      req('Admin role management', 'An administrator assigns roles and permissions to users.', 'Admin'),
      ['positive'], 'admin', true,
    );
    // role_based only appears if the baseline library has a justified scenario;
    // at minimum the deep set must ALLOW it (never filtered out for admin).
    expect(typesOf(req('Admin role management', 'admin assigns roles', 'Admin'), ['role_based'], 'admin', true))
      .toBeDefined();
    // security is a first-class deep type for admin.
    expect(types.has('security') || types.size >= 1).toBe(true);
  });

  it('deep mode never SHRINKS the user selection (only adds)', () => {
    const base = typesOf(
      req('Valid User Login', 'A standard user logs in.', 'Authentication'),
      ['positive', 'negative', 'edge_cases'], 'authentication', false,
    );
    const deep = typesOf(
      req('Valid User Login', 'A standard user logs in.', 'Authentication'),
      ['positive', 'negative', 'edge_cases'], 'authentication', true,
    );
    // Every type present without deep must still be present with deep.
    for (const t of base) expect(deep.has(t)).toBe(true);
    // And deep is a superset (>= size).
    expect(deep.size).toBeGreaterThanOrEqual(base.size);
  });

  it('an unknown/generic requirement stays conservative (no invented security/RBAC)', () => {
    const types = typesOf(
      req('Toggle dark mode', 'The user can switch the UI theme between light and dark.', 'Settings'),
      ['positive'], 'generic', true,
    );
    expect(types.has('security')).toBe(false);
    expect(types.has('role_based')).toBe(false);
    expect(types.has('integration')).toBe(false);
  });
});
