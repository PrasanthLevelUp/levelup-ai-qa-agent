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
import { categorizeHelpers } from '../context/reusable-helpers';

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
  /**
   * How the repo reports step progress — 'test-step' | 'console-log' |
   * 'annotations' | 'logger' | 'none' | 'mixed'. Generation mirrors this so
   * emitted scripts log the way the team already does (e.g. test.step blocks).
   */
  loggingStyle: string;
  /** All logging mechanisms observed, most-used first. */
  loggingStyles: string[];
  /**
   * How the repo synchronizes with the app — 'web-first-assertions' |
   * 'load-state' | 'locator-waitfor' | 'response-wait' | 'fixed-timeout' |
   * 'none' | 'mixed'. Generation adopts this instead of guessing waits.
   */
  waitStyle: string;
  /** All wait strategies observed, most-used first. */
  waitStyles: string[];
  /** True when the repo contains the waitForTimeout hard-sleep anti-pattern. */
  usesFixedTimeouts: boolean;
  quoteStyle: 'single' | 'double';
  semicolons: boolean;
  /** Preferred locator patterns, most-used first. */
  preferredLocators: string[];
  /** Anti-patterns the repo avoids. */
  avoidLocators: string[];
  /** Reusable helpers to import instead of re-implementing. */
  helpers: Array<{ name: string; params: string; filePath: string }>;
  /**
   * Helpers bucketed by purpose so generation can REUSE the right existing
   * project method instead of emitting new raw Playwright code. Each bucket is
   * a subset of `helpers` (a helper may appear in at most one bucket; anything
   * not classified lands in `utilityHelpers`).
   */
  assertionHelpers: Array<{ name: string; params: string; filePath: string }>;
  waitHelpers: Array<{ name: string; params: string; filePath: string }>;
  loggerHelpers: Array<{ name: string; params: string; filePath: string }>;
  dataAccessHelpers: Array<{ name: string; params: string; filePath: string }>;
  utilityHelpers: Array<{ name: string; params: string; filePath: string }>;
  /**
   * The repo's existing logger implementation to import & call (e.g. a `logger`
   * util or a `log()` function) instead of using console.log. Null when none.
   */
  loggerImpl: { name: string; filePath: string } | null;
  /** Page objects to reuse. */
  pageObjects: Array<{ name: string; filePath: string; methods: string[] }>;
  /** Fixtures available. */
  fixtures: Array<{ name: string; filePath: string }>;
  /** Data files discovered in the repo (json/csv). */
  dataFiles: Array<{ name: string; path: string; type: string; recordCount?: number }>;
  /** Environment configuration (dotenv, env files, config module). */
  environment: { envFiles: string[]; usesDotenv: boolean; configModule: string | null; envVars: string[] } | null;
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
    dataFiles: (profile.dataFiles || []).map((df) => `${df.name}@${df.path}`),
    environment: profile.environment
      ? `${profile.environment.envFiles.join(',')}|${profile.environment.usesDotenv}|${profile.environment.configModule || ''}|${profile.environment.envVars.join(',')}`
      : null,
    preferredLocators: (profile.preferredLocators || []).map((l) => `${l.pattern}|${l.example ?? ''}`),
    avoidPatterns: profile.avoidPatterns || [],
    style: s
      ? `${s.namingConvention}|${s.testNaming}|${s.stepStyle}|${s.quoteStyle}|${s.semicolons}|${s.tagConvention}|${s.loggingStyle ?? ''}|${(s.loggingStyles || []).join(',')}|${s.waitStyle ?? ''}|${(s.waitStyles || []).join(',')}|${s.usesFixedTimeouts ?? ''}`
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

  const dataFiles = (profile.dataFiles || [])
    .slice(0, 10)
    .map((df) => ({
      name: df.name,
      path: df.path,
      type: df.type,
      recordCount: df.recordCount,
    }));

  const environment = profile.environment || null;

  const folders = {
    tests: profile.folderStructure?.testFolder || undefined,
    pages: profile.folderStructure?.pageObjectFolder || undefined,
    fixtures: profile.folderStructure?.fixtureFolder || undefined,
    utils: profile.folderStructure?.utilsFolder || undefined,
  };

  const buckets = categorizeHelpers(profile);

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
  if (dataFiles.length) confidence += 5;
  if (environment?.envFiles?.length || environment?.usesDotenv) confidence += 5;
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
    loggingStyle: style?.loggingStyle || 'none',
    loggingStyles: style?.loggingStyles || [],
    waitStyle: style?.waitStyle || 'none',
    waitStyles: style?.waitStyles || [],
    usesFixedTimeouts: style?.usesFixedTimeouts ?? false,
    quoteStyle,
    semicolons,
    preferredLocators,
    avoidLocators: (profile.avoidPatterns || []).slice(0, 5),
    helpers,
    assertionHelpers: buckets.assertion,
    waitHelpers: buckets.wait,
    loggerHelpers: buckets.logger,
    dataAccessHelpers: buckets.data,
    utilityHelpers: buckets.utility,
    loggerImpl: buckets.loggerImpl,
    pageObjects,
    fixtures,
    dataFiles,
    environment,
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

