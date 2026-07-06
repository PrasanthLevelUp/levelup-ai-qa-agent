/**
 * Architecture Contract Tests
 * ============================================================================
 *
 * These tests enforce architectural boundaries to prevent accidental coupling.
 * They fail immediately when a module violates the "no direct imports" rule,
 * catching regressions at build time instead of code review.
 *
 * **Rule:** No module may import another intelligence module directly. All
 * intelligence flows through the Orchestrator using a unified Intelligence
 * Bundle. Providers gather intelligence. Consumers never know where
 * intelligence came from.
 *
 * Specifically for Scenario Graph:
 *   ✅ ONLY ScenarioGraphProvider may import from '../graph/'
 *   ❌ Script Generation, Healing, RTM, Impact Analysis, Test Case Lab MUST NOT
 *
 * Run with: npx jest tests/unit/architecture-contract.test.ts
 */

import fs from 'fs';
import path from 'path';

const SRC_ROOT = path.join(__dirname, '../../src');

/**
 * Find all TypeScript files under a directory.
 */
function findTsFiles(dir: string): string[] {
  const files: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== 'dist') {
      files.push(...findTsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Extract import statements from a TypeScript file (simple regex).
 */
function extractImports(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const importRegex = /from\s+['"]([^'"]+)['"]/g;
  const imports: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(content)) !== null) {
    imports.push(match[1]!);
  }
  return imports;
}

describe('Architecture Contract: Scenario Graph Isolation', () => {
  it('enforces that ONLY ScenarioGraphProvider imports from ../graph/', () => {
    const allFiles = findTsFiles(SRC_ROOT);
    const violations: Array<{ file: string; imports: string[] }> = [];

    for (const file of allFiles) {
      const relativePath = path.relative(SRC_ROOT, file);

      // Skip the provider itself (it's the one allowed importer)
      if (relativePath.includes('services/scenario-graph-provider.ts')) {
        continue;
      }

      // Skip files INSIDE the graph module (they can import each other)
      if (relativePath.startsWith('graph/')) {
        continue;
      }

      // Skip test-coverage-engine.ts — it's the Test Case Lab consumer wired in Phase 1
      // (before the provider pattern). It will be refactored to use ScenarioContext in a
      // future PR once the orchestrator integration is complete.
      if (relativePath.includes('engines/test-coverage-engine.ts')) {
        continue;
      }

      const imports = extractImports(file);
      const graphImports = imports.filter(imp => imp.includes('/graph/') || imp.includes('../graph/'));

      if (graphImports.length > 0) {
        violations.push({
          file: relativePath,
          imports: graphImports,
        });
      }
    }

    if (violations.length > 0) {
      const report = violations
        .map(v => `  - ${v.file}\n    imports: ${v.imports.join(', ')}`)
        .join('\n');
      const message =
        `❌ Architecture violation: The following modules directly import from the graph module:\n\n${report}\n\n` +
        `ONLY src/services/scenario-graph-provider.ts may import from ../graph/.\n` +
        `All other consumers must use ScenarioContext from the unified Intelligence Bundle.`;
      throw new Error(message);
    }

    expect(violations).toEqual([]);
  });
});

describe('Architecture Contract: Intelligence Module Isolation', () => {
  it('enforces that Script Generation never imports intelligence modules directly', () => {
    const scriptGenFiles = findTsFiles(path.join(SRC_ROOT, 'script-gen'));
    const violations: Array<{ file: string; imports: string[] }> = [];

    const forbiddenPatterns = [
      '/graph/',
      '../graph/',
      '/services/scenario-graph-provider',
      '/services/repository', // Future: when repository becomes a provider
    ];

    // Existing legacy imports (pre-provider-pattern) — will be refactored in future PRs.
    // These are NOT new violations; they're existing code that predates the architecture.
    const legacyAllowedPatterns = [
      '../intelligence/project-convention-profile',
      '../intelligence/element-intelligence',
    ];

    for (const file of scriptGenFiles) {
      const relativePath = path.relative(SRC_ROOT, file);
      const imports = extractImports(file);
      
      const badImports = imports.filter(imp => {
        // Check if it matches a forbidden pattern
        const isForbidden = forbiddenPatterns.some(pattern => imp.includes(pattern));
        if (!isForbidden) return false;
        
        // Exempt legacy allowed patterns (pre-existing code)
        const isLegacy = legacyAllowedPatterns.some(pattern => imp === pattern);
        return !isLegacy;
      });

      if (badImports.length > 0) {
        violations.push({
          file: relativePath,
          imports: badImports,
        });
      }
    }

    if (violations.length > 0) {
      const report = violations
        .map(v => `  - ${v.file}\n    imports: ${v.imports.join(', ')}`)
        .join('\n');
      const message =
        `❌ Architecture violation: Script Generation directly imports intelligence modules:\n\n${report}\n\n` +
        `Script Generation should ONLY depend on the unified Intelligence Bundle from the Orchestrator.`;
      throw new Error(message);
    }

    expect(violations).toEqual([]);
  });

  it('enforces that Healing never imports intelligence modules directly', () => {
    const healingFiles = findTsFiles(path.join(SRC_ROOT, 'core')).filter(f => f.includes('healing'));
    const violations: Array<{ file: string; imports: string[] }> = [];

    const forbiddenPatterns = [
      '/graph/',
      '../graph/',
      '/services/scenario-graph-provider',
    ];

    for (const file of healingFiles) {
      const relativePath = path.relative(SRC_ROOT, file);
      const imports = extractImports(file);
      const badImports = imports.filter(imp =>
        forbiddenPatterns.some(pattern => imp.includes(pattern)),
      );

      if (badImports.length > 0) {
        violations.push({
          file: relativePath,
          imports: badImports,
        });
      }
    }

    if (violations.length > 0) {
      const report = violations
        .map(v => `  - ${v.file}\n    imports: ${v.imports.join(', ')}`)
        .join('\n');
      const message =
        `❌ Architecture violation: Healing directly imports intelligence modules:\n\n${report}\n\n` +
        `Healing should ONLY depend on the unified Intelligence Bundle from the Orchestrator.`;
      throw new Error(message);
    }

    expect(violations).toEqual([]);
  });
});

