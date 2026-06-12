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

  logger.info(MOD, 'Coding-style detection (multi-file majority vote)', {
    filesSampled: sampleFiles.length,
    indentStyle, quoteStyle, semicolons, votes,
  });

  return {
    namingConvention,
    testNaming: testNaming || 'unknown',
    stepStyle,
    tagConvention,
    indentStyle,
    quoteStyle,
    semicolons,
  };
}

/* ------------------------------------------------------------------ */
/*  Business Flow Extraction                                           */
/* ------------------------------------------------------------------ */

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

    // Find URL if available
    const urlMatch = /page\.goto\s*\(\s*['"`]([^'"`]+)['"`]/.exec(content);
    const entryUrl = urlMatch?.[1] || null;

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
    const preferredLocators = analyzePreferredLocators(repoRoot, analyses);
    const dependencies = detectDependencies(repoRoot);
    const ciIntegration = detectCI(repoRoot);

    // Phase 3: Collect reusable assets
    const allFunctions = analyses.flatMap(a => a.functions);
    const allClasses = analyses.flatMap(a => a.classes);

    const helperFunctions = allFunctions.filter(f =>
      f.category === 'helper' || f.category === 'utility'
    ).filter(f => f.isExported);

    const pageObjects = allClasses.filter(c => c.category === 'page-object');

    const fixtures = allFunctions.filter(f => f.category === 'fixture');

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
      businessFlows,
      testSuites,
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
      flows: profile.businessFlows.length,
      suites: profile.testSuites.length,
      chunks: chunks.length,
      durationMs,
    });

    return { profile, chunks, durationMs };
  }
}
