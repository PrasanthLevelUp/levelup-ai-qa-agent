/**
 * Repository Intelligence — Type Definitions
 *
 * Shared types for the entire Repository Context Engine.
 */

/* ------------------------------------------------------------------ */
/*  Framework & Language Detection                                     */
/* ------------------------------------------------------------------ */

export type TestFramework =
  | 'playwright'
  | 'cypress'
  | 'selenium'
  | 'puppeteer'
  | 'webdriverio'
  | 'testcafe'
  | 'jest'
  | 'mocha'
  | 'unknown';

export type Language = 'typescript' | 'javascript' | 'python' | 'java' | 'csharp' | 'unknown';

export type TestPattern =
  | 'page-object-model'
  | 'screenplay'
  | 'keyword-driven'
  | 'bdd-cucumber'
  | 'flat-scripts'
  | 'hybrid'
  | 'unknown';

export type LocatorStrategy =
  | 'data-testid'
  | 'data-cy'
  | 'data-test'
  | 'role-based'
  | 'css-selectors'
  | 'xpath'
  | 'mixed';

/* ------------------------------------------------------------------ */
/*  AST Analysis Results                                               */
/* ------------------------------------------------------------------ */

export interface FunctionSignature {
  name: string;
  filePath: string;
  isExported: boolean;
  isAsync: boolean;
  parameters: Array<{ name: string; type: string }>;
  returnType: string;
  jsdoc: string;
  lineNumber: number;
  category: 'helper' | 'page-object' | 'fixture' | 'hook' | 'utility' | 'test' | 'config' | 'unknown';
  complexity: number; // cyclomatic-ish (branches + loops)
}

export interface ClassInfo {
  name: string;
  filePath: string;
  isExported: boolean;
  baseClass: string | null;
  methods: FunctionSignature[];
  properties: Array<{
    name: string;
    type: string;
    isReadonly: boolean;
    /**
     * The actual selector value extracted from the property initializer,
     * constructor assignment, or getter return — e.g. "#user-name" or
     * "button[name='login']". Undefined when the property is not a locator
     * or the selector could not be statically resolved.
     */
    selector?: string;
    /**
     * How the selector is expressed: 'locator' (page.locator), 'getByRole',
     * 'getByTestId', 'getByText', 'getByLabel', 'getByPlaceholder', 'css', etc.
     */
    locatorType?: string;
  }>;
  category: 'page-object' | 'fixture' | 'base-class' | 'utility' | 'unknown';
  lineNumber: number;
}

export interface ImportInfo {
  module: string;
  namedImports: string[];
  defaultImport: string | null;
  isRelative: boolean;
  filePath: string;
}

export interface FileAnalysis {
  filePath: string;
  relativePath: string;
  language: Language;
  functions: FunctionSignature[];
  classes: ClassInfo[];
  imports: ImportInfo[];
  exports: string[];
  testCount: number;              // number of test() / it() / describe() calls
  locatorPatterns: string[];      // unique locator patterns found
  assertionPatterns: string[];    // assertion styles used
  loggingPatterns: string[];      // step-reporting / logging styles used (test.step, console.log, annotations, ...)
  waitPatterns: string[];         // synchronization styles used (waitForLoadState, locator.waitFor, expect-visible, waitForTimeout, ...)
  lineCount: number;
  hasFixtures: boolean;
  hasPageObject: boolean;
  /**
   * Per-test raw facts extracted from THIS file during the same AST pass
   * (Sprint RCI-1). One entry per test()/it() declaration. These are raw
   * signals only — feature/flow/page classification and confidence scoring
   * happen later in the Repository Context Engine (extractTestInventory),
   * keeping AST parsing and business classification cleanly separated.
   */
  tests: TestCaseAnalysis[];
}

/**
 * Raw per-test facts captured by the AST analyzer (Sprint RCI-1). Purely
 * mechanical extraction — no interpretation. The Repository Context Engine
 * turns these into classified TestInventoryEntry records.
 */
export interface TestCaseAnalysis {
  testName: string;
  describeName: string | null;   // nearest enclosing describe/context/suite title
  tags: string[];                // @smoke, @tc:TC1234, etc. (from title + body)
  assertions: string[];          // matcher names / cypress should:... assertions
  pomMethods: string[];          // Page-Object method calls exercised by the test
  line: number;                  // 1-based line number of the test declaration
}

/* ------------------------------------------------------------------ */
/*  Repository Intelligence Profile                                    */
/* ------------------------------------------------------------------ */

export interface FolderStructure {
  testFolder: string | null;       // e.g. /tests, /test, /specs, /e2e
  pageObjectFolder: string | null; // e.g. /pages, /page-objects, /pom
  fixtureFolder: string | null;    // e.g. /fixtures, /support
  utilsFolder: string | null;      // e.g. /utils, /helpers, /lib
  testDataFolder: string | null;   // e.g. /data, /test-data, /tests/data, /fixtures/data
  apiFolder: string | null;        // e.g. /api, /apis, /services, /endpoints
  configFiles: string[];           // playwright.config.ts, cypress.config.ts, etc.
  supportFiles: string[];          // setup/teardown files
}