describe('Architecture Contract: Scenario Graph build/storage isolation', () => {
  // Import-level isolation blocks `import … from '../graph/…'`. But the graph is
  // also reachable via build/storage FUNCTIONS. This defends against a module
  // building a graph or hitting graph storage directly (e.g. through the shared
  // db module) instead of going through the provider.
  //
  // Only ScenarioGraphProvider (build) and the graph module + db layer
  // (definitions/storage) may reference these symbols.
  const FORBIDDEN_CALLS = [
    'getOrBuildScenarioGraph',
    'buildScenarioGraph',
    'new ScenarioGraph(', // defensive: if ScenarioGraph ever becomes a class
    'saveScenarioGraph',
    'getLatestScenarioGraph',
  ];

  it('enforces that ONLY the provider builds graphs / touches graph storage', () => {
    const allFiles = findTsFiles(SRC_ROOT);
    const violations: Array<{ file: string; symbols: string[] }> = [];

    for (const file of allFiles) {
      const relativePath = path.relative(SRC_ROOT, file);

      // The provider is the sanctioned builder/consumer.
      if (relativePath.includes('services/scenario-graph-provider.ts')) continue;
      // The graph module defines build + graph logic.
      if (relativePath.startsWith('graph/')) continue;
      // The db layer defines the storage functions themselves.
      if (relativePath.startsWith('db/')) continue;
      // Phase 1 Test Case Lab consumer — exempt until refactored to the provider.
      if (relativePath.includes('engines/test-coverage-engine.ts')) continue;

      const content = fs.readFileSync(file, 'utf-8');
      const hits = FORBIDDEN_CALLS.filter(sym => content.includes(sym));
      if (hits.length > 0) violations.push({ file: relativePath, symbols: hits });
    }

    if (violations.length > 0) {
      const report = violations
        .map(v => `  - ${v.file}\n    references: ${v.symbols.join(', ')}`)
        .join('\n');
      throw new Error(
        `❌ Architecture violation: modules building graphs or accessing graph storage directly:\n\n${report}\n\n` +
          `Only src/services/scenario-graph-provider.ts may build/read the Scenario Graph.\n` +
          `Everyone else must consume ScenarioContext from the Intelligence Bundle.`,
      );
    }

    expect(violations).toEqual([]);
  });
});

