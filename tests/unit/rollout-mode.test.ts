/**
 * Sprint RIF — Requirement Intelligence rollout mode.
 *
 * The mode is a three-way switch (legacy | shadow | enabled), NOT a boolean,
 * with `legacy` as the safe default so a typo can never hand control to the new
 * path. These tests pin the parser, the default, and the two capability
 * predicates. Pure — no env mutation beyond an injected map.
 */

import {
  parseRequirementIntelligenceMode,
  resolveRequirementIntelligenceMode,
  isIntelligenceComputed,
  isIntelligenceControlling,
  DEFAULT_REQUIREMENT_INTELLIGENCE_MODE,
  REQUIREMENT_INTELLIGENCE_MODE_ENV,
} from '../../src/requirement-intelligence/rollout-mode';

describe('parseRequirementIntelligenceMode (RIF)', () => {
  it('accepts the three valid modes', () => {
    expect(parseRequirementIntelligenceMode('legacy')).toBe('legacy');
    expect(parseRequirementIntelligenceMode('shadow')).toBe('shadow');
    expect(parseRequirementIntelligenceMode('enabled')).toBe('enabled');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(parseRequirementIntelligenceMode('  SHADOW ')).toBe('shadow');
    expect(parseRequirementIntelligenceMode('Enabled')).toBe('enabled');
  });

  it('falls back to legacy for undefined / null / empty', () => {
    expect(parseRequirementIntelligenceMode(undefined)).toBe('legacy');
    expect(parseRequirementIntelligenceMode(null)).toBe('legacy');
    expect(parseRequirementIntelligenceMode('   ')).toBe('legacy');
    expect(DEFAULT_REQUIREMENT_INTELLIGENCE_MODE).toBe('legacy');
  });

  it('falls back to legacy AND warns for an unknown value', () => {
    const warnings: string[] = [];
    const mode = parseRequirementIntelligenceMode('turbo', m => warnings.push(m));
    expect(mode).toBe('legacy');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('turbo');
  });

  it('does NOT warn for a valid value', () => {
    const warnings: string[] = [];
    parseRequirementIntelligenceMode('enabled', m => warnings.push(m));
    expect(warnings).toHaveLength(0);
  });
});

describe('resolveRequirementIntelligenceMode (RIF)', () => {
  it('reads the mode from the provided environment', () => {
    const env = { [REQUIREMENT_INTELLIGENCE_MODE_ENV]: 'shadow' } as NodeJS.ProcessEnv;
    expect(resolveRequirementIntelligenceMode(env)).toBe('shadow');
  });

  it('defaults to legacy when the env var is absent', () => {
    expect(resolveRequirementIntelligenceMode({} as NodeJS.ProcessEnv)).toBe('legacy');
  });
});

describe('mode capability predicates (RIF)', () => {
  it('computes intelligence in shadow and enabled only', () => {
    expect(isIntelligenceComputed('legacy')).toBe(false);
    expect(isIntelligenceComputed('shadow')).toBe(true);
    expect(isIntelligenceComputed('enabled')).toBe(true);
  });

  it('lets intelligence CONTROL generation only in enabled', () => {
    expect(isIntelligenceControlling('legacy')).toBe(false);
    expect(isIntelligenceControlling('shadow')).toBe(false);
    expect(isIntelligenceControlling('enabled')).toBe(true);
  });
});
