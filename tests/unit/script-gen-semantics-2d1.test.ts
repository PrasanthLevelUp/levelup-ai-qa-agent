/**
 * Sprint 2D.1 — Scenario Semantics Consumption Test
 *
 * Validates that Script Generation consumes ScenarioSemantics from the Scenario
 * Graph (variableUnderTest + variation + expectedBehavior) and derives the
 * correct credentials + assertions WITHOUT re-inferring from the requirement
 * text or title. This test proves the core 2D.1 goal: "Wrong Password" script
 * becomes enter-valid-username → enter-wrong-password → click-login →
 * verify-rejection by reading the semantics ONLY.
 */

import type { ScenarioSemantics } from '../../src/engines/qa-knowledge-engine';

describe('Sprint 2D.1 — Scenario Semantics Consumption', () => {
  /**
   * Test the internal semantics-based credential derivation logic. This bypasses
   * ScenarioIntelligence (which re-classifies from title/steps) and proves Script
   * Gen can produce the same output from graph semantics alone.
   *
   * We use a private method reflection workaround for testing since the method is
   * intentionally private (internal implementation detail, not public API).
   */
  it('derives "wrong password" credentials from semantics (valid username + invalid password)', () => {
    // Arrange: semantics for "Invalid Password Login" scenario from the KB.
    const semantics: ScenarioSemantics = {
      variableUnderTest: 'password',
      preconditions: 'valid username + valid password',
      variation: 'wrong password',
      expectedBehavior: 'login rejected with error message',
      requiredDataRole: 'registered_user',
    };

    const credentialResolver = {
      base: () => ({ username: 'standard_user', password: 'secret_sauce' }),
      validCounterpart: () => ({ username: 'standard_user', password: 'secret_sauce' }),
      envUsername: () => '',
      envPassword: () => 'BadPassword123',
      authoredUsername: null,
      authoredPassword: null,
      authoredBothEmpty: false,
      escape: (s: string) => s,
    };

    // Act: call the deriveFromSemantics method via reflection (private method access).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ScriptGenEngine } = require('../../src/script-gen/script-gen-engine');
    const engine = new ScriptGenEngine();
    const result = (engine as any).deriveFromSemantics(semantics, credentialResolver);

    // Assert: valid username + invalid password (the variation) + error expected.
    expect(result.credentials.username).toBe('standard_user');
    expect(result.credentials.password).toBe('BadPassword123');
    expect(result.errorFragment).toBe('do not match');
    expect(result.coverageCategories).toContain('Negative');
  });

  it('derives "empty username" credentials from semantics (empty username + valid password)', () => {
    const semantics: ScenarioSemantics = {
      variableUnderTest: 'username',
      preconditions: 'valid username + valid password',
      variation: 'empty username',
      expectedBehavior: 'validation error shown',
      requiredDataRole: 'none',
    };

    const credentialResolver = {
      base: () => ({ username: 'standard_user', password: 'secret_sauce' }),
      validCounterpart: () => ({ username: 'standard_user', password: 'secret_sauce' }),
      envUsername: () => '',
      envPassword: () => '',
      authoredUsername: null,
      authoredPassword: null,
      authoredBothEmpty: false,
      escape: (s: string) => s,
    };

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ScriptGenEngine } = require('../../src/script-gen/script-gen-engine');
    const engine = new ScriptGenEngine();
    const result = (engine as any).deriveFromSemantics(semantics, credentialResolver);

    expect(result.credentials.username).toBe(`''`);
    expect(result.credentials.password).toBe('secret_sauce');
    expect(result.errorFragment).toBe('is required');
    expect(result.coverageCategories).toContain('Validation');
  });

  it('derives valid credentials for positive "none" variation (happy path)', () => {
    const semantics: ScenarioSemantics = {
      variableUnderTest: 'none',
      preconditions: 'valid username + valid password',
      variation: 'none',
      expectedBehavior: 'successfully authenticated and redirected',
      requiredDataRole: 'registered_user',
    };

    const credentialResolver = {
      base: () => ({ username: 'standard_user', password: 'secret_sauce' }),
      validCounterpart: () => ({ username: 'standard_user', password: 'secret_sauce' }),
      envUsername: () => '',
      envPassword: () => '',
      authoredUsername: null,
      authoredPassword: null,
      authoredBothEmpty: false,
      escape: (s: string) => s,
    };

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ScriptGenEngine } = require('../../src/script-gen/script-gen-engine');
    const engine = new ScriptGenEngine();
    const result = (engine as any).deriveFromSemantics(semantics, credentialResolver);

    expect(result.credentials.username).toBe('standard_user');
    expect(result.credentials.password).toBe('secret_sauce');
    expect(result.errorFragment).toBe(''); // No error expected for positive path
    expect(result.coverageCategories).toContain('Functional');
  });

  it('derives locked account credentials from semantics (locked username + valid password)', () => {
    const semantics: ScenarioSemantics = {
      variableUnderTest: 'username',
      preconditions: 'valid username + valid password',
      variation: 'locked account',
      expectedBehavior: 'login rejected with locked account error',
      requiredDataRole: 'locked_account',
    };

    const credentialResolver = {
      base: () => ({ username: 'standard_user', password: 'secret_sauce' }),
      validCounterpart: () => ({ username: 'standard_user', password: 'secret_sauce' }),
      envUsername: () => '',
      envPassword: () => '',
      authoredUsername: null,
      authoredPassword: null,
      authoredBothEmpty: false,
      escape: (s: string) => s,
    };

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { ScriptGenEngine } = require('../../src/script-gen/script-gen-engine');
    const engine = new ScriptGenEngine();
    const result = (engine as any).deriveFromSemantics(semantics, credentialResolver);

    expect(result.credentials.username).toBe(`'locked_out_user'`);
    expect(result.credentials.password).toBe('secret_sauce');
    expect(result.errorFragment).toBe('locked out');
    expect(result.coverageCategories).toContain('Negative');
  });
});