describe('Architecture Contract: Provider Pattern', () => {
  it('ensures ScenarioGraphProvider implements IntelligenceProvider interface', () => {
    const providerPath = path.join(SRC_ROOT, 'services/scenario-graph-provider.ts');
    const content = fs.readFileSync(providerPath, 'utf-8');

    // Check that it imports and implements the interface
    expect(content).toContain('IntelligenceProvider');
    expect(content).toContain('implements IntelligenceProvider');

    // Check that it satisfies the FULL contract: name, version, priority, enabled(), gather()
    expect(content).toContain('readonly name =');
    expect(content).toContain('readonly version =');
    expect(content).toContain('readonly priority =');
    expect(content).toContain('enabled(): boolean');
    expect(content).toContain('async gather(');
  });

  it('ensures the provider returns ScenarioContext (not the raw ScenarioGraph)', () => {
    const providerPath = path.join(SRC_ROOT, 'services/scenario-graph-provider.ts');
    const content = fs.readFileSync(providerPath, 'utf-8');

    // ScenarioContext should be exported (single flat type — not split yet, YAGNI)
    expect(content).toContain('export interface ScenarioContext');

    // The gather return type should be ScenarioContext, not ScenarioGraph
    expect(content).toContain('IntelligenceProvider<ScenarioContext>');
  });

  it('ensures providers do NOT compute confidence (centralized in the scorer)', () => {
    const providerPath = path.join(SRC_ROOT, 'services/scenario-graph-provider.ts');
    const content = fs.readFileSync(providerPath, 'utf-8');

    // The provider must emit raw signals for the centralized scorer…
    expect(content).toContain('signals:');
    // …and must NOT assign a confidence itself (that's the orchestration layer's job).
    expect(content).not.toMatch(/confidence\s*[:=]/);
  });

  it('ensures the Provider Registry registers the Scenario Graph and Repository providers', () => {
    const registryPath = path.join(SRC_ROOT, 'services/provider-registry.ts');
    const content = fs.readFileSync(registryPath, 'utf-8');

    expect(content).toContain('class ProviderRegistry');
    expect(content).toContain('register(');
    expect(content).toContain('gatherAll(');
    expect(content).toContain('getScenarioGraphProvider');
    expect(content).toContain('getRepositoryProvider');
  });

  it('verifies RepositoryProvider satisfies the provider contract', () => {
    const providerPath = path.join(SRC_ROOT, 'services/repository-provider.ts');
    const content = fs.readFileSync(providerPath, 'utf-8');

    // Check that it imports and implements the interface
    expect(content).toContain('IntelligenceProvider');
    expect(content).toContain('implements IntelligenceProvider');

    // Check that it satisfies the FULL contract: name, version, priority, enabled(), gather()
    expect(content).toContain('readonly name =');
    expect(content).toContain('readonly version =');
    expect(content).toContain('readonly priority =');
    expect(content).toContain('enabled(): boolean');
    expect(content).toContain('async gather(');
  });

  it('ensures RepositoryProvider returns RepositoryContext (not raw DB rows)', () => {
    const providerPath = path.join(SRC_ROOT, 'services/repository-provider.ts');
    const content = fs.readFileSync(providerPath, 'utf-8');

    // RepositoryContext should be exported
    expect(content).toContain('export interface RepositoryContext');

    // The gather return type should be RepositoryContext, not raw DB types
    expect(content).toContain('IntelligenceProvider<RepositoryContext>');
  });

  it('ensures RepositoryProvider does NOT compute confidence (centralized)', () => {
    const providerPath = path.join(SRC_ROOT, 'services/repository-provider.ts');
    const content = fs.readFileSync(providerPath, 'utf-8');

    // Provider should return quality signals...
    expect(content).toContain('signals:');
    // ...and must NOT assign a confidence itself.
    expect(content).not.toMatch(/confidence\s*[:=]/);
  });
});

describe('Architecture Contract: Migration Discipline (one provider at a time)', () => {
  // The migration loop is: Provider → Register → Dual Path → Compare → Delete
  // Legacy → Merge → Next Provider. We must NOT accumulate providers with no
  // consumers. Until RepositoryProvider completes its dual-path cycle and legacy
  // is deleted, NO further provider (Knowledge, Similarity, Patterns, App
  // Profile, DOM) may be introduced/registered. This test fails loudly if
  // someone adds the next provider prematurely.
  const ALLOWED_PROVIDERS = new Set(['scenario-graph-provider', 'repository-provider']);

  it('does not add a new *-provider module before Repository migration completes', () => {
    const serviceFiles = findTsFiles(path.join(SRC_ROOT, 'services'));
    // A "provider" here means a concrete implementation of the contract — i.e. a
    // module that `implements IntelligenceProvider`. The interface/infra modules
    // (intelligence-provider.ts, provider-registry.ts) are NOT implementations.
    const providerModules = serviceFiles
      .filter(f => fs.readFileSync(f, 'utf-8').includes('implements IntelligenceProvider'))
      .map(f => path.basename(f, '.ts'));

    const unexpected = providerModules.filter(name => !ALLOWED_PROVIDERS.has(name));
    if (unexpected.length > 0) {
      throw new Error(
        `❌ Migration discipline violation: unexpected provider module(s) added:\n` +
          `  ${unexpected.join(', ')}\n\n` +
          `Do NOT introduce another provider until RepositoryProvider has completed a full\n` +
          `dual-path migration cycle (compare → prove equivalence → delete legacy → merge).\n` +
          `If Repository migration is genuinely done, update ALLOWED_PROVIDERS in this test.`,
      );
    }
    expect(unexpected).toEqual([]);
  });

  it('registry registers exactly the two migrated/infra providers (no premature additions)', () => {
    const registryPath = path.join(SRC_ROOT, 'services/provider-registry.ts');
    const content = fs.readFileSync(registryPath, 'utf-8');
    const registerCalls = (content.match(/registry\.register\(/g) || []).length;
    expect(registerCalls).toBe(2); // ScenarioGraph + Repository only
  });

  it('runs the RepositoryProvider in shadow via gatherForDualPath (legacy stays source of truth)', () => {
    const orchestratorPath = path.join(SRC_ROOT, 'services/intelligence-orchestrator.ts');
    const content = fs.readFileSync(orchestratorPath, 'utf-8');
    // Dual-path must invoke the provider through the shadow entrypoint...
    expect(content).toContain('gatherForDualPath');
    expect(content).toContain('evaluateRepositoryEquivalence');
    // ...and must NOT consume the provider's output into the returned bundle yet
    // (repositoryGraph is still built from the legacy repoGraph).
    expect(content).toContain('available: repoGraph.available');
  });
});
