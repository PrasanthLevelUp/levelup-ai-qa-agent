/**
 * AST Analyzer Engine
 *
 * Uses ts-morph to perform deep static analysis of TypeScript/JavaScript
 * test repositories. Extracts functions, classes, imports, exports,
 * test counts, locator patterns, and assertion patterns.
 *
 * This is the core intelligence layer that turns raw source code into
 * structured, searchable knowledge.
 */

import { Project, SourceFile, SyntaxKind, Node, FunctionDeclaration, MethodDeclaration, ClassDeclaration, ArrowFunction, VariableDeclaration } from 'ts-morph';
import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../utils/logger';
import type {
  FileAnalysis,
  FunctionSignature,
  ClassInfo,
  ImportInfo,
  Language,
} from './types';

const MOD = 'ast-analyzer';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function detectLanguage(filePath: string): Language {
  if (/\.tsx?$/.test(filePath)) return 'typescript';
  if (/\.jsx?$/.test(filePath)) return 'javascript';
  if (/\.py$/.test(filePath)) return 'python';
  if (/\.java$/.test(filePath)) return 'java';
  if (/\.cs$/.test(filePath)) return 'csharp';
  return 'unknown';
}

function categorizeFn(name: string, filePath: string, isExported: boolean): FunctionSignature['category'] {
  const lowerName = name.toLowerCase();
  const lowerPath = filePath.toLowerCase();

  // Test functions
  if (/^(test|it|describe|context|specify)$/.test(lowerName)) return 'test';
  if (/\.(spec|test)\.(ts|js|tsx|jsx)$/.test(lowerPath)) {
    if (/^(before|after)(All|Each)?$/.test(lowerName)) return 'hook';
  }

  // Fixtures
  if (lowerPath.includes('fixture') || lowerPath.includes('support')) return 'fixture';
  if (/^use[A-Z]/.test(name)) return 'fixture'; // custom hooks/fixtures

  // Page objects
  if (lowerPath.includes('page') || lowerPath.includes('pom') || lowerPath.includes('screen')) return 'page-object';

  // Config
  if (lowerPath.includes('config') || lowerPath.includes('setup') || lowerPath.includes('global')) return 'config';

  // Helpers & utilities
  if (lowerPath.includes('helper') || lowerPath.includes('util') || lowerPath.includes('lib') || lowerPath.includes('common')) return 'helper';
  if (isExported && !lowerPath.includes('spec') && !lowerPath.includes('test')) return 'utility';

  return 'unknown';
}

function categorizeClass(name: string, filePath: string, baseClass: string | null): ClassInfo['category'] {
  const lowerName = name.toLowerCase();
  const lowerPath = filePath.toLowerCase();

  if (lowerName.includes('page') || lowerPath.includes('page') || lowerPath.includes('pom') || lowerPath.includes('screen')) return 'page-object';
  if (lowerName.includes('fixture') || lowerPath.includes('fixture')) return 'fixture';
  if (lowerName.includes('base') || lowerName.includes('abstract')) return 'base-class';
  if (baseClass) return 'page-object'; // inherits from something → likely POM
  if (lowerPath.includes('util') || lowerPath.includes('helper')) return 'utility';
  return 'unknown';
}

function countComplexity(node: Node): number {
  let count = 0;
  node.forEachDescendant((child) => {
    switch (child.getKind()) {
      case SyntaxKind.IfStatement:
      case SyntaxKind.ConditionalExpression:
      case SyntaxKind.ForStatement:
      case SyntaxKind.ForInStatement:
      case SyntaxKind.ForOfStatement:
      case SyntaxKind.WhileStatement:
      case SyntaxKind.DoStatement:
      case SyntaxKind.CatchClause:
      case SyntaxKind.CaseClause:
        count++;
        break;
    }
  });
  return count + 1; // base path = 1
}

