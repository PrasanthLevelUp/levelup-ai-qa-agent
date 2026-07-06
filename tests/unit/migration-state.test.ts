/**
 * Unit tests for the Provider Migration State (services/migration-state).
 *
 * These lock down the runtime contract the orchestrator and the architecture
 * test both depend on:
 *   • resolveMode env precedence (explicit mode > backward-compat booleans > default)
 *   • isProviderProduction / isShadowActive derivations
 *   • sourcesMidMigration ("one migration at a time" input)
 *
 * resolveMode reads process.env live on every call, so we mutate env per-case
 * and restore it afterwards — no module re-import gymnastics needed.
 */

import {
  MigrationMode,
  MIGRATION_REGISTRY,
  resolveMode,
  isProviderProduction,
  isShadowActive,
  sourcesMidMigration,
} from '../../src/services/migration-state';

// Env vars this suite touches — cleared before each case for isolation.
const ENV_KEYS = [
  'REPOSITORY_MIGRATION_MODE',
  'REPOSITORY_PROVIDER',
  'REPOSITORY_DUAL_PATH',
  'SCENARIO_GRAPH_MIGRATION_MODE',
  'SCENARIO_GRAPH_PROVIDER',
];

describe('migration-state', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe('resolveMode — precedence', () => {
    it('falls back to the declared default when no env is set', () => {
      expect(resolveMode('repository')).toBe(MigrationMode.Shadow);
      expect(resolveMode('scenarioGraph')).toBe(MigrationMode.Legacy); // no compat flag → legacy
    });

    it('honors the explicit mode env var above everything', () => {
      process.env.REPOSITORY_MIGRATION_MODE = 'provider';
      // Even with a conflicting legacy boolean, explicit mode wins.
      process.env.REPOSITORY_DUAL_PATH = 'true';
      expect(resolveMode('repository')).toBe(MigrationMode.Provider);
    });

    it('accepts each valid mode string (case/space-insensitive)', () => {
      process.env.REPOSITORY_MIGRATION_MODE = '  LEGACY ';
      expect(resolveMode('repository')).toBe(MigrationMode.Legacy);
      process.env.REPOSITORY_MIGRATION_MODE = 'Shadow';
      expect(resolveMode('repository')).toBe(MigrationMode.Shadow);
      process.env.REPOSITORY_MIGRATION_MODE = 'provider';
      expect(resolveMode('repository')).toBe(MigrationMode.Provider);
    });

    it('ignores an invalid mode string and continues down the precedence chain', () => {
      process.env.REPOSITORY_MIGRATION_MODE = 'bananas';
      // No valid mode, no compat flag → declared default (shadow).
      expect(resolveMode('repository')).toBe(MigrationMode.Shadow);
    });

    it('returns Legacy for an unknown source key', () => {
      expect(resolveMode('does-not-exist')).toBe(MigrationMode.Legacy);
    });
  });

  describe('resolveMode — backward compatibility', () => {
    it('maps REPOSITORY_PROVIDER=true → Provider', () => {
      process.env.REPOSITORY_PROVIDER = 'true';
      expect(resolveMode('repository')).toBe(MigrationMode.Provider);
    });

    it('maps REPOSITORY_DUAL_PATH=true → Shadow', () => {
      process.env.REPOSITORY_DUAL_PATH = 'true';
      expect(resolveMode('repository')).toBe(MigrationMode.Shadow);
    });

    it('prefers REPOSITORY_PROVIDER over REPOSITORY_DUAL_PATH when both set', () => {
      process.env.REPOSITORY_PROVIDER = 'true';
      process.env.REPOSITORY_DUAL_PATH = 'true';
      expect(resolveMode('repository')).toBe(MigrationMode.Provider);
    });

    it('maps SCENARIO_GRAPH_PROVIDER=true → Provider, else Legacy', () => {
      expect(resolveMode('scenarioGraph')).toBe(MigrationMode.Legacy);
      process.env.SCENARIO_GRAPH_PROVIDER = 'true';
      expect(resolveMode('scenarioGraph')).toBe(MigrationMode.Provider);
    });
  });

  describe('isProviderProduction / isShadowActive', () => {
    it('isProviderProduction is true only in Provider mode', () => {
      process.env.REPOSITORY_MIGRATION_MODE = 'legacy';
      expect(isProviderProduction('repository')).toBe(false);
      process.env.REPOSITORY_MIGRATION_MODE = 'shadow';
      expect(isProviderProduction('repository')).toBe(false);
      process.env.REPOSITORY_MIGRATION_MODE = 'provider';
      expect(isProviderProduction('repository')).toBe(true);
    });

    it('isShadowActive is true in Shadow mode', () => {
      process.env.REPOSITORY_MIGRATION_MODE = 'shadow';
      expect(isShadowActive('repository')).toBe(true);
    });

    it('isShadowActive is false in Legacy mode', () => {
      process.env.REPOSITORY_MIGRATION_MODE = 'legacy';
      expect(isShadowActive('repository')).toBe(false);
    });

    it('isShadowActive stays true in Provider mode WHILE legacy is present (rollback shadow)', () => {
      // repository.legacyPresent === true in the registry.
      process.env.REPOSITORY_MIGRATION_MODE = 'provider';
      expect(isShadowActive('repository')).toBe(true);
    });

    it('isShadowActive is false in Provider mode when no legacy path exists', () => {
      // scenarioGraph.legacyPresent === false → nothing to shadow against.
      process.env.SCENARIO_GRAPH_MIGRATION_MODE = 'provider';
      expect(isShadowActive('scenarioGraph')).toBe(false);
    });
  });

  describe('sourcesMidMigration', () => {
    it('reports repository as the single in-flight migration by default', () => {
      const mid = sourcesMidMigration();
      const keys = mid.map(m => m.key);
      expect(keys).toContain('repository');
      // scenarioGraph is a native provider (no legacy) → never mid-migration.
      expect(keys).not.toContain('scenarioGraph');
    });

    it('enforces the "one migration at a time" invariant on the current registry', () => {
      expect(sourcesMidMigration().length).toBeLessThanOrEqual(1);
    });
  });

  describe('registry integrity', () => {
    it('every entry has a unique key matching its map key and a module + providerName', () => {
      for (const [key, decl] of Object.entries(MIGRATION_REGISTRY)) {
        expect(decl.key).toBe(key);
        expect(decl.module).toBeTruthy();
        expect(decl.providerName).toBeTruthy();
        expect(decl.envVar).toBeTruthy();
        expect(Object.values(MigrationMode)).toContain(decl.mode);
      }
    });
  });
});
