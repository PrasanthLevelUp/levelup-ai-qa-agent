/**
 * Repo Pattern Analyzer (Intelligence Layer — Repo Patterns)
 * ==========================================================
 *
 * PURPOSE
 * -------
 * Distils a (already analysed & cached) `RepositoryProfile` into a compact,
 * generation-ready *pattern guide* that script-generation engines inject into
 * their prompts so the code they emit matches the target repo's existing
 * conventions — imports, assertion style, test naming, describe/it structure,
 * preferred locators, reusable helpers / page objects, file naming and tags.
 *
 * WHY A SEPARATE LAYER (and not just `buildAIPromptContext`)
 * ---------------------------------------------------------
 * `buildAIPromptContext` (context/prompt-builder) is a generic repo-context
 * dump used by several engines. This analyzer is *script-generation focused*:
 *   • it produces an explicit IMPORT block + ASSERTION example to mirror,
 *   • it derives a concrete file-naming function honouring the repo convention,
 *   • it returns a STRUCTURED summary (not just a string) so engines can make
 *     decisions (e.g. pick describe/it vs flat), and
 *   • it is TOKEN-OPTIMISED + CACHED: the heavy file analysis already lives in
 *     `RepositoryProfile` (persisted in `repository_contexts`), so this layer
 *     never re-reads the repo. On top of that, the distilled guide is memoised
 *     in-process keyed by a profile fingerprint, so repeated generations in the
 *     same process don't recompute it and output stays deterministic.
 *
 * DESIGN NOTES
 * ------------
 * • Pure / CPU-only — no network, no filesystem, no DB. Input is the cached
 *   profile; output is a string + struct. Safe to call on any request path.
 * • Defensive — tolerates partial/empty profiles (returns `undefined` guide
 *   when there's nothing useful, so callers fall back to generic generation).
 */

import * as crypto from 'crypto';
import type {
  RepositoryProfile,
  ClassInfo,
  FunctionSignature,
} from '../context/types';

/* -------------------------------------------------------------------------- */
/*  Public Types                                                              */
/* -------------------------------------------------------------------------- */

/** A concrete, generation-ready distillation of the repo's test conventions. */
export interface RepoPatternSummary {
  framework: string;
  language: string;
  testPattern: string;
  /** Idiomatic import lines the generated file should start with. */
  imports: string[];
  /** Assertion library + a one-line example to mirror (e.g. `expect(x).toBe(y)`). */
  assertionLibrary: string;
  assertionExample: string;
  /** Preferred test structure. */
  structure: 'describe-it' | 'flat' | 'given-when-then';
  /** Test-name convention description (e.g. 'should_x_when_y'). */
  testNaming: string;
  /** Tag convention (e.g. '@smoke') or null. */
  tagConvention: string | null;
  quoteStyle: 'single' | 'double';
  semicolons: boolean;
  /** Preferred locator patterns, most-used first. */
  preferredLocators: string[];
  /** Anti-patterns the repo avoids. */
  avoidLocators: string[];
  /** Reusable helpers to import instead of re-implementing. */
  helpers: Array<{ name: string; params: string; filePath: string }>;
  /** Page objects to reuse. */
  pageObjects: Array<{ name: string; filePath: string; methods: string[] }>;
  /** Fixtures available. */
  fixtures: Array<{ name: string; filePath: string }>;
  /** Folder layout hints. */
  folders: { tests?: string; pages?: string; fixtures?: string; utils?: string };
  /** File-naming convention slug, e.g. 'kebab.spec' / 'camelCase.test'. */
  fileNaming: string;
  /** How confident we are this guide is meaningful (0-100). */
  confidence: number;
}

/** The full result: a structured summary + a token-budgeted prompt block. */
export interface RepoPatternGuide {
  summary: RepoPatternSummary;
  /** Compact prompt block (~300-900 tokens) to inject into a generation prompt. */
  promptBlock: string;
  /** Build a repo-consistent test file name for a feature slug. */
  buildFileName: (featureSlug: string) => string;
}

/* -------------------------------------------------------------------------- */
/*  In-process memo cache (token / CPU optimisation)                          */
/* -------------------------------------------------------------------------- */

interface CacheEntry { guide: RepoPatternGuide; ts: number; }
const CACHE = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes — profiles change rarely
const CACHE_MAX = 100;