/**
 * How the repo surfaces step progress in tests/reports. This is a SEPARATE
 * axis from `stepStyle` (which captures GWT vs AAA *structure*): `loggingStyle`
 * captures the *mechanism* — Playwright `test.step()` blocks, `console.log`
 * breadcrumbs, `test.info().annotations.push(...)`, or none. Generation mirrors
 * this so emitted scripts read like the team already writes them.
 */
export type LoggingStyle =
  | 'test-step'      // await test.step('...', async () => { ... })  (richest reports)
  | 'console-log'    // console.log('...') breadcrumbs
  | 'annotations'    // test.info().annotations.push({ type, description })
  | 'logger'         // a custom logger util (logger.info(...), log(...))
  | 'none'           // no step logging detected
  | 'mixed';

/**
 * How the repo synchronizes with the app under test. Captured so generated
 * scripts adopt the team's waiting discipline instead of guessing — and so we
 * can flag the `waitForTimeout` anti-pattern when a repo (accidentally) uses it.
 */
export type WaitStyle =
  | 'web-first-assertions' // relies on auto-waiting expect(locator).toBeVisible()/toBeEditable()
  | 'load-state'           // page.waitForLoadState('networkidle'|'load'|'domcontentloaded')
  | 'locator-waitfor'      // locator.waitFor() / waitForSelector — explicit element waits
  | 'response-wait'        // page.waitForResponse/waitForRequest — network-driven sync
  | 'fixed-timeout'        // page.waitForTimeout(ms) — ANTI-PATTERN, surfaced as a warning
  | 'none'                 // no explicit synchronization detected
  | 'mixed';

export interface CodingStyle {
  namingConvention: 'camelCase' | 'snake_case' | 'kebab-case' | 'PascalCase' | 'mixed';
  testNaming: string;             // e.g. 'should_do_x_when_y', 'TC01-descriptive'
  stepStyle: 'given_when_then' | 'arrange_act_assert' | 'flat' | 'mixed';
  tagConvention: string | null;   // e.g. '@smoke', '@regression'
  indentStyle: 'spaces-2' | 'spaces-4' | 'tabs' | 'mixed';
  quoteStyle: 'single' | 'double' | 'mixed';
  semicolons: boolean;
  /**
   * Dominant step-logging mechanism the repo uses (test.step / console.log /
   * annotations / logger / none). Drives how generated scripts report progress.
   */
  loggingStyle: LoggingStyle;
  /**
   * All logging mechanisms observed, most-used first (e.g. ['test-step','console-log']).
   * Lets the generator prefer the dominant one while knowing the secondary exists.
   */
  loggingStyles: LoggingStyle[];
  /**
   * Dominant synchronization strategy (web-first-assertions / load-state /
   * locator-waitfor / response-wait / fixed-timeout / none). Drives the wait
   * code emitted for navigation and post-action sync.
   */
  waitStyle: WaitStyle;
  /** All wait strategies observed, most-used first. */
  waitStyles: WaitStyle[];
  /**
   * True when the repo uses `page.waitForTimeout(...)` (hard sleeps). Surfaced
   * so the generator can AVOID propagating the anti-pattern even if present.
   */
  usesFixedTimeouts: boolean;
}

export interface RepositoryProfile {
  // Core identity
  framework: TestFramework;
  language: Language;
  testPattern: TestPattern;
  locatorStrategy: LocatorStrategy;

  // Structure
  folderStructure: FolderStructure;
  totalFiles: number;
  totalTestFiles: number;
  totalHelperFiles: number;
  totalLineCount: number;

  // Coding conventions
  codingStyle: CodingStyle;

  // Reusable assets (the critical stuff)
  helperFunctions: FunctionSignature[];
  pageObjects: ClassInfo[];
  fixtures: FunctionSignature[];
  customCommands: FunctionSignature[];
  sharedConstants: Array<{ name: string; value: string; filePath: string }>;
  dataFiles: Array<{ name: string; path: string; type: 'json' | 'ts' | 'js' | 'csv'; recordCount?: number }>;

  // Environment awareness: how the framework is configured at runtime.
  environment: {
    envFiles: string[];          // .env, .env.example, .env.local, etc.
    usesDotenv: boolean;         // depends on / imports dotenv
    configModule: string | null; // e.g. utils/env.ts — the env loader/validator
    envVars: string[];           // process.env.X names referenced in source
  };

  // Business intelligence
  businessFlows: BusinessFlow[];
  testSuites: TestSuiteInfo[];

  // Repository Test Inventory (Sprint RCI-1): one deterministic entry per test
  // already present in the repo, classified by feature/flow/page with a
  // transparent confidence score. This is what "understand before generate"
  // consumes — surfaced in the Repository Intelligence "Test Inventory" view
  // and later mapped to requirements by Coverage Intelligence (RCI-2).
  testInventory: TestInventoryEntry[];

