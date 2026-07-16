/**
 * Repository Test Inventory Scanner — Sprint RCI-1
 * ================================================
 * DETERMINISTIC, per-test static analysis of an existing test repository.
 *
 * ▸ NO LLM. NO embeddings. NO generation. NO network calls.
 * ▸ Pure ts-morph AST + regex extraction. Given the same files, it always
 *   produces the same inventory (fully reproducible).
 *
 * It answers the foundational question of Repository Coverage Intelligence:
 * "What tests already exist in this repo — and what do they cover?" — BEFORE
 * any AI generation is allowed to run.
 *
 * For each test it emits ONE record with:
 *   file_path, test_name, feature, flow, page, tags[], assertions[],
 *   pom_methods[], framework, confidence (0-100), metadata{...raw signals}.
 *
 * Supported frameworks (JS/TS): Playwright, Cypress, and Selenium-WebDriver
 * (Mocha/Jest style `describe`/`it`). Java/Python Selenium is out of scope for
 * this sprint (this platform's repos are TS/JS).
 */

import { Project, SyntaxKind, Node, CallExpression } from 'ts-morph';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../utils/logger';

const MOD = 'RepoInventoryScanner';

/** One extracted test — the shape persisted as a row in repository_test_inventory. */
export interface InventoryTestRecord {
  filePath: string;          // repo-relative
  testName: string;
  feature: string | null;
  flow: string | null;
  page: string | null;
  tags: string[];
  assertions: string[];
  pomMethods: string[];
  framework: TestFramework;
  confidence: number;        // 0-100
  metadata: Record<string, any>;
}

export type TestFramework = 'playwright' | 'cypress' | 'selenium' | 'unknown';

export interface RepositoryInventoryScanResult {
  records: InventoryTestRecord[];
  filesScanned: number;
  testFilesScanned: number;
  testsFound: number;
  frameworks: TestFramework[];
  durationMs: number;
  warnings: string[];
}

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'out',
  '.turbo', '.cache', 'playwright-report', 'test-results', 'target', 'vendor',
]);

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

// A file is a candidate test file when its name matches these patterns…
const TEST_FILE_RE = /(\.spec\.|\.test\.|\.cy\.|[._-]e2e\.|test[._-])/i;
// …or it lives under one of these directories.
const TEST_DIR_RE = /(^|[\\/])(tests?|e2e|specs?|cypress|__tests__|integration)([\\/]|$)/i;