/**
 * CONTENT fingerprint of the fields that affect the distilled guide.
 *
 * SECURITY / CORRECTNESS — why we hash actual content (not just counts):
 * `RepositoryProfile` carries NO tenant identifiers (no company/project/repo id),
 * so the cache key MUST be derived from the profile's content alone. An earlier
 * version keyed only on *counts* (e.g. `helperFunctions.length`), which meant two
 * different repositories that happened to share framework/language/style and the
 * same number of helpers/page-objects/fixtures would collide — and the cached
 * guide embeds the FIRST repo's real helper names, page-object names and file
 * paths. That is a cross-tenant data-leak: tenant B's generation prompt could be
 * seeded with tenant A's repo internals.
 *
 * We therefore fold the *identifying content* (names + file paths + locator
 * patterns/examples + folder layout + style) into a SHA-256 digest. Different
 * repositories produce different digests, so a collision is cryptographically
 * improbable while identical profiles still hit the cache (the optimisation we
 * actually want). Only stable, guide-affecting fields are included.
 */
function fingerprint(profile: RepositoryProfile): string {
  const s = profile.codingStyle;
  const sig = {
    framework: profile.framework,
    language: profile.language,
    testPattern: profile.testPattern,
    locatorStrategy: profile.locatorStrategy,
    assertionLibrary: profile.assertionLibrary,
    // Actual identifying content — names + paths, not just counts.
    helpers: (profile.helperFunctions || []).map((h) => `${h.name}@${h.filePath}`),
    pageObjects: (profile.pageObjects || []).map((p) => `${p.name}@${p.filePath}`),
    fixtures: (profile.fixtures || []).map((f) => `${f.name}@${f.filePath}`),
    preferredLocators: (profile.preferredLocators || []).map((l) => `${l.pattern}|${l.example ?? ''}`),
    avoidPatterns: profile.avoidPatterns || [],
    style: s
      ? `${s.namingConvention}|${s.testNaming}|${s.stepStyle}|${s.quoteStyle}|${s.semicolons}|${s.tagConvention}`
      : 'no-style',
    folders: profile.folderStructure || null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(sig)).digest('hex');
}

/* -------------------------------------------------------------------------- */
/*  Analyzer                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build (or return cached) repo-pattern guide from a cached RepositoryProfile.
 * Returns `undefined` when the profile carries nothing useful so callers fall
 * back to generic generation gracefully.
 */
export function analyzeRepoPatterns(profile: RepositoryProfile | null | undefined): RepoPatternGuide | undefined {
  if (!profile) return undefined;

  const key = fingerprint(profile);
  const cached = CACHE.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.guide;
  }

  const summary = buildSummary(profile);
  // Nothing meaningful to teach the model → no guide (generic generation).
  if (summary.confidence < 15) return undefined;

  const guide: RepoPatternGuide = {
    summary,
    promptBlock: buildPromptBlock(summary),
    buildFileName: (slug: string) => buildFileName(slug, summary),
  };

  // Memoise (bounded LRU-ish: drop oldest when full).
  if (CACHE.size >= CACHE_MAX) {
    const oldest = [...CACHE.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]?.[0];
    if (oldest) CACHE.delete(oldest);
  }
  CACHE.set(key, { guide, ts: Date.now() });
  return guide;
}

/** Clear the in-process cache (used by tests / after a profile re-analysis). */
export function clearRepoPatternCache(): void {
  CACHE.clear();
}

/* -------------------------------------------------------------------------- */
/*  Distillation                                                              */
/* -------------------------------------------------------------------------- */

