/**
 * Unit tests for the Intelligence Provider Registry.
 *
 * Locks: dupe-safe register, priority ordering, enabled() filtering, fail-open
 * gatherAll, and centralized (generic) confidence attachment.
 *
 * Run with: npx jest tests/unit/provider-registry.test.ts
 */

import { ProviderRegistry } from '../../src/services/provider-registry';
import type {
  IntelligenceProvider,
  IntelligenceResult,
} from '../../src/services/intelligence-provider';
import type { IntelligenceQuery } from '../../src/services/intelligence-provider';

const query: IntelligenceQuery = {
  intent: 'Login',
  companyId: 1,
  caller: 'script-gen',
};

/** Minimal fake provider for testing registry mechanics. */
function fakeProvider(
  name: string,
  opts: {
    version?: number;
    priority?: number;
    enabled?: boolean;
    result?: Partial<IntelligenceResult>;
    throwOnGather?: boolean;
  } = {},
): IntelligenceProvider {
  const version = opts.version ?? 1;
  return {
    name,
    version,
    priority: opts.priority ?? 50,
    enabled: () => opts.enabled ?? true,
    async gather(): Promise<IntelligenceResult> {
      if (opts.throwOnGather) throw new Error(`${name} boom`);
      return {
        available: true,
        context: { name },
        metadata: {
          provider: name,
          providerVersion: version,
          durationMs: 1,
          cacheHit: false,
          items: 1,
          warnings: [],
          signals: {},
        },
        ...opts.result,
      };
    },
  };
}

describe('ProviderRegistry — registration', () => {
  it('registers and retrieves providers', () => {
    const r = new ProviderRegistry();
    const p = fakeProvider('alpha');
    r.register(p);
    expect(r.has('alpha')).toBe(true);
    expect(r.get('alpha')).toBe(p);
    expect(r.size).toBe(1);
  });

  it('throws on duplicate provider names', () => {
    const r = new ProviderRegistry();
    r.register(fakeProvider('alpha'));
    expect(() => r.register(fakeProvider('alpha'))).toThrow(/duplicate provider name/);
  });

  it('unregisters providers', () => {
    const r = new ProviderRegistry();
    r.register(fakeProvider('alpha'));
    expect(r.unregister('alpha')).toBe(true);
    expect(r.has('alpha')).toBe(false);
  });
});

describe('ProviderRegistry — ordering', () => {
  it('lists providers by ascending priority, name tiebreak', () => {
    const r = new ProviderRegistry();
    r.register(fakeProvider('c', { priority: 10 }));
    r.register(fakeProvider('a', { priority: 70 }));
    r.register(fakeProvider('b', { priority: 70 }));
    expect(r.list().map(p => p.name)).toEqual(['c', 'a', 'b']);
  });

  it('listEnabled filters disabled providers', () => {
    const r = new ProviderRegistry();
    r.register(fakeProvider('on', { enabled: true }));
    r.register(fakeProvider('off', { enabled: false }));
    expect(r.listEnabled().map(p => p.name)).toEqual(['on']);
  });

  it('treats a throwing enabled() as disabled (fail-open)', () => {
    const r = new ProviderRegistry();
    const bad: IntelligenceProvider = {
      name: 'bad',
      version: 1,
      priority: 1,
      enabled: () => { throw new Error('nope'); },
      async gather() {
        return {
          available: true,
          context: {},
          metadata: { provider: 'bad', providerVersion: 1, durationMs: 0, cacheHit: false, items: 0, warnings: [], signals: {} },
        };
      },
    };
    r.register(bad);
    expect(r.listEnabled()).toEqual([]);
  });
});

describe('ProviderRegistry — gatherAll', () => {
  it('gathers from enabled providers and attaches centralized confidence', async () => {
    const r = new ProviderRegistry();
    r.register(fakeProvider('off', { enabled: false }));
    r.register(
      fakeProvider('scenarioGraph', {
        result: {
          available: true,
          context: { ok: true },
          metadata: {
            provider: 'scenarioGraph',
            providerVersion: 1,
            durationMs: 1,
            cacheHit: false,
            items: 2,
            warnings: [],
            signals: { grounding: 1, coverage: 0.5 },
          },
        },
      }),
    );

    const results = await r.gatherAll(query);

    // Disabled provider skipped
    expect(results.has('off')).toBe(false);
    // Confidence computed centrally & generically from signals: avg(1, 0.5)*100 = 75
    expect(results.get('scenarioGraph')!.confidence).toBe(75);
  });

  it('is fail-open: a throwing provider yields an unavailable result, not a crash', async () => {
    const r = new ProviderRegistry();
    r.register(fakeProvider('good'));
    r.register(fakeProvider('bad', { throwOnGather: true, version: 3 }));

    const results = await r.gatherAll(query);

    expect(results.get('good')!.available).toBe(true);
    const bad = results.get('bad')!;
    expect(bad.available).toBe(false);
    expect(bad.confidence).toBe(0);
    expect(bad.metadata.providerVersion).toBe(3); // version preserved in the fail-open result
    expect(bad.metadata.warnings.join(' ')).toMatch(/boom/);
  });
});

describe('ProviderRegistry — default singleton', () => {
  it('registers the Scenario Graph provider by default', () => {
    jest.isolateModules(() => {
      const { getProviderRegistry } = require('../../src/services/provider-registry');
      const registry = getProviderRegistry();
      expect(registry.has('scenarioGraph')).toBe(true);
    });
  });
});