/**
 * Concrete, copy-pasteable guidance for the detected step-logging style.
 * Returns null when there's nothing useful to instruct (style 'none').
 */
function describeLoggingStyle(style: string): string[] | null {
  switch (style) {
    case 'test-step':
      return [
        "- Wrap each logical phase in a Playwright step so reports stay readable:",
        "    await test.step('Open Login Page', async () => { /* ... */ });",
        "    await test.step('Verify error message', async () => { /* ... */ });",
      ];
    case 'console-log':
      return [
        '- Emit a console.log breadcrumb before each phase:',
        "    console.log('Logging in using locked user');",
      ];
    case 'annotations':
      return [
        '- Tag tests with structured annotations the reporter surfaces:',
        "    test.info().annotations.push({ type: 'TestCase', description: 'TC1392' });",
      ];
    case 'logger':
      return ['- Use the repo logger util for progress (e.g. logger.info(...)/log.step(...)) — import it, do NOT use console.log.'];
    case 'mixed':
      return ["- The repo mixes test.step() and console.log — prefer test.step() blocks (richest reports) for new tests."];
    default:
      return null;
  }
}

/**
 * Concrete, copy-pasteable guidance for the detected synchronization style.
 * Returns null only when nothing meaningful was detected.
 */
function describeWaitStyle(style: string): string[] | null {
  switch (style) {
    case 'web-first-assertions':
      return [
        '- Rely on auto-waiting web-first assertions instead of manual waits:',
        '    await expect(loginPage.errorBanner).toBeVisible();',
        '    await expect(usernameInput).toBeEditable();',
      ];
    case 'load-state':
      return [
        '- Synchronize on load state after navigation/submit:',
        "    await page.waitForLoadState('networkidle');",
      ];
    case 'locator-waitfor':
      return [
        '- Use explicit element waits (ideally inside Page Objects):',
        '    await this.username.waitFor();',
      ];
    case 'response-wait':
      return [
        '- Synchronize on the network response that drives the UI:',
        "    await page.waitForResponse(r => r.url().includes('/login'));",
      ];
    case 'fixed-timeout':
      return ['- The repo uses fixed sleeps, but DO NOT replicate them — use web-first assertions / waitForLoadState instead.'];
    case 'mixed':
      return ['- The repo mixes wait strategies — prefer web-first assertions, fall back to waitForLoadState/locator.waitFor for sync.'];
    default:
      return null;
  }
}

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

  // STEP LOGGING — mirror the repo's progress-reporting mechanism so reviewers
  // see familiar output. Concrete snippet keyed to the detected dominant style.
  const loggingGuidance = describeLoggingStyle(s.loggingStyle);
  if (loggingGuidance) {
    lines.push('');
    lines.push(`STEP LOGGING — the repo reports progress via ${s.loggingStyle}${s.loggingStyles.length > 1 ? ` (also: ${s.loggingStyles.filter(x => x !== s.loggingStyle).join(', ')})` : ''}. Match it:`);
    for (const g of loggingGuidance) lines.push(`  ${g}`);
  }

  // SYNCHRONIZATION — adopt the repo's waiting discipline; never inject hard sleeps.
  const waitGuidance = describeWaitStyle(s.waitStyle);
  if (waitGuidance) {
    lines.push('');
    lines.push(`SYNCHRONIZATION — the repo waits via ${s.waitStyle}${s.waitStyles.length > 1 ? ` (also: ${s.waitStyles.filter(x => x !== s.waitStyle).join(', ')})` : ''}. Match it:`);
    for (const g of waitGuidance) lines.push(`  ${g}`);
  }
  // Always forbid the anti-pattern — explicitly louder if the repo already has it.
  lines.push(s.usesFixedTimeouts
    ? '  - NOTE: the repo contains page.waitForTimeout() hard sleeps — do NOT copy them; replace with web-first assertions / waitForLoadState.'
    : '  - NEVER use page.waitForTimeout() / fixed sleeps; rely on auto-waiting assertions and explicit element/load-state waits.');

  if (s.preferredLocators.length) {
    lines.push('');
    lines.push('PREFERRED LOCATORS (most-used first — prefer these strategies):');
    for (const l of s.preferredLocators) lines.push(`  - ${l}`);
  }
  if (s.avoidLocators.length) {
    lines.push(`AVOID these locator patterns: ${s.avoidLocators.join(', ')}`);
  }

  // -------------------------------------------------------------------------
  // REUSE-FIRST CATALOG — the single most important section. The generator must
  // PREFER calling these existing project methods over emitting new raw
  // Playwright code. Helpers are grouped by purpose so the right reusable is
  // obvious for each kind of step (assert / wait / log / data / generic).
  // -------------------------------------------------------------------------
  const fmtHelpers = (hs: Array<{ name: string; params: string; filePath: string }>) =>
    hs.map((h) => `  - ${h.name}(${h.params}) from ${h.filePath}`);
  const anyReusable =
    s.pageObjects.length || s.helpers.length || s.fixtures.length ||
    s.assertionHelpers.length || s.waitHelpers.length || s.loggerHelpers.length ||
    s.dataAccessHelpers.length || s.utilityHelpers.length;

  if (anyReusable) {
    lines.push('');
    lines.push('=== REUSE EXISTING PROJECT CODE (HIGHEST PRIORITY) ===');
    lines.push('ALWAYS prefer calling the existing methods/helpers below over writing new raw');
    lines.push('Playwright code. Only write new low-level code when NO existing method fits.');
  }

  if (s.pageObjects.length) {
    lines.push('');
    lines.push('PAGE OBJECTS (instantiate & call these classes/methods — do NOT inline raw locators/fills):');
    for (const po of s.pageObjects) lines.push(`  - ${po.name}${po.methods.length ? ` [${po.methods.join(', ')}]` : ''} from ${po.filePath}`);
  }
  if (s.assertionHelpers.length) {
    lines.push('');
    lines.push('ASSERTION HELPERS (call these instead of hand-writing expect(...) chains):');
    lines.push(...fmtHelpers(s.assertionHelpers));
  }
  if (s.waitHelpers.length) {
    lines.push('');
    lines.push('WAIT / SYNCHRONIZATION HELPERS (call these instead of new waits or hard sleeps):');
    lines.push(...fmtHelpers(s.waitHelpers));
  }
  if (s.loggerImpl || s.loggerHelpers.length) {
    lines.push('');
    lines.push('LOGGER (use the repo logger for progress — do NOT use console.log):');
    if (s.loggerImpl) lines.push(`  - import ${s.loggerImpl.name} from ${s.loggerImpl.filePath} and call it (e.g. ${s.loggerImpl.name}.info(...) / ${s.loggerImpl.name}(...))`);
    for (const h of s.loggerHelpers) if (!s.loggerImpl || h.name !== s.loggerImpl.name) lines.push(`  - ${h.name}(${h.params}) from ${h.filePath}`);
  }
  if (s.dataAccessHelpers.length) {
    lines.push('');
    lines.push('TEST DATA ACCESS (resolve dataset values through these — do NOT hardcode credentials/data):');
    lines.push(...fmtHelpers(s.dataAccessHelpers));
  }
  if (s.fixtures.length) {
    lines.push('');
    lines.push('FIXTURES (consume these via the test signature instead of manual setup):');
    for (const f of s.fixtures) lines.push(`  - ${f.name} from ${f.filePath}`);
  }
  if (s.utilityHelpers.length) {
    lines.push('');
    lines.push('UTILITY HELPERS (reuse for common operations — do NOT re-implement):');
    lines.push(...fmtHelpers(s.utilityHelpers));
  }

  if (s.dataFiles.length) {
    lines.push('');
    lines.push('TEST DATA FILES (import and use these instead of hardcoded values):');
    for (const df of s.dataFiles) {
      const count = df.recordCount != null ? ` (${df.recordCount} record${df.recordCount === 1 ? '' : 's'})` : '';
      lines.push(`  - ${df.name}${count} at ${df.path}`);
    }
  }

  if (s.environment) {
    lines.push('');
    lines.push('ENVIRONMENT CONFIG:');
    if (s.environment.envFiles.length) {
      lines.push(`  - Env files: ${s.environment.envFiles.join(', ')}`);
    }
    if (s.environment.usesDotenv) {
      lines.push(`  - Uses dotenv: true`);
    }
    if (s.environment.configModule) {
      lines.push(`  - Config module: ${s.environment.configModule} (import env vars from here)`);
    }
    if (s.environment.envVars.length) {
      lines.push(`  - Env vars: ${s.environment.envVars.slice(0, 8).join(', ')}`);
    }
  }

  const folders = Object.entries(s.folders).filter(([, v]) => !!v).map(([k, v]) => `${k}=${v}`);
  if (folders.length) lines.push(`\nFolder layout: ${folders.join(', ')}`);

  lines.push('');
  lines.push('RULES:');
  lines.push('  1. REUSE FIRST — call the existing Page Object methods, assertion/wait/logger/data-access helpers and fixtures above instead of writing new raw Playwright code. Generate new low-level code ONLY when no existing method fits.');
  lines.push('  2. Match the imports, structure, assertion style and locator strategy above so the new tests fit the suite and do NOT break existing tests.');
  lines.push('--- END REPO PATTERN GUIDE ---');
  return lines.join('\n');
}
