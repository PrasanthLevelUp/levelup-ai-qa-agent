/**
 * Repository Context Engine
 *
 * The brain of the platform. Scans a repository, runs AST analysis,
 * and produces a RepositoryProfile — a structured intelligence profile
 * that enriches every downstream feature:
 *   - Script generation: reuse existing helpers, match coding style
 *   - Healing: understand locator conventions, avoid wrong patterns
 *   - RCA: correlate failures with code structure
 *   - Coverage: know what's tested vs what's missing
 *
 * This is the single most important engine in the platform.
 */

import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../utils/logger';
import { FEATURE_FLAGS } from '../config/features';
import { ASTAnalyzer } from './ast-analyzer';
import type {
  RepositoryProfile,
  FileAnalysis,
  FunctionSignature,
  ClassInfo,
  FolderStructure,
  CodingStyle,
  BusinessFlow,
  TestSuiteInfo,
  TestInventoryEntry,
  TestFramework,
  Language,
  TestPattern,
  LocatorStrategy,
  CodeChunk,
} from './types';

const MOD = 'repo-context-engine';

/* ------------------------------------------------------------------ */
/*  Framework Detection                                                */
/* ------------------------------------------------------------------ */

function detectFramework(repoRoot: string, analyses: FileAnalysis[]): TestFramework {
  // Check package.json
  const pkgPath = path.join(repoRoot, 'package.json');
  let pkg: any = {};
  if (fs.existsSync(pkgPath)) {
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); } catch {}
  }

  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  if (allDeps['@playwright/test'] || allDeps['playwright']) return 'playwright';
  if (allDeps['cypress']) return 'cypress';
  if (allDeps['selenium-webdriver'] || allDeps['webdriver']) return 'selenium';
  if (allDeps['puppeteer'] || allDeps['puppeteer-core']) return 'puppeteer';
  if (allDeps['webdriverio'] || allDeps['@wdio/cli']) return 'webdriverio';
  if (allDeps['testcafe']) return 'testcafe';

  // Check config files
  const configPatterns: Array<{ pattern: string; framework: TestFramework }> = [
    { pattern: 'playwright.config', framework: 'playwright' },
    { pattern: 'cypress.config', framework: 'cypress' },
    { pattern: 'wdio.conf', framework: 'webdriverio' },
    { pattern: '.testcaferc', framework: 'testcafe' },
  ];

  for (const { pattern, framework } of configPatterns) {
    const found = analyses.some(a => a.relativePath.includes(pattern));
    if (found) return framework;
  }

  // Check imports
  const allImports = analyses.flatMap(a => a.imports);
  if (allImports.some(i => i.module.includes('@playwright/test'))) return 'playwright';
  if (allImports.some(i => i.module === 'cypress')) return 'cypress';
  if (allImports.some(i => i.module.includes('selenium'))) return 'selenium';
  if (allImports.some(i => i.module.includes('puppeteer'))) return 'puppeteer';

  // Check jest/mocha as fallback
  if (allDeps['jest'] || allDeps['@jest/globals']) return 'jest';
  if (allDeps['mocha']) return 'mocha';

  return 'unknown';
}

/* ------------------------------------------------------------------ */
/*  Language Detection (primary)                                       */
/* ------------------------------------------------------------------ */

function detectPrimaryLanguage(analyses: FileAnalysis[]): Language {
  const counts: Record<Language, number> = {
    typescript: 0, javascript: 0, python: 0, java: 0, csharp: 0, unknown: 0,
  };
  for (const a of analyses) counts[a.language]++;
  return (Object.entries(counts)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || 'unknown') as Language;
}

/* ------------------------------------------------------------------ */
/*  Pre-scan Language Guard (Phase 1)                                  */
/* ------------------------------------------------------------------ */

/** Languages the AST analyzer can actually parse today. */
export const SUPPORTED_LANGUAGES: Language[] = ['typescript', 'javascript'];

/** Marker error so the API layer can map this to a 400 / UNSUPPORTED_LANGUAGE. */
export class UnsupportedLanguageError extends Error {
  readonly detectedLanguage: Language;
  readonly supportedLanguages: Language[];
  constructor(detectedLanguage: Language) {
    super(
      `Repository language '${detectedLanguage}' is not currently supported.\n` +
      `Supported languages: ${SUPPORTED_LANGUAGES.join(', ')}.\n` +
      `Support for Python, Java, and C# is planned for a future phase.`
    );
    this.name = 'UnsupportedLanguageError';
    this.detectedLanguage = detectedLanguage;
    this.supportedLanguages = SUPPORTED_LANGUAGES;
  }
}

/**
 * Detect a repository's primary language from project marker files *before*
 * running AST analysis. The AST analyzer only walks .ts/.tsx/.js/.jsx/.mjs/.cjs,
 * so a Python/Java/C# repo would otherwise scan to an empty, misleading profile
 * (Repo Intelligence Audit, Finding F2). This guard lets us fail loudly instead.
 *
 * Precedence: explicit JS/TS markers win (package.json / tsconfig / lockfiles),
 * then Python, Java, C# markers. Falls back to a shallow source-file extension
 * scan, and finally 'unknown'.
 */
export function detectRepoLanguage(repoRoot: string): Language {
  const has = (rel: string): boolean => {
    try { return fs.existsSync(path.join(repoRoot, rel)); } catch { return false; }
  };

  // 1) JavaScript / TypeScript — strongest signals.
  if (has('tsconfig.json')) return 'typescript';
  if (has('package.json')) {
    // A package.json with a typescript dep / tsconfig means TS, else JS.
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps && (deps.typescript || deps['ts-node'])) return 'typescript';
    } catch { /* ignore malformed package.json */ }
    return 'javascript';
  }

  // 2) Python markers.
  if (has('requirements.txt') || has('setup.py') || has('pyproject.toml') || has('Pipfile')) {
    return 'python';
  }

  // 3) Java markers.
  if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) {
    return 'java';
  }

  // 4) C# markers (glob — *.csproj / *.sln at repo root).
  try {
    const rootEntries = fs.readdirSync(repoRoot);
    if (rootEntries.some(f => f.endsWith('.csproj') || f.endsWith('.sln'))) return 'csharp';
  } catch { /* ignore */ }

  // 5) Fallback: shallow scan for the dominant source extension.
  const extCounts: Record<Language, number> = {
    typescript: 0, javascript: 0, python: 0, java: 0, csharp: 0, unknown: 0,
  };
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out']);
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.isDirectory()) continue;
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        walk(path.join(dir, e.name), depth + 1);
      } else {
        const n = e.name.toLowerCase();
        if (/\.(ts|tsx)$/.test(n)) extCounts.typescript++;
        else if (/\.(js|jsx|mjs|cjs)$/.test(n)) extCounts.javascript++;
        else if (/\.py$/.test(n)) extCounts.python++;
        else if (/\.java$/.test(n)) extCounts.java++;
        else if (/\.cs$/.test(n)) extCounts.csharp++;
      }
    }
  };
  walk(repoRoot, 0);
  const top = (Object.entries(extCounts) as Array<[Language, number]>)
    .sort((a, b) => b[1] - a[1])[0];
  return top && top[1] > 0 ? top[0] : 'unknown';
}

/* ------------------------------------------------------------------ */
/*  Test Pattern Detection                                             */
/* ------------------------------------------------------------------ */