  // Coverage Summary (Repository Intelligence Phase 2): a deterministic
  // per-feature rollup of the Test Inventory — how many tests exist for each
  // feature area, so users immediately see where the repo is heavily tested
  // versus sparse. NO requirements comparison here (that is Coverage
  // Intelligence Phase 1 / RCI-2); this is pure aggregation of what exists.
  coverageSummary: CoverageSummaryEntry[];

  // Locator patterns
  preferredLocators: Array<{ pattern: string; count: number; example: string }>;
  avoidPatterns: string[];

  // Dependencies
  dependencies: Array<{ name: string; version: string; isDev: boolean }>;
  assertionLibrary: string;
  hasApiLayer: boolean;
  hasCustomFixtures: boolean;
  hasMocking: boolean;
  hasVisualTesting: boolean;
  ciIntegration: string | null; // github-actions, jenkins, gitlab-ci, etc.
}

/* ------------------------------------------------------------------ */
/*  Business Flows                                                     */
/* ------------------------------------------------------------------ */

export interface BusinessFlow {
  name: string;                  // e.g. 'Login Flow', 'Checkout Flow'
  steps: string[];               // ordered step descriptions
  relatedFiles: string[];        // test files that implement this flow
  relatedHelpers: string[];      // helper functions used in this flow
  entryUrl: string | null;       // starting URL if detectable
  category: 'auth' | 'navigation' | 'crud' | 'search' | 'payment' | 'form' | 'admin' | 'general';
}

export interface TestSuiteInfo {
  name: string;
  filePath: string;
  testCount: number;
  testNames: string[];
  describeName: string | null;
  tags: string[];
  category: string;              // auth, navigation, crud, etc.
}

/* ------------------------------------------------------------------ */
/*  Repository Test Inventory (Sprint RCI-1)                          */
/* ------------------------------------------------------------------ */

/**
 * One deterministically-classified test discovered in the repository. Emitted
 * by the Repository Context Engine's extractTestInventory() from the raw
 * per-test facts the AST analyzer captured. NO LLM / embeddings / generation —
 * pure static analysis, fully reproducible for a given tree.
 */
export interface TestInventoryEntry {
  testName: string;
  filePath: string;             // repo-relative source path
  feature: string | null;       // e.g. 'Authentication', 'Checkout'
  flow: string | null;          // e.g. 'login', 'add-to-cart'
  page: string | null;          // page/screen under test (from POM or URL)
  suite: string | null;         // enclosing describe/context title, if any
  tags: string[];               // @smoke, @tc:TC1234, ...
  assertions: string[];         // matcher names / cypress should:... assertions
  pomMethods: string[];         // Page-Object methods the test exercises
  framework: TestFramework;     // inherited from the repo-level detection
  confidence: number;           // 0-100, transparent signal-based heuristic
  /** Auditable breakdown of how feature/confidence were derived. */
  metadata: {
    line: number;
    assertionCount: number;
    pomMethodCount: number;
    featureSource: 'describe' | 'keyword' | 'filename';
  };
}

/**
 * One row of the per-feature Coverage Summary — a deterministic rollup of the
 * Test Inventory. This answers "where is this repo heavily tested vs sparse?"
 * WITHOUT any requirements data. It is the bridge into Coverage Intelligence
 * (Phase 1 / RCI-2), which will later compare these features against a
 * requirements dataset to compute covered / partial / missing.
 */
export interface CoverageSummaryEntry {
  feature: string;              // e.g. 'Authentication', 'Checkout'
  testCount: number;            // number of inventory tests in this feature
  percentage: number;          // share of total inventory tests, 0-100 (rounded)
  avgConfidence: number;        // mean inventory confidence for this feature, 0-100
}

/* ------------------------------------------------------------------ */
/*  Code Chunks (for future embedding/vector search)                   */
/* ------------------------------------------------------------------ */

export interface CodeChunk {
  filePath: string;
  chunkType: 'function' | 'class' | 'test' | 'fixture' | 'config' | 'flow';
  chunkName: string;
  content: string;
  metadata: Record<string, any>;
  lineStart: number;
  lineEnd: number;
}

/* ------------------------------------------------------------------ */
/*  DB Row Types                                                       */
/* ------------------------------------------------------------------ */

export interface RepositoryContextRow {
  id: number;
  company_id: number | null;
  repo_url: string;
  repo_branch: string;
  framework: string;
  language: string;
  test_pattern: string;
  locator_strategy: string;
  folder_structure: any;         // JSONB
  coding_style: any;             // JSONB
  helper_functions: any;         // JSONB
  page_objects: any;             // JSONB
  fixtures: any;                 // JSONB
  business_flows: any;           // JSONB
  test_suites: any;              // JSONB
  preferred_locators: any;       // JSONB
  dependencies: any;             // JSONB
  total_files: number;
  total_test_files: number;
  total_line_count: number;
  profile_version: number;
  scan_duration_ms: number;
  last_scanned_at: string;
  created_at: string;
  updated_at: string;
}

export interface CodeChunkRow {
  id: number;
  company_id: number | null;
  repo_context_id: number;
  file_path: string;
  chunk_type: string;
  chunk_name: string;
  content: string;
  metadata: any;
  line_start: number;
  line_end: number;
  created_at: string;
}