function buildSummary(profile: RepositoryProfile): RepoPatternSummary {
  const style = profile.codingStyle;
  const language = profile.language || 'typescript';
  const framework = profile.framework || 'playwright';
  const quoteStyle: 'single' | 'double' = style?.quoteStyle === 'double' ? 'double' : 'single';
  const semicolons = style?.semicolons ?? true;

  const structure: RepoPatternSummary['structure'] =
    style?.stepStyle === 'given_when_then' ? 'given-when-then'
      : profile.testPattern === 'flat-scripts' ? 'flat'
        : 'describe-it';

  const preferredLocators = [...(profile.preferredLocators || [])]
    .sort((a, b) => b.count - a.count)
    .slice(0, 4)
    .map((l) => l.example ? `${l.pattern} (e.g. ${l.example})` : l.pattern);

  const helpers = (profile.helperFunctions || [])
    .slice(0, 12)
    .map((h: FunctionSignature) => ({
      name: h.name,
      params: (h.parameters || []).map((p) => p.name).join(', '),
      filePath: h.filePath,
    }));

  const pageObjects = (profile.pageObjects || [])
    .slice(0, 8)
    .map((po: ClassInfo) => ({
      name: po.name,
      filePath: po.filePath,
      methods: (po.methods || []).slice(0, 6).map((m) => m.name),
    }));

  const fixtures = (profile.fixtures || [])
    .slice(0, 6)
    .map((f: FunctionSignature) => ({ name: f.name, filePath: f.filePath }));

  const folders = {
    tests: profile.folderStructure?.testFolder || undefined,
    pages: profile.folderStructure?.pageObjectFolder || undefined,
    fixtures: profile.folderStructure?.fixtureFolder || undefined,
    utils: profile.folderStructure?.utilsFolder || undefined,
  };

  const assertionLibrary = profile.assertionLibrary || (framework === 'playwright' ? '@playwright/test expect' : 'expect');
  const assertionExample = buildAssertionExample(framework, assertionLibrary);
  const imports = buildImports(profile, framework, language, quoteStyle, semicolons);
  const fileNaming = deriveFileNaming(profile, style?.namingConvention);

  // Confidence: how much real signal do we have to teach the model?
  let confidence = 0;
  if (profile.framework && profile.framework !== 'unknown') confidence += 25;
  if (preferredLocators.length) confidence += 20;
  if (helpers.length) confidence += 20;
  if (pageObjects.length) confidence += 20;
  if (style) confidence += 10;
  if (fixtures.length) confidence += 5;
  confidence = Math.min(100, confidence);

  return {
    framework,
    language,
    testPattern: profile.testPattern || 'unknown',
    imports,
    assertionLibrary,
    assertionExample,
    structure,
    testNaming: style?.testNaming || 'descriptive',
    tagConvention: style?.tagConvention ?? null,
    quoteStyle,
    semicolons,
    preferredLocators,
    avoidLocators: (profile.avoidPatterns || []).slice(0, 5),
    helpers,
    pageObjects,
    fixtures,
    folders,
    fileNaming,
    confidence,
  };
}

function buildAssertionExample(framework: string, lib: string): string {
  if (framework === 'playwright') return "await expect(page.getByRole('heading')).toBeVisible();";
  if (framework === 'cypress') return "cy.get('[data-cy=title]').should('be.visible');";
  if (/chai/i.test(lib)) return "expect(value).to.equal(expected);";
  if (/jest|vitest/i.test(lib)) return "expect(value).toBe(expected);";
  return "expect(value).toBe(expected);";
}

function buildImports(
  profile: RepositoryProfile,
  framework: string,
  language: string,
  quoteStyle: 'single' | 'double',
  semicolons: boolean,
): string[] {
  const q = quoteStyle === 'double' ? '"' : "'";
  const semi = semicolons ? ';' : '';
  const imports: string[] = [];

  if (framework === 'playwright') {
    imports.push(`import { test, expect } from ${q}@playwright/test${q}${semi}`);
  } else if (framework === 'cypress') {
    // Cypress tests usually need no explicit import for cy/expect.
  } else if (language === 'typescript' || language === 'javascript') {
    imports.push(`import { expect } from ${q}${profile.assertionLibrary || 'chai'}${q}${semi}`);
  }

  // Suggest reusing helpers/page-objects via import (path is illustrative;
  // the model adjusts to the real relative path).
  const utils = profile.folderStructure?.utilsFolder;
  if (profile.helperFunctions?.length && utils) {
    const names = profile.helperFunctions.slice(0, 4).map((h) => h.name).join(', ');
    imports.push(`import { ${names} } from ${q}${utils.replace(/^\/?/, '')}/helpers${q}${semi}`);
  }
  return imports;
}