function detectTestPattern(analyses: FileAnalysis[]): TestPattern {
  const hasPageObjects = analyses.some(a => a.hasPageObject);
  const hasFixtures = analyses.some(a => a.hasFixtures);
  const allImports = analyses.flatMap(a => a.imports);

  // BDD / Cucumber
  if (allImports.some(i => i.module.includes('cucumber') || i.module.includes('gherkin'))) {
    return 'bdd-cucumber';
  }

  // Page Object Model
  if (hasPageObjects) {
    return hasFixtures ? 'hybrid' : 'page-object-model';
  }

  // Keyword-driven
  const helperCount = analyses.reduce((s, a) => s + a.functions.filter(f => f.category === 'helper').length, 0);
  if (helperCount > 10) return 'hybrid';

  return 'flat-scripts';
}

/* ------------------------------------------------------------------ */
/*  Locator Strategy Detection                                         */
/* ------------------------------------------------------------------ */

function detectLocatorStrategy(analyses: FileAnalysis[]): LocatorStrategy {
  const locatorCounts: Record<string, number> = {};
  for (const a of analyses) {
    for (const p of a.locatorPatterns) {
      locatorCounts[p] = (locatorCounts[p] || 0) + 1;
    }
  }

  const sorted = Object.entries(locatorCounts).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) return 'mixed';

  const top = sorted[0][0];
  if (top === 'data-testid' || top === 'getByTestId') return 'data-testid';
  if (top === 'data-cy') return 'data-cy';
  if (top === 'data-test') return 'data-test';
  if (top === 'getByRole' || top === 'getByLabel') return 'role-based';
  if (top === 'xpath' || top === 'selenium-by') return 'xpath';
  if (top === 'css-locator' || top === 'cy.get' || top === '$-selector') return 'css-selectors';
  return 'mixed';
}

/* ------------------------------------------------------------------ */
/*  Folder Structure Detection                                         */
/* ------------------------------------------------------------------ */

function detectFolderStructure(repoRoot: string, analyses: FileAnalysis[]): FolderStructure {
  const testFolders = ['tests', 'test', 'specs', 'spec', 'e2e', '__tests__', 'cypress/e2e', 'cypress/integration'];
  const poFolders = ['pages', 'page-objects', 'pom', 'screens', 'page_objects'];
  const fixtureFolders = ['fixtures', 'support', 'data', 'test-data'];
  const utilFolders = ['utils', 'helpers', 'lib', 'common', 'shared'];
  // Test-data folder is detected independently of fixtures: a repo may keep
  // datasets in a dedicated `data/` (or `tests/data`) directory even when it
  // also has a `fixtures/` directory. Ordering matters — prefer the most
  // specific / conventional locations first.
  const testDataFolders = ['data', 'test-data', 'testdata', 'tests/data', 'test/data', 'fixtures/data', 'cypress/fixtures'];
  const apiFolders = ['api', 'apis', 'services', 'endpoints', 'clients', 'src/api'];

  const findFolder = (candidates: string[]): string | null => {
    for (const c of candidates) {
      if (fs.existsSync(path.join(repoRoot, c))) return c;
    }
    // Also check from file paths
    for (const a of analyses) {
      for (const c of candidates) {
        if (a.relativePath.startsWith(c + '/') || a.relativePath.startsWith(c + '\\')) return c;
      }
    }
    return null;
  };

  // Find config files
  const configFiles: string[] = [];
  const configPatterns = ['playwright.config', 'cypress.config', 'jest.config', 'wdio.conf', 'tsconfig', '.testcaferc', 'vitest.config'];
  for (const a of analyses) {
    if (configPatterns.some(p => a.relativePath.includes(p))) {
      configFiles.push(a.relativePath);
    }
  }

  // Find support/setup files
  const supportFiles: string[] = [];
  const supportPatterns = ['global-setup', 'global-teardown', 'setup', 'teardown', 'beforeAll', 'support/index'];
  for (const a of analyses) {
    if (supportPatterns.some(p => a.relativePath.toLowerCase().includes(p))) {
      supportFiles.push(a.relativePath);
    }
  }

  // ── Scaffold-file detection (Issue: scaffold files were always regenerated) ──
  // The AST analyzer only walks code files (.ts/.js), so README, .env*, and CI
  // workflow files were NEVER recorded in the profile. As a result the script
  // generator's `hasReadme`/`hasEnvExample`/`hasCIWorkflow` flags were always
  // false and the scaffold files got regenerated even when the repo had them.
  // We scan the filesystem directly so these files are captured in the profile.
  for (const f of detectScaffoldFiles(repoRoot)) {
    // README / .env style files live in configFiles so they're picked up by the
    // analyzer's `allKnownFiles()` helper; CI workflow files do too.
    if (!configFiles.includes(f) && !supportFiles.includes(f)) {
      configFiles.push(f);
    }
  }

  return {
    testFolder: findFolder(testFolders),
    pageObjectFolder: findFolder(poFolders),
    fixtureFolder: findFolder(fixtureFolders),
    utilsFolder: findFolder(utilFolders),
    testDataFolder: findFolder(testDataFolders),
    apiFolder: findFolder(apiFolders),
    configFiles,
    supportFiles,
  };
}

/**
 * Scan the repo root for scaffold files (README, .env*, CI workflows) that the
 * AST analyzer ignores. Returns repo-relative paths so the script generator can
 * detect their presence and avoid regenerating/overwriting them.
 */
function detectScaffoldFiles(repoRoot: string): string[] {
  const found: string[] = [];
  if (!repoRoot) return found;

  const safeExists = (p: string): boolean => {
    try {
      return fs.existsSync(path.join(repoRoot, p));
    } catch {
      return false;
    }
  };

  // 1. README — any common variant at the repo root.
  for (const readme of ['README.md', 'README.MD', 'readme.md', 'README', 'README.txt', 'README.rst']) {
    if (safeExists(readme)) {
      found.push(readme);
      break;
    }
  }

  // 2. Environment config — .env / .env.example / .env.sample etc.
  for (const env of ['.env', '.env.example', '.env.sample', '.env.template', '.env.local']) {
    if (safeExists(env)) found.push(env);
  }

  // 3. CI / pipeline definitions.
  const ciCandidates = ['.gitlab-ci.yml', 'Jenkinsfile', 'azure-pipelines.yml', 'bitbucket-pipelines.yml'];
  for (const ci of ciCandidates) {
    if (safeExists(ci)) found.push(ci);
  }
  // GitHub Actions: enumerate workflow files under .github/workflows.
  try {
    const wfDir = path.join(repoRoot, '.github', 'workflows');
    if (fs.existsSync(wfDir)) {
      const entries = fs.readdirSync(wfDir).filter(f => /\.(ya?ml)$/i.test(f));
      if (entries.length > 0) {
        for (const e of entries) found.push(`.github/workflows/${e}`);
      } else {
        // Directory exists even if empty — still a signal CI is managed here.
        found.push('.github/workflows');
      }
    }
  } catch {
    /* ignore */
  }

  return found;
}

/* ------------------------------------------------------------------ */
/*  Coding Style Detection                                             */
/* ------------------------------------------------------------------ */