/** Deterministic keyword → feature bucket. Order matters (first match wins). */
const FEATURE_KEYWORDS: [RegExp, string][] = [
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
const FLOW_KEYWORDS: [RegExp, string][] = [
  [/\blogout|log ?out|sign ?out\b/i, 'logout'],
  [/\blogin|log ?in|sign ?in|authenticat/i, 'login'],
  [/\bcheckout|complete (the )?(purchase|order)|place order\b/i, 'checkout'],
  [/\badd .*cart|add to cart\b/i, 'add-to-cart'],
  [/\bremove .*cart\b/i, 'remove-from-cart'],
  [/\bregister|sign ?up|create .*account\b/i, 'registration'],
  [/\bsearch|filter|sort\b/i, 'search'],
  [/\bnavigat|redirect|go to\b/i, 'navigation'],
];

/** Playwright/Jest web-first + chai/assert matchers we recognise as assertions. */
const ASSERTION_MATCHERS = new Set([
  'toBe', 'toEqual', 'toStrictEqual', 'toContain', 'toContainEqual', 'toMatch',
  'toMatchObject', 'toHaveLength', 'toBeTruthy', 'toBeFalsy', 'toBeNull',
  'toBeDefined', 'toBeUndefined', 'toBeGreaterThan', 'toBeLessThan',
  // Playwright web-first assertions
  'toHaveText', 'toContainText', 'toHaveValue', 'toHaveAttribute', 'toBeVisible',
  'toBeHidden', 'toBeEnabled', 'toBeDisabled', 'toBeChecked', 'toHaveURL',
  'toHaveTitle', 'toHaveCount', 'toHaveClass', 'toBeFocused', 'toBeEditable',
  'toHaveScreenshot', 'toBeAttached', 'toHaveCSS', 'toHaveId',
  // Chai / assert
  'equal', 'deepEqual', 'strictEqual', 'isTrue', 'isFalse', 'exists',
  'notEqual', 'include', 'lengthOf', 'ok', 'instanceOf',
]);

export class RepositoryInventoryScanner {
  /**
   * Scan a repository directory (already on disk) and return the per-test
   * inventory. Purely synchronous static analysis.
   */
  scan(repoRoot: string): RepositoryInventoryScanResult {
    const started = Date.now();
    const warnings: string[] = [];
    const records: InventoryTestRecord[] = [];
    const frameworks = new Set<TestFramework>();

    if (!fs.existsSync(repoRoot)) {
      throw new Error(`Repository path does not exist: ${repoRoot}`);
    }

    const allFiles = this.walk(repoRoot);
    const testFiles = allFiles.filter(f => this.looksLikeTestFile(f));

    const project = new Project({
      useInMemoryFileSystem: false,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: { allowJs: true },
    });

    let testFilesScanned = 0;
    for (const abs of testFiles) {
      let content: string;
      try {
        content = fs.readFileSync(abs, 'utf8');
      } catch (err) {
        warnings.push(`Could not read ${abs}: ${(err as Error).message}`);
        continue;
      }
      const framework = this.detectFramework(content);
      // Only scan files that actually contain test declarations.
      if (!/\b(test|it)\s*(\.\w+)?\s*\(/.test(content)) continue;

      let source;
      try {
        source = project.createSourceFile(abs, content, { overwrite: true });
      } catch (err) {
        warnings.push(`Parse failed for ${abs}: ${(err as Error).message}`);
        continue;
      }

      const relPath = path.relative(repoRoot, abs).split(path.sep).join('/');
      const fileRecords = this.extractFromFile(source, relPath, framework, warnings);
      if (fileRecords.length > 0) {
        testFilesScanned++;
        frameworks.add(framework);
        records.push(...fileRecords);
      }
      // Free memory — we do not keep the AST around.
      project.removeSourceFile(source);
    }

    const durationMs = Date.now() - started;
    logger.info(MOD, `Scanned ${testFilesScanned} test files, found ${records.length} tests in ${durationMs}ms`, {
      filesScanned: allFiles.length,
      testFilesScanned,
      testsFound: records.length,
    });

    return {
      records,
      filesScanned: allFiles.length,
      testFilesScanned,
      testsFound: records.length,
      frameworks: [...frameworks],
      durationMs,
      warnings,
    };
  }

  /* ─── File discovery ─────────────────────────────────────────────── */

  private walk(root: string): string[] {
    const out: string[] = [];
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') && entry.isDirectory()) {
          if (IGNORE_DIRS.has(entry.name)) continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (IGNORE_DIRS.has(entry.name)) continue;
          stack.push(full);
        } else if (entry.isFile()) {
          if (SOURCE_EXT.has(path.extname(entry.name))) out.push(full);
        }
      }
    }
    return out;
  }

  private looksLikeTestFile(absPath: string): boolean {
    const base = path.basename(absPath);
    const rel = absPath;
    return TEST_FILE_RE.test(base) || TEST_DIR_RE.test(rel);
  }

  private detectFramework(content: string): TestFramework {
    if (/@playwright\/test|from ['"]playwright/.test(content)) return 'playwright';
    if (/\bcy\.\w+|from ['"]cypress|\/\/\/ <reference types="cypress"/.test(content)) return 'cypress';
    if (/selenium-webdriver|from ['"]webdriverio|\bnew Builder\(\)/.test(content)) return 'selenium';
    // Fixture-based Playwright repos re-export test from a local fixture.
    if (/from ['"].*fixture/i.test(content) && /\btest\s*\(/.test(content)) return 'playwright';
    return 'unknown';
  }

  /* ─── Per-file extraction ────────────────────────────────────────── */

  private extractFromFile(
    source: import('ts-morph').SourceFile,
    relPath: string,
    framework: TestFramework,
    warnings: string[],
  ): InventoryTestRecord[] {
    const records: InventoryTestRecord[] = [];
    const fileName = path.basename(relPath);

    // Map of variable name → POM class name for `const x = new FooPage(page)`.
    const pomVars = this.collectPomVariables(source);

    const calls = source.getDescendantsOfKind(SyntaxKind.CallExpression);
    for (const call of calls) {
      if (!this.isTestCall(call)) continue;

      const testName = this.getStringArg(call);
      if (!testName) continue; // dynamic title — cannot deterministically extract

      const describeTitle = this.getEnclosingDescribe(call);
      const bodyText = call.getText();

      const tags = this.extractTags(testName, bodyText);
      const assertions = this.extractAssertions(call);
      const pomMethods = this.extractPomMethods(call, pomVars);
      const pageName = this.derivePage(pomMethods, pomVars, bodyText, fileName);
      const feature = this.deriveFeature(describeTitle, fileName, testName);
      const flow = this.deriveFlow(testName, describeTitle, feature);

      const confidence = this.scoreConfidence({
        hasDescribe: !!describeTitle,
        assertions: assertions.length,
        tags: tags.length,
        pomMethods: pomMethods.length,
        framework,
      });

      records.push({
        filePath: relPath,
        testName,
        feature,
        flow,
        page: pageName,
        tags,
        assertions,
        pomMethods,
        framework,
        confidence,
        metadata: {
          describeTitle: describeTitle ?? null,
          line: call.getStartLineNumber(),
          assertionCount: assertions.length,
          pomMethodCount: pomMethods.length,
          featureSource: describeTitle && this.isCleanLabel(describeTitle)
            ? 'describe'
            : (this.keywordFeature(`${describeTitle ?? ''} ${fileName} ${testName}`) ? 'keyword' : 'filename'),
        },
      });
    }

    if (records.length === 0) {
      warnings.push(`No extractable tests in ${relPath}`);
    }
    return records;
  }

  /* ─── AST helpers ────────────────────────────────────────────────── */

  /** True for test(...), it(...), test.only(...), it.skip(...), test.describe is excluded. */
  private isTestCall(call: CallExpression): boolean {
    const expr = call.getExpression();
    // Identifier form: test(...) / it(...)
    if (Node.isIdentifier(expr)) {
      const name = expr.getText();
      return name === 'test' || name === 'it';
    }
    // Member form: test.only(...) / it.skip(...) — but NOT test.describe / test.step
    if (Node.isPropertyAccessExpression(expr)) {
      const root = expr.getExpression().getText();
      const prop = expr.getName();
      if ((root === 'test' || root === 'it')) {
        return ['only', 'skip', 'fixme', 'fail', 'serial'].includes(prop);
      }
    }
    return false;
  }

  private isDescribeCall(call: CallExpression): boolean {
    const expr = call.getExpression();
    if (Node.isIdentifier(expr)) {
      const n = expr.getText();
      return n === 'describe' || n === 'context' || n === 'suite';
    }
    if (Node.isPropertyAccessExpression(expr)) {
      const root = expr.getExpression().getText();
      const prop = expr.getName();
      return root === 'test' && (prop === 'describe' || prop === 'suite');
    }
    return false;
  }

  private getStringArg(call: CallExpression): string | null {
    const arg = call.getArguments()[0];
    if (!arg) return null;
    if (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) {
      return arg.getLiteralText().trim() || null;
    }
    if (Node.isTemplateExpression(arg)) {
      // Best-effort: use the static head so dynamic titles still get a label.
      const head = arg.getHead().getLiteralText().trim();
      return head || null;
    }
    return null;
  }

  private getEnclosingDescribe(call: CallExpression): string | null {
    let node: Node | undefined = call.getParent();
    while (node) {
      if (Node.isCallExpression(node) && this.isDescribeCall(node)) {
        return this.getStringArg(node);
      }
      node = node.getParent();
    }
    return null;
  }

  /** Collect `const x = new FooPage(...)` → { x: 'FooPage' }. */
  private collectPomVariables(source: import('ts-morph').SourceFile): Map<string, string> {
    const map = new Map<string, string>();
    for (const decl of source.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
      const init = decl.getInitializer();
      if (init && Node.isNewExpression(init)) {
        const className = init.getExpression().getText();
        if (this.looksLikePomClass(className)) {
          map.set(decl.getName(), className);
        }
      }
    }
    return map;
  }

  private looksLikePomClass(name: string): boolean {
    return /(Page|Screen|Component|View|PO|PageObject)$/.test(name);
  }

  /** A destructured fixture param like `loginPage` (ends in "page", not the raw `page`). */
  private looksLikePomVarName(name: string): boolean {
    return name !== 'page' && /page$|screen$|component$|view$/i.test(name);
  }

  private extractTags(testName: string, bodyText: string): string[] {
    const tags = new Set<string>();
    const re = /@[\w:-]+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(testName)) !== null) tags.add(m[0]);
    while ((m = re.exec(bodyText)) !== null) tags.add(m[0]);
    return [...tags];
  }

  private extractAssertions(call: CallExpression): string[] {
    const found = new Set<string>();
    for (const inner of call.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = inner.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) continue;
      const method = expr.getName();

      // Playwright / Jest: expect(...).matcher(...)  (may be behind .not / .resolves)
      if (ASSERTION_MATCHERS.has(method)) {
        const rootText = expr.getExpression().getText();
        if (/(^|\W)expect\s*\(/.test(rootText) || /(^|\.)assert(\.|$)/.test(rootText)) {
          found.add(method);
          continue;
        }
      }
      // Cypress: cy.get(...).should('be.visible')  →  should:be.visible
      if (method === 'should') {
        const rootText = expr.getExpression().getText();
        if (/\bcy\b/.test(rootText) || /(^|\W)expect\s*\(/.test(rootText)) {
          const firstArg = inner.getArguments()[0];
          if (firstArg && (Node.isStringLiteral(firstArg) || Node.isNoSubstitutionTemplateLiteral(firstArg))) {
            found.add(`should:${firstArg.getLiteralText()}`);
          } else {
            found.add('should');
          }
        }
      }
    }
    return [...found];
  }

  private extractPomMethods(call: CallExpression, pomVars: Map<string, string>): string[] {
    const found = new Set<string>();
    for (const inner of call.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const expr = inner.getExpression();
      if (!Node.isPropertyAccessExpression(expr)) continue;
      const method = expr.getName();
      const receiver = expr.getExpression();
      if (!Node.isIdentifier(receiver)) continue;
      const varName = receiver.getText();

      if (pomVars.has(varName)) {
        // Instantiated POM: record as ClassName.method
        found.add(`${pomVars.get(varName)}.${method}`);
      } else if (this.looksLikePomVarName(varName)) {
        // Fixture-injected POM (e.g. loginPage.login): record as varName.method
        found.add(`${varName}.${method}`);
      }
    }
    return [...found];
  }

  /* ─── Deterministic derivations ──────────────────────────────────── */

  private derivePage(
    pomMethods: string[],
    pomVars: Map<string, string>,
    bodyText: string,
    fileName: string,
  ): string | null {
    // 1. Prefer an explicit POM class/var (the page under test).
    if (pomMethods.length > 0) {
      const first = pomMethods[0].split('.')[0];
      return this.normalizePageName(first);
    }
    if (pomVars.size > 0) {
      return this.normalizePageName([...pomVars.values()][0]);
    }
    // 2. URL hints, e.g. /inventory\.html/ or goto('.../checkout')
    const urlMatch = bodyText.match(/([a-z-]+)\.html/i) || bodyText.match(/\/(\w[\w-]{2,})['"`)/]/);
    if (urlMatch) {
      const seg = urlMatch[1];
      if (seg && !/^https?$/i.test(seg) && !/^www$/i.test(seg)) {
        return this.titleCase(seg);
      }
    }
    // 3. Fall back to filename stem.
    const stem = fileName.replace(/\.(spec|test|cy|e2e)\.[jt]sx?$/i, '').replace(/\.[jt]sx?$/i, '');
    return stem ? this.titleCase(stem) : null;
  }

  private normalizePageName(raw: string): string {
    // "loginPage" / "LoginPage" → "Login"; keep meaningful multiword.
    const stripped = raw.replace(/(Page|Screen|Component|View|PageObject|PO)$/i, '');
    return this.titleCase(stripped || raw);
  }

  private deriveFeature(describeTitle: string | null, fileName: string, testName: string): string | null {
    // 1. A short, clean describe label is the best feature signal.
    if (describeTitle && this.isCleanLabel(describeTitle)) {
      return this.cleanDescribeLabel(describeTitle);
    }
    // 2. Keyword bucket from all available text.
    const kw = this.keywordFeature(`${describeTitle ?? ''} ${fileName} ${testName}`);
    if (kw) return kw;
    // 3. Filename stem, title-cased.
    const stem = fileName.replace(/\.(spec|test|cy|e2e)\.[jt]sx?$/i, '').replace(/\.[jt]sx?$/i, '');
    const cleaned = stem.replace(/[-_]+/g, ' ').replace(/^verify\s+/i, '').trim();
    return cleaned ? this.titleCase(cleaned) : null;
  }

  private deriveFlow(testName: string, describeTitle: string | null, feature: string | null): string | null {
    const hay = `${testName} ${describeTitle ?? ''}`;
    for (const [re, flow] of FLOW_KEYWORDS) {
      if (re.test(hay)) return flow;
    }
    // Fall back to a normalized feature slug.
    if (feature) return feature.toLowerCase().replace(/\s+/g, '-');
    return null;
  }

  private keywordFeature(text: string): string | null {
    for (const [re, feature] of FEATURE_KEYWORDS) {
      if (re.test(text)) return feature;
    }
    return null;
  }

  /** A describe title is a "clean label" if it's a short noun-ish phrase, not a full sentence. */
  private isCleanLabel(title: string): boolean {
    const cleaned = this.cleanDescribeLabel(title);
    const words = cleaned.split(/\s+/).filter(Boolean);
    if (words.length === 0 || words.length > 4) return false;
    if (/^(verify|ensure|check|test|should|when|given|it )/i.test(cleaned)) return false;
    return true;
  }

  private cleanDescribeLabel(title: string): string {
    // Strip trailing "— 16 scenarios", "(smoke)", counts, etc.
    return title
      .replace(/[—–-]\s*\d+\s*scenario.*$/i, '')
      .replace(/\(\s*\d+\s*(tests?|scenarios?)\s*\)\s*$/i, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  private titleCase(s: string): string {
    return s
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[-_]+/g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  /**
   * Transparent confidence heuristic (0-100). Higher when more independent
   * signals were extracted. The breakdown is stored in metadata for auditing.
   */
  private scoreConfidence(sig: {
    hasDescribe: boolean;
    assertions: number;
    tags: number;
    pomMethods: number;
    framework: TestFramework;
  }): number {
    let score = 40;                                  // base: we found a named test
    if (sig.assertions > 0) score += 20;             // it actually asserts something
    if (sig.hasDescribe) score += 15;                // grouped under a real suite
    if (sig.tags > 0) score += 10;                   // explicit tags / TC ids
    if (sig.pomMethods > 0) score += 10;             // exercises page objects
    if (sig.framework !== 'unknown') score += 5;     // framework positively identified
    return Math.max(0, Math.min(100, score));
  }
}

/** Convenience wrapper. */
export function scanRepositoryInventory(repoRoot: string): RepositoryInventoryScanResult {
  return new RepositoryInventoryScanner().scan(repoRoot);
}