function deriveFileNaming(profile: RepositoryProfile, naming?: string): string {
  // Look at existing test suites to detect a dominant suffix (.spec / .test / .e2e).
  const names = (profile.testSuites || []).map((s) => s.filePath || '').filter(Boolean);
  let suffix = 'spec';
  if (names.some((n) => /\.test\.[tj]s/.test(n))) suffix = 'test';
  else if (names.some((n) => /\.e2e\.[tj]s/.test(n))) suffix = 'e2e';
  else if (names.some((n) => /\.spec\.[tj]s/.test(n))) suffix = 'spec';

  const conv = naming === 'camelCase' ? 'camelCase'
    : naming === 'PascalCase' ? 'PascalCase'
      : naming === 'snake_case' ? 'snake_case'
        : 'kebab-case';
  return `${conv}.${suffix}`;
}

/** Build a repo-consistent file name for a feature (slug already lowercased). */
function buildFileName(featureSlug: string, summary: RepoPatternSummary): string {
  const base = featureSlug.replace(/[^a-z0-9]+/gi, ' ').trim();
  const ext = summary.language === 'javascript' ? 'js' : 'ts';
  const suffix = summary.fileNaming.split('.')[1] || 'spec';
  let name: string;
  if (summary.fileNaming.startsWith('camelCase')) {
    name = base.split(/\s+/).map((w, i) => i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
  } else if (summary.fileNaming.startsWith('PascalCase')) {
    name = base.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('');
  } else if (summary.fileNaming.startsWith('snake_case')) {
    name = base.toLowerCase().split(/\s+/).join('_');
  } else {
    name = base.toLowerCase().split(/\s+/).join('-');
  }
  return `${name || 'generated'}.${suffix}.${ext}`;
}

/* -------------------------------------------------------------------------- */
/*  Prompt block                                                              */
/* -------------------------------------------------------------------------- */

function buildPromptBlock(s: RepoPatternSummary): string {
  const lines: string[] = [];
  lines.push('--- REPO PATTERN GUIDE (match the existing test suite EXACTLY) ---');
  lines.push(`Framework: ${s.framework} | Language: ${s.language} | Pattern: ${s.testPattern}`);
  lines.push(`Style: quotes=${s.quoteStyle}, semicolons=${s.semicolons}, structure=${s.structure}, test-naming=${s.testNaming}${s.tagConvention ? `, tags=${s.tagConvention}` : ''}`);

  if (s.imports.length) {
    lines.push('');
    lines.push('IMPORTS — start the file with these (adjust relative paths to the target dir):');
    for (const imp of s.imports) lines.push(`  ${imp}`);
  }

  lines.push('');
  lines.push(`ASSERTIONS — use ${s.assertionLibrary}. Example to mirror:`);
  lines.push(`  ${s.assertionExample}`);

  if (s.preferredLocators.length) {
    lines.push('');
    lines.push('PREFERRED LOCATORS (most-used first — prefer these strategies):');
    for (const l of s.preferredLocators) lines.push(`  - ${l}`);
  }
  if (s.avoidLocators.length) {
    lines.push(`AVOID these locator patterns: ${s.avoidLocators.join(', ')}`);
  }

  if (s.helpers.length) {
    lines.push('');
    lines.push('REUSABLE HELPERS (import & call these — do NOT re-implement):');
    for (const h of s.helpers) lines.push(`  - ${h.name}(${h.params}) from ${h.filePath}`);
  }
  if (s.pageObjects.length) {
    lines.push('');
    lines.push('PAGE OBJECTS (reuse these classes & methods):');
    for (const po of s.pageObjects) lines.push(`  - ${po.name}${po.methods.length ? ` [${po.methods.join(', ')}]` : ''} from ${po.filePath}`);
  }
  if (s.fixtures.length) {
    lines.push('');
    lines.push('FIXTURES:');
    for (const f of s.fixtures) lines.push(`  - ${f.name} from ${f.filePath}`);
  }

  const folders = Object.entries(s.folders).filter(([, v]) => !!v).map(([k, v]) => `${k}=${v}`);
  if (folders.length) lines.push(`\nFolder layout: ${folders.join(', ')}`);

  lines.push('');
  lines.push('RULES: match the imports, structure, assertion style and locator strategy above so the new tests fit the suite and do NOT break existing tests.');
  lines.push('--- END REPO PATTERN GUIDE ---');
  return lines.join('\n');
}