function detectCodingStyle(repoRoot: string, analyses: FileAnalysis[]): CodingStyle {
  // Naming convention detection from function names
  const allFnNames = analyses.flatMap(a => a.functions.map(f => f.name));
  let camel = 0, snake = 0, kebab = 0, pascal = 0;
  for (const name of allFnNames) {
    if (/^[a-z][a-zA-Z0-9]*$/.test(name) && /[A-Z]/.test(name)) camel++;
    else if (/^[a-z][a-z0-9_]*$/.test(name) && name.includes('_')) snake++;
    else if (/^[A-Z][a-zA-Z0-9]*$/.test(name)) pascal++;
  }
  const namingConvention = camel >= snake && camel >= pascal ? 'camelCase'
    : snake >= camel && snake >= pascal ? 'snake_case'
    : pascal >= camel && pascal >= snake ? 'PascalCase' : 'mixed';

  // Test naming from test function arguments
  const testFiles = analyses.filter(a => a.testCount > 0);
  let testNaming = '';
  for (const tf of testFiles) {
    const content = fs.existsSync(path.join(repoRoot, tf.relativePath))
      ? fs.readFileSync(path.join(repoRoot, tf.relativePath), 'utf-8').slice(0, 5000)
      : '';
    if (/test\(['"]should\s/.test(content)) { testNaming = 'should_do_x_when_y'; break; }
    if (/test\(['"]TC\d/.test(content)) { testNaming = 'TC-code-descriptive'; break; }
    if (/it\(['"]/.test(content)) { testNaming = 'it-descriptive'; break; }
    if (/test\(['"]/.test(content)) { testNaming = 'test-descriptive'; break; }
  }

  // Step style
  let stepStyle: CodingStyle['stepStyle'] = 'flat';
  for (const tf of testFiles) {
    const content = fs.existsSync(path.join(repoRoot, tf.relativePath))
      ? fs.readFileSync(path.join(repoRoot, tf.relativePath), 'utf-8').slice(0, 5000)
      : '';
    if (/Given|When|Then/g.test(content)) { stepStyle = 'given_when_then'; break; }
    if (/\/\/\s*(arrange|act|assert)/i.test(content)) { stepStyle = 'arrange_act_assert'; break; }
  }

  // Tag convention
  let tagConvention: string | null = null;
  for (const tf of testFiles) {
    const content = fs.existsSync(path.join(repoRoot, tf.relativePath))
      ? fs.readFileSync(path.join(repoRoot, tf.relativePath), 'utf-8').slice(0, 3000)
      : '';
    const tagMatch = /@(smoke|regression|sanity|critical|e2e|api|ui)/i.exec(content);
    if (tagMatch) { tagConvention = `@${tagMatch[1]}`; break; }
    // Playwright tag() pattern
    if (/\.tag\(/.test(content)) { tagConvention = 'playwright-tag()'; break; }
  }

  // Indent/quote/semicolon via majority vote across multiple sampled files
  // (Repo Intelligence Audit, Finding F5 — single-file sampling was unreliable).
  // Prefer test files; fall back to any analysed source files so non-test repos
  // still get a useful read. Each file casts one vote per dimension.
  const styleSampleSource = (testFiles.length > 0 ? testFiles : analyses);
  const sampleFiles = styleSampleSource.slice(0, 10);

  const votes = {
    indent: { 'spaces-2': 0, 'spaces-4': 0, tabs: 0 } as Record<CodingStyle['indentStyle'], number>,
    quote: { single: 0, double: 0, mixed: 0 } as Record<CodingStyle['quoteStyle'], number>,
    semicolons: 0,
    noSemicolons: 0,
  };

  for (const f of sampleFiles) {
    const fp = path.join(repoRoot, f.relativePath);
    if (!fs.existsSync(fp)) continue;
    let content = '';
    try { content = fs.readFileSync(fp, 'utf-8'); } catch { continue; }
    if (!content.trim()) continue;

    // Indentation: count indented lines by kind, vote for this file's dominant.
    const tabIndent = (content.match(/^\t+\S/gm) || []).length;
    const fourIndent = (content.match(/^ {4}\S/gm) || []).length;
    const twoIndent = (content.match(/^ {2}\S/gm) || []).length;
    if (tabIndent > fourIndent && tabIndent > twoIndent) votes.indent.tabs++;
    else if (fourIndent > twoIndent) votes.indent['spaces-4']++;
    else votes.indent['spaces-2']++;

    // Quotes: per-file majority, with a 'mixed' bucket when neither dominates.
    const singles = (content.match(/'/g) || []).length;
    const doubles = (content.match(/"/g) || []).length;
    if (doubles > singles * 1.5) votes.quote.double++;
    else if (singles > doubles * 1.5) votes.quote.single++;
    else votes.quote.mixed++;

    // Semicolons: share of meaningful lines ending in ';'.
    const lines = content.split('\n').filter(l => l.trim().length > 10);
    if (lines.length > 0) {
      const withSemi = lines.filter(l => l.trimEnd().endsWith(';')).length;
      if (withSemi > lines.length * 0.4) votes.semicolons++;
      else votes.noSemicolons++;
    }
  }

  const pickMax = <T extends string>(rec: Record<T, number>, fallback: T): T => {
    let best = fallback; let bestN = -1;
    for (const [k, n] of Object.entries(rec) as Array<[T, number]>) {
      if (n > bestN) { bestN = n; best = k; }
    }
    return best;
  };

  const indentStyle: CodingStyle['indentStyle'] = pickMax(votes.indent, 'spaces-2');
  const quoteStyle: CodingStyle['quoteStyle'] = pickMax(votes.quote, 'single');
  const semicolons = votes.semicolons >= votes.noSemicolons;

  // ── Logging & wait conventions (Repo Intelligence — "attentional" signals) ──
  // We tally, across ALL analysed test/source files, how many files use each
  // step-logging mechanism and each synchronization strategy. Ranking by file
  // frequency (not raw occurrence count) keeps a single noisy file from
  // dominating, mirroring how `preferredLocators` is ranked elsewhere.
  const { loggingStyle, loggingStyles } = detectLoggingStyle(analyses);
  const { waitStyle, waitStyles, usesFixedTimeouts } = detectWaitStyle(analyses);

  logger.info(MOD, 'Coding-style detection (multi-file majority vote)', {
    filesSampled: sampleFiles.length,
    indentStyle, quoteStyle, semicolons, votes,
    loggingStyle, loggingStyles, waitStyle, waitStyles, usesFixedTimeouts,
  });

  return {
    namingConvention,
    testNaming: testNaming || 'unknown',
    stepStyle,
    tagConvention,
    indentStyle,
    quoteStyle,
    semicolons,
    loggingStyle,
    loggingStyles,
    waitStyle,
    waitStyles,
    usesFixedTimeouts,
  };
}

/**
 * Rank the step-logging mechanisms used across the repo by how many files use
 * each one. Returns the dominant style plus the full ranked list. `test.step`
 * wins ties over `console.log` because it produces the richest Playwright
 * reports — when a repo uses both, mirroring `test.step` is the better choice.
 */
function detectLoggingStyle(analyses: FileAnalysis[]): {
  loggingStyle: CodingStyle['loggingStyle'];
  loggingStyles: CodingStyle['loggingStyles'];
} {
  const order: Array<CodingStyle['loggingStyle']> = ['test-step', 'annotations', 'logger', 'console-log'];
  const counts: Record<string, number> = {};
  for (const a of analyses) {
    for (const label of a.loggingPatterns || []) {
      counts[label] = (counts[label] || 0) + 1;
    }
  }
  const ranked = Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || order.indexOf(a[0] as any) - order.indexOf(b[0] as any))
    .map(([label]) => label as CodingStyle['loggingStyle']);

  if (ranked.length === 0) return { loggingStyle: 'none', loggingStyles: [] };
  // 'mixed' only when the top two mechanisms appear in the SAME number of files
  // (a genuine tie). A clear leader is honoured so generation has a confident
  // target rather than defaulting to ambiguous 'mixed'.
  const top = ranked[0];
  const second = ranked[1];
  const tie = second != null && counts[top] === counts[second];
  return { loggingStyle: tie ? 'mixed' : top, loggingStyles: ranked };
}

/**
 * Rank synchronization strategies across the repo by file frequency. The
 * `fixed-timeout` anti-pattern is tracked separately (so we can warn) and is
 * never chosen as the dominant style unless it is the ONLY thing the repo uses.
 */
function detectWaitStyle(analyses: FileAnalysis[]): {
  waitStyle: CodingStyle['waitStyle'];
  waitStyles: CodingStyle['waitStyles'];
  usesFixedTimeouts: boolean;
} {
  const order: Array<CodingStyle['waitStyle']> = [
    'web-first-assertions', 'load-state', 'locator-waitfor', 'response-wait', 'fixed-timeout',
  ];
  const counts: Record<string, number> = {};
  for (const a of analyses) {
    for (const label of a.waitPatterns || []) {
      counts[label] = (counts[label] || 0) + 1;
    }
  }
  const usesFixedTimeouts = (counts['fixed-timeout'] || 0) > 0;

  const ranked = Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || order.indexOf(a[0] as any) - order.indexOf(b[0] as any))
    .map(([label]) => label as CodingStyle['waitStyle']);

  if (ranked.length === 0) return { waitStyle: 'none', waitStyles: [], usesFixedTimeouts };

  // Pick the dominant *good* strategy; only fall back to 'fixed-timeout' as the
  // headline style when it is literally the only strategy present.
  const goodRanked = ranked.filter((s) => s !== 'fixed-timeout');
  const waitStyle: CodingStyle['waitStyle'] = goodRanked.length ? goodRanked[0] : 'fixed-timeout';
  return { waitStyle, waitStyles: ranked, usesFixedTimeouts };
}

/* ------------------------------------------------------------------ */
/*  Business Flow Extraction                                           */
/* ------------------------------------------------------------------ */

/**
 * Turn a camelCase / snake_case method name into a human-readable step label.
 * e.g. `addProductToCart` → "Add product to cart", `verify_order` → "Verify order".
 */
function humanizeMethod(method: string): string {
  const words = method
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function extractBusinessFlows(repoRoot: string, analyses: FileAnalysis[]): BusinessFlow[] {
  const flows: BusinessFlow[] = [];
  const testFiles = analyses.filter(a => a.testCount > 0);

  for (const tf of testFiles) {
    const fullPath = path.join(repoRoot, tf.relativePath);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, 'utf-8');

    // Extract describe/test blocks with their text
    const describeMatch = /(?:test\.describe|describe)\s*\(\s*['"`]([^'"`]+)['"`]/g;
    const testMatch = /(?:test|it)\s*\(\s*['"`]([^'"`]+)['"`]/g;
    const describes: string[] = [];
    const tests: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = describeMatch.exec(content)) !== null) describes.push(m[1]);
    while ((m = testMatch.exec(content)) !== null) tests.push(m[1]);

    // Detect flow category from names
    const allText = (describes.join(' ') + ' ' + tests.join(' ')).toLowerCase();
    let category: BusinessFlow['category'] = 'general';
    if (/login|auth|sign.?in|credential|session|logout/.test(allText)) category = 'auth';
    else if (/navigat|menu|sidebar|breadcrumb|route|page/.test(allText)) category = 'navigation';
    else if (/create|add|edit|update|delete|remove|crud/.test(allText)) category = 'crud';
    else if (/search|filter|find|query/.test(allText)) category = 'search';
    else if (/pay|checkout|cart|order|purchase/.test(allText)) category = 'payment';
    else if (/form|input|submit|validation/.test(allText)) category = 'form';
    else if (/admin|setting|config|role|permission/.test(allText)) category = 'admin';

    // Extract steps from Playwright actions
    const steps: string[] = [];
    const actionPatterns = [
      { regex: /page\.goto\s*\(\s*['"`]([^'"`]+)['"`]/g, template: 'Navigate to {0}' },
      { regex: /page\.fill\s*\([^,]+,\s*['"`]([^'"`]*)['"`]/g, template: 'Fill field with "{0}"' },
      { regex: /page\.click\s*\(\s*['"`]([^'"`]+)['"`]/g, template: 'Click on {0}' },
      { regex: /getByRole\(['"`]([^'"`]+)['"`].*?name:\s*[/'"`]([^/'"`]+)/g, template: 'Interact with {0} "{1}"' },
      { regex: /expect\(.*?\)\.toBeVisible/g, template: 'Verify element is visible' },
      { regex: /expect\(.*?\)\.toContainText\(\s*['"`]([^'"`]+)['"`]/g, template: 'Verify text contains "{0}"' },
      { regex: /expect\(page\)\.toHaveURL\(\s*[/'"`]([^/'"`]+)/g, template: 'Verify URL matches {0}' },
      { regex: /waitForSelector\s*\(\s*['"`]([^'"`]+)['"`]/g, template: 'Wait for {0}' },
    ];

    for (const { regex, template } of actionPatterns) {
      const r = new RegExp(regex.source, regex.flags);
      while ((m = r.exec(content)) !== null) {
        const step = template.replace(/\{(\d+)\}/g, (_, idx) => m![parseInt(idx) + 1] || '');
        if (!steps.includes(step)) steps.push(step);
      }
    }

    // Page-Object-Model step extraction. POM-style tests delegate actions to
    // page object methods (e.g. `loginPage.login(...)`) rather than calling
    // `page.click/fill` directly, so the literal-action patterns above miss
    // them entirely. Map page-object instances → their method calls in source
    // order so the flow reads like "Login → Add product to cart → Checkout".
    const pomInstances = new Map<string, string>(); // varName -> PageClass
    const newRe = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$]*)\s*\(/g;
    while ((m = newRe.exec(content)) !== null) {
      pomInstances.set(m[1], m[2]);
    }
    if (pomInstances.size > 0) {
      const callRe = /\b([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*\(/g;
      while ((m = callRe.exec(content)) !== null) {
        const [, recv, method] = m;
        if (!pomInstances.has(recv)) continue;
        if (method === 'constructor') continue;
        const step = `${humanizeMethod(method)} (${pomInstances.get(recv)}.${method})`;
        if (!steps.includes(step)) steps.push(step);
      }
    }

    // Navigation with a non-literal target (e.g. `page.goto(env.baseUrl)`).
    const gotoVarRe = /page\.goto\s*\(\s*([A-Za-z_$][\w$.]*)\s*[),]/g;
    while ((m = gotoVarRe.exec(content)) !== null) {
      const step = `Navigate to ${m[1]}`;
      if (!steps.includes(step)) steps.push(step);
    }

    // Find URL if available (string literal first, then a variable reference).
    const urlMatch = /page\.goto\s*\(\s*['"`]([^'"`]+)['"`]/.exec(content);
    const urlVarMatch = /page\.goto\s*\(\s*([A-Za-z_$][\w$.]*)\s*[),]/.exec(content);
    const entryUrl = urlMatch?.[1] || urlVarMatch?.[1] || null;

    // Find related helpers (imported functions from relative paths)
    const relatedHelpers = tf.imports
      .filter(i => i.isRelative)
      .flatMap(i => i.namedImports);

    if (describes.length > 0 || tests.length > 0) {
      flows.push({
        name: describes[0] || tests[0] || path.basename(tf.relativePath, path.extname(tf.relativePath)),
        steps: steps.slice(0, 30), // cap at 30 steps
        relatedFiles: [tf.relativePath],
        relatedHelpers,
        entryUrl,
        category,
      });
    }
  }

  return flows;
}

/* ------------------------------------------------------------------ */
/*  Repository Test Inventory (Sprint RCI-1)                          */
/*                                                                     */
/*  Deterministic per-test inventory built from the SAME AST pass that */
/*  produced `analyses` — no second scanner, no LLM, no embeddings, no  */
/*  generation. Classifies each test into feature/flow/page buckets and */
/*  assigns a transparent, signal-based confidence score. This is one  */
/*  more OUTPUT of the Repository Context Engine, persisted on the      */
/*  RepositoryProfile and surfaced in the Repository Intelligence UI.   */
/* ------------------------------------------------------------------ */

/** Deterministic keyword → feature bucket. Order matters (first match wins). */
const INVENTORY_FEATURE_KEYWORDS: Array<[RegExp, string]> = [
  [/\b(login|log ?in|sign ?in|logout|log ?out|sign ?out|auth|credential|password|session)\b/i, 'Authentication'],
  [/\b(checkout|payment|billing|order|purchase|pay)\b/i, 'Checkout'],
  [/\b(cart|basket|add to cart|shopping)\b/i, 'Cart'],
  [/\b(product|inventory|catalog|item|listing|browse)\b/i, 'Products'],
  [/\b(search|filter|sort|query)\b/i, 'Search'],
  [/\b(register|signup|sign ?up|onboard|account creation)\b/i, 'Registration'],
  [/\b(profile|account|settings|preferences)\b/i, 'Account'],
  [/\b(navigat|redirect|route|menu|link)\b/i, 'Navigation'],
  [/\b(api|endpoint|request|response|status code)\b/i, 'API'],
  [/\b(form|input|field|validation|submit)\b/i, 'Forms'],
];

/** Deterministic keyword → user flow. */
const INVENTORY_FLOW_KEYWORDS: Array<[RegExp, string]> = [
  [/\blogout|log ?out|sign ?out\b/i, 'logout'],
  [/\blogin|log ?in|sign ?in|authenticat/i, 'login'],
  [/\bcheckout|complete (the )?(purchase|order)|place order\b/i, 'checkout'],
  [/\badd .*cart|add to cart\b/i, 'add-to-cart'],
  [/\bremove .*cart\b/i, 'remove-from-cart'],
  [/\bregister|sign ?up|create .*account\b/i, 'registration'],
  [/\bsearch|filter|sort\b/i, 'search'],
  [/\bnavigat|redirect|go to\b/i, 'navigation'],
];

function invTitleCase(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Strip trailing "— 16 scenarios", "(smoke)", counts, etc. from a describe title. */
function cleanDescribeLabel(title: string): string {
  return title
    .replace(/[—–-]\s*\d+\s*scenario.*$/i, '')
    .replace(/\(\s*\d+\s*(tests?|scenarios?)\s*\)\s*$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** True if a describe title is a short noun-ish label, not a full sentence. */
function isCleanLabel(title: string): boolean {
  const cleaned = cleanDescribeLabel(title);
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return false;
  if (/^(verify|ensure|check|test|should|when|given|it )/i.test(cleaned)) return false;
  return true;
}

function keywordFeature(text: string): string | null {
  for (const [re, feature] of INVENTORY_FEATURE_KEYWORDS) {
    if (re.test(text)) return feature;
  }
  return null;
}

function deriveInventoryFeature(describeName: string | null, fileName: string, testName: string): { feature: string | null; source: 'describe' | 'keyword' | 'filename' } {
  if (describeName && isCleanLabel(describeName)) {
    return { feature: cleanDescribeLabel(describeName), source: 'describe' };
  }
  const kw = keywordFeature(`${describeName ?? ''} ${fileName} ${testName}`);
  if (kw) return { feature: kw, source: 'keyword' };
  const stem = fileName.replace(/\.(spec|test|cy|e2e)\.[jt]sx?$/i, '').replace(/\.[jt]sx?$/i, '');
  const cleaned = stem.replace(/[-_]+/g, ' ').replace(/^verify\s+/i, '').trim();
  return { feature: cleaned ? invTitleCase(cleaned) : null, source: 'filename' };
}

function deriveInventoryFlow(testName: string, describeName: string | null, feature: string | null): string | null {
  const hay = `${testName} ${describeName ?? ''}`;
  for (const [re, flow] of INVENTORY_FLOW_KEYWORDS) {
    if (re.test(hay)) return flow;
  }
  if (feature) return feature.toLowerCase().replace(/\s+/g, '-');
  return null;
}

function normalizePageName(raw: string): string {
  const stripped = raw.replace(/(Page|Screen|Component|View|PageObject|PO)$/i, '');
  return invTitleCase(stripped || raw);
}

function deriveInventoryPage(pomMethods: string[], bodyHints: string, fileName: string): string | null {
  // 1. Prefer the POM class/var the test drives (the page under test).
  if (pomMethods.length > 0) {
    return normalizePageName(pomMethods[0].split('.')[0]);
  }
  // 2. URL hints, e.g. inventory.html or goto('.../checkout').
  const urlMatch = bodyHints.match(/([a-z-]+)\.html/i) || bodyHints.match(/\/(\w[\w-]{2,})['"`)/]/);
  if (urlMatch) {
    const seg = urlMatch[1];
    if (seg && !/^https?$/i.test(seg) && !/^www$/i.test(seg)) return invTitleCase(seg);
  }
  // 3. Fall back to the filename stem.
  const stem = fileName.replace(/\.(spec|test|cy|e2e)\.[jt]sx?$/i, '').replace(/\.[jt]sx?$/i, '');
  return stem ? invTitleCase(stem) : null;
}

/**
 * Transparent confidence heuristic (0-100). Higher when more independent
 * signals were extracted; the breakdown is stored in metadata for auditing.
 */
function scoreInventoryConfidence(sig: {
  hasDescribe: boolean;
  assertions: number;
  tags: number;
  pomMethods: number;
  frameworkKnown: boolean;
}): number {
  let score = 40;                          // base: we found a named test
  if (sig.assertions > 0) score += 20;     // it actually asserts something
  if (sig.hasDescribe) score += 15;        // grouped under a real suite
  if (sig.tags > 0) score += 10;           // explicit tags / TC ids
  if (sig.pomMethods > 0) score += 10;     // exercises page objects
  if (sig.frameworkKnown) score += 5;      // framework positively identified
  return Math.max(0, Math.min(100, score));
}

/**
 * Build the deterministic Repository Test Inventory from the per-test facts the
 * AST analyzer already captured on each FileAnalysis. One entry per test.
 */
function extractTestInventory(analyses: FileAnalysis[], framework: TestFramework): TestInventoryEntry[] {
  const entries: TestInventoryEntry[] = [];
  const frameworkKnown = framework !== 'unknown';

  for (const a of analyses) {
    if (!a.tests || a.tests.length === 0) continue;
    const fileName = path.basename(a.relativePath);

    for (const t of a.tests) {
      const { feature, source } = deriveInventoryFeature(t.describeName, fileName, t.testName);
      const flow = deriveInventoryFlow(t.testName, t.describeName, feature);
      // Page hints: POM methods + the test title (URL literals live in the body,
      // but the AST layer already surfaced POM calls which are the stronger
      // signal; the title covers the remaining ".html" / route cases).
      const page = deriveInventoryPage(t.pomMethods, `${t.testName} ${t.tags.join(' ')}`, fileName);

      entries.push({
        testName: t.testName,
        filePath: a.relativePath,
        feature,
        flow,
        page,
        suite: t.describeName,
        tags: t.tags,
        assertions: t.assertions,
        pomMethods: t.pomMethods,
        framework,
        confidence: scoreInventoryConfidence({
          hasDescribe: !!t.describeName,
          assertions: t.assertions.length,
          tags: t.tags.length,
          pomMethods: t.pomMethods.length,
          frameworkKnown,
        }),
        metadata: {
          line: t.line,
          assertionCount: t.assertions.length,
          pomMethodCount: t.pomMethods.length,
          featureSource: source,
        },
      });
    }
  }

  return entries;
}

/* ------------------------------------------------------------------ */
/*  Test Suite Extraction                                              */
/* ------------------------------------------------------------------ */

function extractTestSuites(repoRoot: string, analyses: FileAnalysis[]): TestSuiteInfo[] {
  const suites: TestSuiteInfo[] = [];
  const testFiles = analyses.filter(a => a.testCount > 0);

  for (const tf of testFiles) {
    const fullPath = path.join(repoRoot, tf.relativePath);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, 'utf-8');

    const descMatch = /(?:test\.describe|describe)\s*\(\s*['"`]([^'"`]+)['"`]/;
    const describeName = descMatch.exec(content)?.[1] || null;

    const testNames: string[] = [];
    const testRe = /(?:test|it)\s*\(\s*['"`]([^'"`]+)['"`]/g;
    let m: RegExpExecArray | null;
    while ((m = testRe.exec(content)) !== null) testNames.push(m[1]);

    // Extract tags
    const tags: string[] = [];
    const tagRe = /@(\w+)/g;
    while ((m = tagRe.exec(content)) !== null) {
      if (!tags.includes(m[1])) tags.push(m[1]);
    }

    // Category from file path + describe name
    const allText = (describeName || '' + ' ' + tf.relativePath).toLowerCase();
    let category = 'general';
    if (/login|auth/.test(allText)) category = 'auth';
    else if (/nav|route/.test(allText)) category = 'navigation';
    else if (/crud|employee|user|create|edit/.test(allText)) category = 'crud';
    else if (/search|filter/.test(allText)) category = 'search';
    else if (/form|submit/.test(allText)) category = 'form';
    else if (/api/.test(allText)) category = 'api';

    suites.push({
      name: describeName || path.basename(tf.relativePath),
      filePath: tf.relativePath,
      testCount: testNames.length,
      testNames,
      describeName,
      tags,
      category,
    });
  }

  return suites;
}

/* ------------------------------------------------------------------ */
/*  Preferred Locator Analysis                                         */
/* ------------------------------------------------------------------ */

function analyzePreferredLocators(repoRoot: string, analyses: FileAnalysis[]): Array<{ pattern: string; count: number; example: string }> {
  const patternCounts: Record<string, { count: number; example: string }> = {};
  const testFiles = analyses.filter(a => a.testCount > 0);

  const locatorRegexes: Array<{ regex: RegExp; label: string }> = [
    { regex: /page\.getByRole\(['"`]([^'"`]+)['"`]/g, label: 'getByRole' },
    { regex: /page\.getByText\(/g, label: 'getByText' },
    { regex: /page\.getByLabel\(/g, label: 'getByLabel' },
    { regex: /page\.getByPlaceholder\(/g, label: 'getByPlaceholder' },
    { regex: /page\.getByTestId\(/g, label: 'getByTestId' },
    { regex: /page\.locator\(['"`]([^'"`]{3,60})['"`]/g, label: 'page.locator' },
    { regex: /\[data-testid=['"]([^'"]+)['"]\]/g, label: 'data-testid-attr' },
    { regex: /page\.click\(['"`]([^'"`]{3,60})['"`]/g, label: 'page.click-css' },
    { regex: /page\.fill\(['"`]([^'"`]{3,60})['"`]/g, label: 'page.fill-css' },
    { regex: /cy\.get\(['"`]([^'"`]{3,60})['"`]/g, label: 'cy.get' },
  ];

  for (const tf of testFiles) {
    const fullPath = path.join(repoRoot, tf.relativePath);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, 'utf-8');

    for (const { regex, label } of locatorRegexes) {
      const r = new RegExp(regex.source, regex.flags);
      let m: RegExpExecArray | null;
      while ((m = r.exec(content)) !== null) {
        if (!patternCounts[label]) {
          patternCounts[label] = { count: 0, example: m[0].slice(0, 80) };
        }
        patternCounts[label].count++;
      }
    }
  }

  return Object.entries(patternCounts)
    .map(([pattern, { count, example }]) => ({ pattern, count, example }))
    .sort((a, b) => b.count - a.count);
}

/* ------------------------------------------------------------------ */
/*  Dependencies Detection                                             */
/* ------------------------------------------------------------------ */

function detectDependencies(repoRoot: string): Array<{ name: string; version: string; isDev: boolean }> {
  const pkgPath = path.join(repoRoot, 'package.json');
  if (!fs.existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    const deps = Object.entries(pkg.dependencies || {}).map(([name, version]) => ({
      name, version: String(version), isDev: false,
    }));
    const devDeps = Object.entries(pkg.devDependencies || {}).map(([name, version]) => ({
      name, version: String(version), isDev: true,
    }));
    return [...deps, ...devDeps];
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/*  CI Integration Detection                                           */
/* ------------------------------------------------------------------ */

function detectCI(repoRoot: string): string | null {
  if (fs.existsSync(path.join(repoRoot, '.github', 'workflows'))) return 'github-actions';
  if (fs.existsSync(path.join(repoRoot, '.gitlab-ci.yml'))) return 'gitlab-ci';
  if (fs.existsSync(path.join(repoRoot, 'Jenkinsfile'))) return 'jenkins';
  if (fs.existsSync(path.join(repoRoot, '.circleci'))) return 'circleci';
  if (fs.existsSync(path.join(repoRoot, 'azure-pipelines.yml'))) return 'azure-devops';
  if (fs.existsSync(path.join(repoRoot, 'bitbucket-pipelines.yml'))) return 'bitbucket';
  return null;
}

/* ------------------------------------------------------------------ */
/*  Code Chunk Extraction (for future vector search)                   */
/* ------------------------------------------------------------------ */

export function extractCodeChunks(repoRoot: string, analyses: FileAnalysis[]): CodeChunk[] {
  const chunks: CodeChunk[] = [];

  for (const a of analyses) {
    const fullPath = path.join(repoRoot, a.relativePath);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, 'utf-8');
    const lines = content.split('\n');

    // Functions
    for (const fn of a.functions) {
      if (fn.category === 'test') continue; // skip test bodies for now
      const startLine = fn.lineNumber - 1;
      const endLine = Math.min(startLine + 50, lines.length); // cap at 50 lines
      chunks.push({
        filePath: a.relativePath,
        chunkType: fn.category === 'fixture' ? 'fixture' : 'function',
        chunkName: fn.name,
        content: lines.slice(startLine, endLine).join('\n'),
        metadata: {
          isExported: fn.isExported,
          isAsync: fn.isAsync,
          params: fn.parameters.map(p => p.name),
          returnType: fn.returnType,
          category: fn.category,
        },
        lineStart: fn.lineNumber,
        lineEnd: endLine + 1,
      });
    }

    // Classes
    for (const cls of a.classes) {
      const startLine = cls.lineNumber - 1;
      const endLine = Math.min(startLine + 100, lines.length); // cap at 100 lines
      chunks.push({
        filePath: a.relativePath,
        chunkType: 'class',
        chunkName: cls.name,
        content: lines.slice(startLine, endLine).join('\n'),
        metadata: {
          category: cls.category,
          baseClass: cls.baseClass,
          methodCount: cls.methods.length,
          propertyCount: cls.properties.length,
        },
        lineStart: cls.lineNumber,
        lineEnd: endLine + 1,
      });
    }
  }

  return chunks;
}

/* ================================================================== */
/*  MAIN: Repository Context Engine                                    */
/* ================================================================== */

/**
 * Discover test data files in the repository's data/ folder.
 * Scans for JSON, TS, JS, and CSV files that contain test fixtures.
 * Part of PR #122: Framework Auditor auto-discovers existing repo fixtures.
 */
function discoverDataFiles(repoRoot: string): Array<{ name: string; path: string; type: 'json' | 'ts' | 'js' | 'csv'; recordCount?: number }> {
  const dataFiles: Array<{ name: string; path: string; type: 'json' | 'ts' | 'js' | 'csv'; recordCount?: number }> = [];
  const dataDir = path.join(repoRoot, 'data');

  if (!fs.existsSync(dataDir)) {
    return dataFiles;
  }

  try {
    const entries = fs.readdirSync(dataDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;

      const ext = path.extname(entry.name).toLowerCase();
      let fileType: 'json' | 'ts' | 'js' | 'csv' | null = null;
      
      if (ext === '.json') fileType = 'json';
      else if (ext === '.ts') fileType = 'ts';
      else if (ext === '.js') fileType = 'js';
      else if (ext === '.csv') fileType = 'csv';
      else continue; // Skip non-data file types

      const filePath = path.join(dataDir, entry.name);
      const relativePath = path.relative(repoRoot, filePath);
      let recordCount: number | undefined;

      // Try to count records for JSON files
      if (fileType === 'json') {
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const parsed = JSON.parse(content);
          if (Array.isArray(parsed)) {
            recordCount = parsed.length;
          } else if (typeof parsed === 'object' && parsed !== null) {
            recordCount = Object.keys(parsed).length;
          }
        } catch {
          // Invalid JSON or parse error — still include the file but without count
        }
      }

      dataFiles.push({
        name: path.basename(entry.name, ext),
        path: relativePath,
        type: fileType,
        recordCount,
      });
    }

    logger.info(MOD, 'Data file discovery complete', {
      dataDir,
      filesFound: dataFiles.length,
    });
  } catch (err: any) {
    logger.warn(MOD, 'Failed to scan data/ directory', { dataDir, error: err.message });
  }

  return dataFiles;
}

/**
 * Detect environment/configuration awareness for the repository.
 *
 * Surfaces how the framework wires runtime config: .env files, dotenv usage,
 * a dedicated env loader module (e.g. utils/env.ts) and the `process.env.X`
 * variables referenced across the codebase. Previously the auditor's
 * `extractEnvFiles` was a stub returning [] — this gives the UI real signal.
 */
function detectEnvironment(
  repoRoot: string,
  analyses: FileAnalysis[],
  dependencies: Array<{ name: string; version: string; isDev: boolean }>,
): RepositoryProfile['environment'] {
  const envFiles: string[] = [];
  try {
    const entries = fs.readdirSync(repoRoot, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile() && /^\.env(\..+)?$/.test(e.name)) envFiles.push(e.name);
    }
  } catch {
    /* ignore */
  }

  let usesDotenv = dependencies.some(d => d.name === 'dotenv');
  let configModule: string | null = null;
  const envVarSet = new Set<string>();

  for (const a of analyses) {
    // dotenv import (e.g. `import 'dotenv/config'` or `require('dotenv')`).
    if (a.imports.some(i => i.module === 'dotenv' || i.module.startsWith('dotenv/'))) {
      usesDotenv = true;
    }

    // Dedicated env module: utils/env.ts, config/env.ts, src/env.ts, etc.
    const lp = a.relativePath.toLowerCase();
    if (!configModule && /(^|\/)(env|environment|config)\.(t|j)s$/.test(lp)) {
      configModule = a.relativePath;
    }

    // process.env.X references.
    const full = path.join(repoRoot, a.relativePath);
    if (fs.existsSync(full)) {
      try {
        const content = fs.readFileSync(full, 'utf-8');
        const re = /process\.env\.([A-Z0-9_]+)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(content)) !== null) envVarSet.add(m[1]);
        // bracket access: process.env['X']
        const re2 = /process\.env\[\s*['"`]([A-Z0-9_]+)['"`]\s*\]/g;
        while ((m = re2.exec(content)) !== null) envVarSet.add(m[1]);
      } catch {
        /* ignore */
      }
    }
  }

  return {
    envFiles: envFiles.sort(),
    usesDotenv,
    configModule,
    envVars: Array.from(envVarSet).sort().slice(0, 100),
  };
}

/**
 * Discover fixture files in the repository.
 *
 * The function-level AST categorizer only tags a *function* as a fixture, so a
 * fixture module that merely re-exports `test`/`expect` or calls
 * `base.extend({...})` at the top level (the common Playwright pattern) was
 * previously invisible — producing the "Fixtures: 0" bug even when a
 * `fixtures/baseFixture.ts` clearly exists.
 *
 * This scans the AST analyses for files that are *structurally* fixtures:
 *   - located in a `fixtures/` or `support/` folder, OR
 *   - call `.extend(` / `mergeTests(` (Playwright fixture composition), OR
 *   - re-export `test` and/or `expect` from a base test module.
 *
 * For each such file (that isn't already represented by a function-level
 * fixture) we synthesize a fixture entry. When the file composes fixtures via
 * `base.extend({ a, b, c })` we surface each named sub-fixture, otherwise we
 * surface the module itself (named after the file).
 */
function discoverFixtureFiles(
  repoRoot: string,
  analyses: FileAnalysis[],
  existingFixtures: FunctionSignature[],
): FunctionSignature[] {
  const result: FunctionSignature[] = [];
  const filesWithFnFixture = new Set(existingFixtures.map(f => f.filePath));

  for (const a of analyses) {
    const lowerPath = a.relativePath.toLowerCase();
    const inFixtureFolder =
      /(^|\/)(fixtures|support)\//.test(lowerPath) ||
      /\bfixture\b/.test(path.basename(lowerPath));

    const fullPath = path.join(repoRoot, a.relativePath);
    if (!fs.existsSync(fullPath)) continue;
    let content = '';
    try {
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch {
      continue;
    }

    const usesExtend = /\.extend\s*\(/.test(content) || /\bmergeTests\s*\(/.test(content);
    const reExportsTest =
      /export\s+(?:const|let|var)\s+test\b/.test(content) ||
      /export\s*\{[^}]*\btest\b[^}]*\}/.test(content);

    if (!inFixtureFolder && !usesExtend && !reExportsTest) continue;

    // Already captured a function-level fixture in this file — don't double count.
    if (filesWithFnFixture.has(a.relativePath)) continue;

    const baseName = path.basename(a.relativePath, path.extname(a.relativePath));

    // Try to surface individual sub-fixtures from `extend({ a, b, c })`.
    const subFixtures = extractExtendFixtureKeys(content);

    if (subFixtures.length > 0) {
      for (const key of subFixtures) {
        result.push(makeFixtureEntry(key, a.relativePath));
      }
    } else {
      result.push(makeFixtureEntry(baseName, a.relativePath));
    }
  }

  if (result.length > 0) {
    logger.info(MOD, 'Fixture-file discovery complete', {
      filesFound: new Set(result.map(r => r.filePath)).size,
      fixturesAdded: result.length,
    });
  }

  return result;
}

/** Build a synthetic FunctionSignature representing a file-level fixture. */
function makeFixtureEntry(name: string, filePath: string): FunctionSignature {
  return {
    name,
    filePath,
    isExported: true,
    isAsync: false,
    parameters: [],
    returnType: 'Fixture',
    jsdoc: '',
    lineNumber: 1,
    category: 'fixture',
    complexity: 1,
  };
}

/**
 * Extract the first-level fixture names from a `base.extend({ ... })` /
 * `test.extend({ ... })` call. Returns the object keys (e.g. ['authedPage',
 * 'standardUser']). Best-effort: matches the object literal passed to the first
 * `.extend(` and pulls top-level `key:` / `key,` identifiers, skipping nested
 * objects so we don't surface inner option keys.
 */
function extractExtendFixtureKeys(content: string): string[] {
  const extendIdx = content.search(/\.extend\s*\(\s*\{/);
  if (extendIdx === -1) return [];

  // Walk from the opening brace, tracking depth to isolate the top-level object.
  const braceStart = content.indexOf('{', extendIdx);
  if (braceStart === -1) return [];

  let depth = 0;
  let end = -1;
  for (let i = braceStart; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return [];

  const body = content.slice(braceStart + 1, end);
  const keys: string[] = [];
  let depth2 = 0;
  // Split on top-level commas only.
  let token = '';
  const flush = () => {
    const m = /^\s*([A-Za-z_$][\w$]*)\s*:/.exec(token) || /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(token);
    if (m && !keys.includes(m[1])) keys.push(m[1]);
    token = '';
  };
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{' || ch === '[' || ch === '(') depth2++;
    else if (ch === '}' || ch === ']' || ch === ')') depth2--;
    if (ch === ',' && depth2 === 0) { flush(); continue; }
    token += ch;
  }
  flush();
  return keys.slice(0, 30);
}

export class RepositoryContextEngine {
  private astAnalyzer: ASTAnalyzer;

  constructor() {
    this.astAnalyzer = new ASTAnalyzer();
  }

  /**
   * Scan a repository and produce a full intelligence profile.
   * This is the single most important method in the entire platform.
   */
  scan(repoRoot: string): { profile: RepositoryProfile; chunks: CodeChunk[]; durationMs: number } {
    const start = Date.now();
    logger.info(MOD, 'Starting repository intelligence scan', { repoRoot });

    // Phase 0: Language guard. Fail loudly for repos the AST analyzer can't
    // parse (Python/Java/C#) instead of silently producing an empty profile.
    const detectedLanguage = detectRepoLanguage(repoRoot);
    if (!SUPPORTED_LANGUAGES.includes(detectedLanguage)) {
      logger.warn(MOD, 'Unsupported repository language — aborting scan', {
        repoRoot, detectedLanguage, supported: SUPPORTED_LANGUAGES,
      });
      throw new UnsupportedLanguageError(detectedLanguage);
    }

    // Phase 1: AST Analysis
    const analyses = this.astAnalyzer.analyzeRepo(repoRoot);
    logger.info(MOD, 'Phase 1 complete: AST analysis', {
      filesAnalyzed: analyses.length,
    });

    // Phase 2: Intelligence Extraction
    const framework = detectFramework(repoRoot, analyses);
    const language = detectPrimaryLanguage(analyses);
    const testPattern = detectTestPattern(analyses);
    const locatorStrategy = detectLocatorStrategy(analyses);
    const folderStructure = detectFolderStructure(repoRoot, analyses);
    const codingStyle = detectCodingStyle(repoRoot, analyses);
    const businessFlows = extractBusinessFlows(repoRoot, analyses);
    const testSuites = extractTestSuites(repoRoot, analyses);
    // Repository Test Inventory (Sprint RCI-1): per-test, classified, from the
    // same AST pass. One scan → one more profile output.
    const testInventory = extractTestInventory(analyses, framework);
    const preferredLocators = analyzePreferredLocators(repoRoot, analyses);
    const dependencies = detectDependencies(repoRoot);
    const ciIntegration = detectCI(repoRoot);

    // Phase 3: Collect reusable assets
    const allFunctions = analyses.flatMap(a => a.functions);
    const allClasses = analyses.flatMap(a => a.classes);

    const helperFunctions = allFunctions.filter(f =>
      f.category === 'helper' || f.category === 'utility'
    ).filter(f => f.isExported);
    
    // Phase 3.5: Discover test data files (PR #122)
    const dataFiles = discoverDataFiles(repoRoot);

    const pageObjects = allClasses.filter(c => c.category === 'page-object');

    // Fixtures: function-level fixtures from the AST, plus structurally-detected
    // fixture *files* (e.g. fixtures/baseFixture.ts that re-exports `test` or
    // composes via base.extend) which the function categorizer can't see.
    const fnFixtures = allFunctions.filter(f => f.category === 'fixture');
    const fileFixtures = discoverFixtureFiles(repoRoot, analyses, fnFixtures);
    const fixtures = [...fnFixtures, ...fileFixtures];

    const customCommands = allFunctions.filter(f =>
      f.name.startsWith('use') || // Playwright fixtures
      (f.isExported && f.category === 'helper' && f.parameters.length <= 3) // reusable helpers
    );

    // Shared constants
    const sharedConstants: Array<{ name: string; value: string; filePath: string }> = [];
    for (const a of analyses) {
      if (a.relativePath.toLowerCase().includes('constant') ||
          a.relativePath.toLowerCase().includes('config') ||
          a.relativePath.toLowerCase().includes('env')) {
        for (const exp of a.exports) {
          sharedConstants.push({ name: exp, value: '', filePath: a.relativePath });
        }
      }
    }

    // Assertion library
    const allImports = analyses.flatMap(a => a.imports);
    let assertionLibrary = 'expect';
    if (allImports.some(i => i.module === 'chai')) assertionLibrary = 'chai';
    if (allImports.some(i => i.module.includes('jest'))) assertionLibrary = 'jest-expect';

    const hasApiLayer = allFunctions.some(f =>
      /api|request|fetch|axios|http/.test(f.name.toLowerCase())
    ) || allImports.some(i => /axios|supertest|got|node-fetch/.test(i.module));

    const hasMocking = allImports.some(i =>
      /mock|sinon|nock|msw|jest\.mock/.test(i.module)
    );

    const hasVisualTesting = allImports.some(i =>
      /screenshot|visual|percy|applitools|backstop/.test(i.module)
    );

    // Phase 4: Code chunks for future embedding (RAG/vector search — Phase 2).
    // Gated off by default: chunks are not yet consumed by any retrieval path,
    // so extraction + storage is pure overhead until the RAG layer lands.
    // Re-enable with ENABLE_CODE_CHUNKS=true (see src/config/features.ts).
    const chunks: CodeChunk[] = FEATURE_FLAGS.REPO_INTELLIGENCE.CODE_CHUNKS_STORAGE
      ? extractCodeChunks(repoRoot, analyses)
      : [];
    if (!FEATURE_FLAGS.REPO_INTELLIGENCE.CODE_CHUNKS_STORAGE) {
      logger.info(MOD, 'Code chunks storage disabled (Phase 2 / RAG) — skipping extraction');
    }

    const durationMs = Date.now() - start;

    const profile: RepositoryProfile = {
      framework,
      language,
      testPattern,
      locatorStrategy,
      folderStructure,
      totalFiles: analyses.length,
      totalTestFiles: analyses.filter(a => a.testCount > 0).length,
      totalHelperFiles: analyses.filter(a =>
        a.functions.some(f => f.category === 'helper' || f.category === 'utility')
      ).length,
      totalLineCount: analyses.reduce((s, a) => s + a.lineCount, 0),
      codingStyle,
      helperFunctions,
      pageObjects,
      fixtures,
      customCommands,
      sharedConstants: sharedConstants.slice(0, 100), // cap
      dataFiles, // PR #122: auto-discovered test data files
      environment: detectEnvironment(repoRoot, analyses, dependencies),
      businessFlows,
      testSuites,
      testInventory,
      preferredLocators,
      avoidPatterns: locatorStrategy === 'data-testid' ? ['xpath', 'css-class-only'] : [],
      dependencies,
      assertionLibrary,
      hasApiLayer,
      hasCustomFixtures: fixtures.length > 0,
      hasMocking,
      hasVisualTesting,
      ciIntegration,
    };

    logger.info(MOD, 'Repository intelligence scan complete', {
      framework: profile.framework,
      language: profile.language,
      testPattern: profile.testPattern,
      locatorStrategy: profile.locatorStrategy,
      totalFiles: profile.totalFiles,
      totalTestFiles: profile.totalTestFiles,
      helpers: profile.helperFunctions.length,
      pageObjects: profile.pageObjects.length,
      fixtures: profile.fixtures.length,
      dataFiles: profile.dataFiles.length, // PR #122
      flows: profile.businessFlows.length,
      suites: profile.testSuites.length,
      inventoryTests: profile.testInventory.length,
      chunks: chunks.length,
      durationMs,
    });

    return { profile, chunks, durationMs };
  }
}
