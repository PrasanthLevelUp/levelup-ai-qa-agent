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
  lineCount: number;
  hasFixtures: boolean;
  hasPageObject: boolean;
}

/* ------------------------------------------------------------------ */
/*  Repository Intelligence Profile                                    */
/* ------------------------------------------------------------------ */

export interface FolderStructure {
  testFolder: string | null;       // e.g. /tests, /test, /specs, /e2e
  pageObjectFolder: string | null; // e.g. /pages, /page-objects, /pom
  fixtureFolder: string | null;    // e.g. /fixtures, /support
  utilsFolder: string | null;      // e.g. /utils, /helpers, /lib
  configFiles: string[];           // playwright.config.ts, cypress.config.ts, etc.
  supportFiles: string[];          // setup/teardown files
}

export interface CodingStyle {
  namingConvention: 'camelCase' | 'snake_case' | 'kebab-case' | 'PascalCase' | 'mixed';
  testNaming: string;             // e.g. 'should_do_x_when_y', 'TC01-descriptive'
  stepStyle: 'given_when_then' | 'arrange_act_assert' | 'flat' | 'mixed';
  tagConvention: string | null;   // e.g. '@smoke', '@regression'
  indentStyle: 'spaces-2' | 'spaces-4' | 'tabs' | 'mixed';
  quoteStyle: 'single' | 'double' | 'mixed';
  semicolons: boolean;
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