/* ------------------------------------------------------------------ */
/*  Locator & Assertion Pattern Extraction                             */
/* ------------------------------------------------------------------ */

const LOCATOR_PATTERNS = [
  { regex: /getByRole\s*\(/g, label: 'getByRole' },
  { regex: /getByText\s*\(/g, label: 'getByText' },
  { regex: /getByLabel\s*\(/g, label: 'getByLabel' },
  { regex: /getByPlaceholder\s*\(/g, label: 'getByPlaceholder' },
  { regex: /getByTestId\s*\(/g, label: 'getByTestId' },
  { regex: /getByAltText\s*\(/g, label: 'getByAltText' },
  { regex: /data-testid/g, label: 'data-testid' },
  { regex: /data-cy/g, label: 'data-cy' },
  { regex: /data-test/g, label: 'data-test' },
  { regex: /\.locator\s*\(/g, label: 'css-locator' },
  { regex: /cy\.get\s*\(/g, label: 'cy.get' },
  { regex: /\$\$?\s*\(/g, label: '$-selector' },
  { regex: /xpath/gi, label: 'xpath' },
  { regex: /By\.(id|css|xpath|name|className)/g, label: 'selenium-by' },
];

const ASSERTION_PATTERNS = [
  { regex: /expect\s*\(/g, label: 'expect()' },
  { regex: /toBeVisible/g, label: 'toBeVisible' },
  { regex: /toHaveText/g, label: 'toHaveText' },
  { regex: /toContainText/g, label: 'toContainText' },
  { regex: /toHaveURL/g, label: 'toHaveURL' },
  { regex: /toHaveCount/g, label: 'toHaveCount' },
  { regex: /toBeTruthy/g, label: 'toBeTruthy' },
  { regex: /toEqual/g, label: 'toEqual' },
  { regex: /assert\./g, label: 'chai-assert' },
  { regex: /should\(/g, label: 'chai-should' },
  { regex: /cy\..*\.should\(/g, label: 'cy.should' },
];

/**
 * Step-logging / progress-reporting mechanisms. Labels map 1:1 to the
 * `LoggingStyle` union so the context engine can tally them directly. We
 * deliberately separate `test.step` (richest Playwright reports) from
 * `console.log` breadcrumbs, structured `annotations`, and a custom `logger`.
 */
const LOGGING_PATTERNS = [
  { regex: /\btest\.step\s*\(/g, label: 'test-step' },
  { regex: /\.annotations\.push\s*\(|test\.info\s*\(\s*\)\.annotations/g, label: 'annotations' },
  { regex: /\bconsole\.(log|info|debug|warn)\s*\(/g, label: 'console-log' },
  { regex: /\b(logger|log)\.(info|debug|warn|step|trace)\s*\(/g, label: 'logger' },
];

/**
 * Synchronization / waiting strategies. Labels map 1:1 to the `WaitStyle`
 * union. `fixed-timeout` is the anti-pattern we want to detect so generation
 * never propagates hard sleeps even when a repo (accidentally) ships them.
 */
const WAIT_PATTERNS = [
  // Web-first assertions auto-wait — the Playwright-recommended strategy.
  { regex: /\.(?:toBeVisible|toBeEditable|toBeEnabled|toBeHidden|toBeAttached|toHaveText|toContainText|toHaveURL|toHaveValue|toHaveCount)\s*\(/g, label: 'web-first-assertions' },
  { regex: /\.waitForLoadState\s*\(/g, label: 'load-state' },
  { regex: /\.waitFor\s*\(|\.waitForSelector\s*\(/g, label: 'locator-waitfor' },
  { regex: /\.waitForResponse\s*\(|\.waitForRequest\s*\(/g, label: 'response-wait' },
  // Anti-pattern: hard sleeps. Both Playwright and Cypress variants.
  { regex: /\.waitForTimeout\s*\(|cy\.wait\s*\(\s*\d/g, label: 'fixed-timeout' },
];

function extractPatterns(content: string, patterns: Array<{ regex: RegExp; label: string }>): string[] {
  const found = new Set<string>();
  for (const { regex, label } of patterns) {
    // Reset regex state
    const r = new RegExp(regex.source, regex.flags);
    if (r.test(content)) found.add(label);
  }
  return [...found];
}

/* ------------------------------------------------------------------ */
/*  Selector value extraction (for Page Object reuse)                  */
/* ------------------------------------------------------------------ */

export interface ExtractedSelector {
  selector: string;     // e.g. "#user-name" or "button[name=\"Login\"]"
  locatorType: string;  // 'locator' | 'getByRole' | 'getByTestId' | ...
}

/**
 * Statically extract the selector value + locator strategy from a property
 * initializer / constructor assignment / getter body expression.
 *
 * Handles the common Playwright, WebdriverIO, Cypress and Selenium locator
 * forms used inside page objects:
 *   - this.page.locator('#user-name')        → { '#user-name', 'locator' }
 *   - page.getByTestId('username')           → { 'username', 'getByTestId' }
 *   - page.getByRole('button', { name: 'X' })→ { 'button[name="X"]', 'getByRole' }
 *   - $('#user-name') / $$('.row')           → { '#user-name', 'css' }
 *   - cy.get('[data-cy=login]')              → { '[data-cy=login]', 'cy.get' }
 *   - By.id('user-name')                     → { 'user-name', 'By.id' }
 *   - '#user-name' (plain string property)   → { '#user-name', 'css' }
 *
 * Returns null when no selector can be resolved (e.g. dynamic/computed).
 */
export function extractSelectorInfo(expr: string | undefined | null): ExtractedSelector | null {
  if (!expr) return null;
  const text = expr.trim();

  // Playwright semantic locators: getByRole / getByTestId / getByText / ...
  const semantic = text.match(
    /\.(getByRole|getByTestId|getByText|getByLabel|getByPlaceholder|getByAltText|getByTitle)\s*\(\s*(['"`])([\s\S]*?)\2\s*(?:,\s*\{([^}]*)\})?/,
  );
  if (semantic) {
    const method = semantic[1];
    const arg = semantic[3];
    const opts = semantic[4] || '';
    const nameMatch = opts.match(/name\s*:\s*(['"`])([\s\S]*?)\1/);
    const selector = nameMatch ? `${arg}[name=${JSON.stringify(nameMatch[2])}]` : arg;
    return { selector, locatorType: method };
  }

  // page.locator('css') / this.page.locator('css')
  const cssLoc = text.match(/\.locator\s*\(\s*(['"`])([\s\S]*?)\1/);
  if (cssLoc) return { selector: cssLoc[2], locatorType: 'locator' };

  // WebdriverIO-style $('sel') / $$('sel')
  const dollar = text.match(/\$\$?\s*\(\s*(['"`])([\s\S]*?)\1/);
  if (dollar) return { selector: dollar[2], locatorType: 'css' };

  // Cypress cy.get('sel')
  const cyGet = text.match(/cy\.get\s*\(\s*(['"`])([\s\S]*?)\1/);
  if (cyGet) return { selector: cyGet[2], locatorType: 'cy.get' };

  // Selenium By.id('x') / By.css('x') / By.xpath('x') / By.name / By.className
  const by = text.match(/By\.(id|css|xpath|name|className)\s*\(\s*(['"`])([\s\S]*?)\2/);
  if (by) return { selector: by[3], locatorType: `By.${by[1]}` };

  // Plain string property that looks like a selector: '#x' / '.x' / '[x]' / '//x'
  const plain = text.match(/^(['"`])([#.\[/][\s\S]*?)\1$/);
  if (plain) return { selector: plain[2], locatorType: 'css' };

  return null;
}

/* ------------------------------------------------------------------ */
/*  Main AST Analyzer                                                  */
/* ------------------------------------------------------------------ */

export class ASTAnalyzer {
  private project: Project;

  constructor() {
    this.project = new Project({
      compilerOptions: {
        allowJs: true,
        target: 99,             // ESNext
        module: 99,             // ESNext
        moduleResolution: 2,    // Node
        strict: false,
        noEmit: true,
        skipLibCheck: true,
        esModuleInterop: true,
      },
      skipAddingFilesFromTsConfig: true,
    });
  }

  /**
   * Analyze a single file and return structured intelligence.
   */
  analyzeFile(filePath: string, repoRoot: string): FileAnalysis | null {
    if (!fs.existsSync(filePath)) return null;

    const content = fs.readFileSync(filePath, 'utf-8');
    if (content.length > 500_000) {
      logger.warn(MOD, 'Skipping oversized file', { filePath, size: content.length });
      return null;
    }

    const relativePath = path.relative(repoRoot, filePath);
    const language = detectLanguage(filePath);
    if (language !== 'typescript' && language !== 'javascript') return null;

    let sourceFile: SourceFile;
    try {
      sourceFile = this.project.createSourceFile(
        `virtual/${relativePath}`,
        content,
        { overwrite: true },
      );
    } catch (err) {
      logger.warn(MOD, 'Failed to parse file', { filePath, error: (err as Error).message });
      return null;
    }

    const functions = this.extractFunctions(sourceFile, relativePath);
    const classes = this.extractClasses(sourceFile, relativePath);
    const imports = this.extractImports(sourceFile, relativePath);
    const exports = this.extractExports(sourceFile);
    const testCount = this.countTests(sourceFile);
    const locatorPatterns = extractPatterns(content, LOCATOR_PATTERNS);
    const assertionPatterns = extractPatterns(content, ASSERTION_PATTERNS);
    const loggingPatterns = extractPatterns(content, LOGGING_PATTERNS);
    const waitPatterns = extractPatterns(content, WAIT_PATTERNS);

    // Cleanup virtual file to avoid memory leak
    this.project.removeSourceFile(sourceFile);

    return {
      filePath,
      relativePath,
      language,
      functions,
      classes,
      imports,
      exports,
      testCount,
      locatorPatterns,
      assertionPatterns,
      loggingPatterns,
      waitPatterns,
      lineCount: content.split('\n').length,
      hasFixtures: functions.some(f => f.category === 'fixture') || imports.some(i => i.module.includes('fixture')),
      hasPageObject: classes.some(c => c.category === 'page-object') || relativePath.toLowerCase().includes('page'),
    };
  }

  /**
   * Analyze all relevant files in a repository.
   */
  analyzeRepo(repoRoot: string): FileAnalysis[] {
    const start = Date.now();
    const files = this.discoverFiles(repoRoot);
    logger.info(MOD, 'Discovered files for analysis', { count: files.length, repoRoot });

    const results: FileAnalysis[] = [];
    for (const file of files) {
      const analysis = this.analyzeFile(file, repoRoot);
      if (analysis) results.push(analysis);
    }

    logger.info(MOD, 'AST analysis complete', {
      filesAnalyzed: results.length,
      totalFunctions: results.reduce((s, r) => s + r.functions.length, 0),
      totalClasses: results.reduce((s, r) => s + r.classes.length, 0),
      durationMs: Date.now() - start,
    });

    return results;
  }

  /* ---------------------------------------------------------------- */
  /*  Private: Extract Functions                                       */
  /* ---------------------------------------------------------------- */

  private extractFunctions(sf: SourceFile, relPath: string): FunctionSignature[] {
    const fns: FunctionSignature[] = [];

    // Regular function declarations
    for (const fn of sf.getFunctions()) {
      fns.push(this.functionToSignature(fn, relPath));
    }

    // Exported const arrow functions: export const loginAsAdmin = async (...) => { ... }
    for (const varStmt of sf.getVariableStatements()) {
      for (const decl of varStmt.getDeclarations()) {
        const init = decl.getInitializer();
        if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
          const name = decl.getName();
          const isExported = varStmt.isExported();
          const isAsync = init.isAsync?.() ?? false;

          const params = init.getParameters().map(p => ({
            name: p.getName(),
            type: p.getType().getText(p) || 'any',
          }));

          const jsdoc = varStmt.getJsDocs?.()?.map(d => d.getDescription()).join('\n') || '';

          fns.push({
            name,
            filePath: relPath,
            isExported,
            isAsync,
            parameters: params,
            returnType: init.getReturnType?.()?.getText() || 'void',
            jsdoc: jsdoc.slice(0, 500),
            lineNumber: decl.getStartLineNumber(),
            category: categorizeFn(name, relPath, isExported),
            complexity: countComplexity(init),
          });
        }
      }
    }

    return fns;
  }

  private functionToSignature(fn: FunctionDeclaration, relPath: string): FunctionSignature {
    const name = fn.getName() || 'anonymous';
    const isExported = fn.isExported();
    const params = fn.getParameters().map(p => ({
      name: p.getName(),
      type: p.getType().getText(p) || 'any',
    }));

    const jsdoc = fn.getJsDocs?.()?.map(d => d.getDescription()).join('\n') || '';

    return {
      name,
      filePath: relPath,
      isExported,
      isAsync: fn.isAsync(),
      parameters: params,
      returnType: fn.getReturnType?.()?.getText() || 'void',
      jsdoc: jsdoc.slice(0, 500),
      lineNumber: fn.getStartLineNumber(),
      category: categorizeFn(name, relPath, isExported),
      complexity: countComplexity(fn),
    };
  }

  /* ---------------------------------------------------------------- */
  /*  Private: Extract Classes                                         */
  /* ---------------------------------------------------------------- */

  private extractClasses(sf: SourceFile, relPath: string): ClassInfo[] {
    return sf.getClasses().map(cls => {
      const name = cls.getName() || 'AnonymousClass';
      const heritage = cls.getExtends();
      const baseClass = heritage?.getExpression()?.getText() || null;

      const methods = cls.getMethods().map(m => this.methodToSignature(m, relPath));

      // Selectors assigned inside the constructor: `this.usernameInput = page.locator('#user-name')`
      const ctorSelectors = this.extractCtorSelectors(cls);

      const properties = cls.getProperties().map(p => {
        const propName = p.getName();
        // 1) Direct initializer: `readonly usernameInput = this.page.locator('#user-name')`
        let sel = extractSelectorInfo(p.getInitializer()?.getText());
        // 2) Fallback to a matching constructor assignment.
        if (!sel && ctorSelectors.has(propName)) sel = ctorSelectors.get(propName)!;

        return {
          name: propName,
          type: p.getType()?.getText(p) || 'any',
          isReadonly: p.isReadonly(),
          ...(sel ? { selector: sel.selector, locatorType: sel.locatorType } : {}),
        };
      });

      // 3) Getter accessors that return a locator: `get loginButton() { return this.page.getByRole(...) }`
      for (const getter of cls.getGetAccessors()) {
        const getterName = getter.getName();
        if (properties.some(pr => pr.name === getterName)) continue;
        const sel = extractSelectorInfo(getter.getBodyText() || getter.getText());
        if (sel) {
          properties.push({
            name: getterName,
            type: 'Locator',
            isReadonly: true,
            selector: sel.selector,
            locatorType: sel.locatorType,
          });
        }
      }

      return {
        name,
        filePath: relPath,
        isExported: cls.isExported(),
        baseClass,
        methods,
        properties,
        category: categorizeClass(name, relPath, baseClass),
        lineNumber: cls.getStartLineNumber(),
      };
    });
  }

  private methodToSignature(m: MethodDeclaration, relPath: string): FunctionSignature {
    const name = m.getName();
    const params = m.getParameters().map(p => ({
      name: p.getName(),
      type: p.getType().getText(p) || 'any',
    }));
    const jsdoc = m.getJsDocs?.()?.map(d => d.getDescription()).join('\n') || '';

    return {
      name,
      filePath: relPath,
      isExported: true,
      isAsync: m.isAsync(),
      parameters: params,
      returnType: m.getReturnType?.()?.getText() || 'void',
      jsdoc: jsdoc.slice(0, 500),
      lineNumber: m.getStartLineNumber(),
      category: categorizeFn(name, relPath, true),
      complexity: countComplexity(m),
    };
  }

  /**
   * Extract `this.<prop> = <locator expression>` assignments from a class
   * constructor, mapping each property name to its resolved selector. This
   * supports the common POM style where locators are wired up in the ctor:
   *
   *   constructor(page: Page) {
   *     this.usernameInput = page.locator('#user-name');
   *     this.loginButton   = page.getByRole('button', { name: 'Login' });
   *   }
   */
  private extractCtorSelectors(cls: ClassDeclaration): Map<string, ExtractedSelector> {
    const map = new Map<string, ExtractedSelector>();
    try {
      for (const ctor of cls.getConstructors()) {
        const body = ctor.getBodyText() || '';
        const re = /this\.(\w+)\s*=\s*([^;]+);/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(body)) !== null) {
          if (map.has(m[1])) continue;
          const sel = extractSelectorInfo(m[2]);
          if (sel) map.set(m[1], sel);
        }
      }
    } catch {
      /* best-effort — malformed ctor shouldn't break analysis */
    }
    return map;
  }

  /* ---------------------------------------------------------------- */
  /*  Private: Extract Imports & Exports                                */
  /* ---------------------------------------------------------------- */

  private extractImports(sf: SourceFile, relPath: string): ImportInfo[] {
    return sf.getImportDeclarations().map(imp => {
      const mod = imp.getModuleSpecifierValue();
      const named = imp.getNamedImports().map(n => n.getName());
      const def = imp.getDefaultImport()?.getText() || null;

      return {
        module: mod,
        namedImports: named,
        defaultImport: def,
        isRelative: mod.startsWith('.'),
        filePath: relPath,
      };
    });
  }

  private extractExports(sf: SourceFile): string[] {
    const exports: string[] = [];
    for (const sym of sf.getExportSymbols()) {
      exports.push(sym.getName());
    }
    return exports;
  }

  /* ---------------------------------------------------------------- */
  /*  Private: Count Tests                                             */
  /* ---------------------------------------------------------------- */

  private countTests(sf: SourceFile): number {
    let count = 0;
    sf.forEachDescendant(node => {
      if (Node.isCallExpression(node)) {
        const expr = node.getExpression().getText();
        if (/^(test|it|test\.only|it\.only|test\.describe|describe)$/.test(expr)) {
          count++;
        }
      }
    });
    return count;
  }

  /* ---------------------------------------------------------------- */
  /*  Private: File Discovery                                          */
  /* ---------------------------------------------------------------- */

  private discoverFiles(repoRoot: string): string[] {
    const files: string[] = [];
    const SKIP_DIRS = new Set([
      'node_modules', '.git', '.next', 'dist', 'build', 'coverage',
      '.cache', '.yarn', '__pycache__', '.tox', 'venv', '.venv',
      'test-results', 'playwright-report', 'allure-results',
    ]);
    const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
    const MAX_FILES = 2000;

    const walk = (dir: string, depth: number) => {
      if (depth > 10 || files.length >= MAX_FILES) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
            walk(path.join(dir, entry.name), depth + 1);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name);
          if (EXTENSIONS.has(ext)) {
            files.push(path.join(dir, entry.name));
          }
        }
      }
    };

    walk(repoRoot, 0);
    return files;
  }
}
