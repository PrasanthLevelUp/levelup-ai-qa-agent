/**
 * Project Convention Profile  —  THE single source of truth for "how this
 * repository is organised".
 * ============================================================================
 *
 * OWNERSHIP
 * ---------
 * This module belongs to **Repo Intelligence**. It is the one place that
 * answers every "where does X go / which convention should I follow" question:
 *
 *   • Where should a test go?            → testFolder
 *   • Where should a Page Object go?     → pageObjectFolder
 *   • Where should test data go?         → testDataFolder
 *   • Where should fixtures go?          → fixtureFolder
 *   • Which helper folder?               → helperFolder
 *   • Where should API code go?          → apiFolder
 *   • Which naming convention?           → namingConvention
 *   • Which import style?                → importStyle  (+ resolveImportSpecifier)
 *   • Which test-data format?            → testDataPattern
 *   • Which Page Object pattern?         → pageObjectPattern
 *
 * Script Generation (and, later, Healing / Repo Patching / PR Generation /
 * Migration / Framework Conversion / Component Intelligence) must consume this
 * profile instead of inspecting folders or hardcoding conventions themselves.
 *
 * DESIGN
 * ------
 * • Pure / CPU-only — no filesystem, no network. It is a *derived view* of the
 *   already-cached `RepositoryProfile` (built by the repository context engine
 *   and persisted in the `repository_context` table). It is NOT separately
 *   cached — `RepositoryProfile` remains the single persisted source of truth.
 * • Zero-regression defaults — when no profile is available (greenfield) or a
 *   convention is undetected, the resolved value equals the value Script
 *   Generation hardcoded historically. The profile therefore only changes
 *   output for connected repos that genuinely use a different convention.
 */

import type {
  RepositoryProfile,
  TestFramework,
  FolderStructure,
  ClassInfo,
  FunctionSignature,
} from '../context/types';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type ImportStyle = 'relative' | 'alias';
export type TestDataPattern = 'json' | 'ts' | 'mixed';
export type PageObjectPattern = 'class' | 'function' | 'none';
export type NamingConvention =
  | 'PascalCase'
  | 'camelCase'
  | 'snake_case'
  | 'kebab-case'
  | 'mixed';

export interface ProjectConventionProfile {
  /** Test framework the repo uses (or 'unknown' for greenfield). */
  framework: TestFramework;

  /* ── Folder conventions (always resolved — never null) ── */
  testFolder: string;
  pageObjectFolder: string;
  fixtureFolder: string;
  testDataFolder: string;
  helperFolder: string;
  apiFolder: string;

  /* ── Pattern conventions ── */
  pageObjectPattern: PageObjectPattern;
  importStyle: ImportStyle;
  /** Path alias prefix when importStyle === 'alias' (e.g. '@', '~'). */
  importAlias: string | null;
  namingConvention: NamingConvention;
  testDataPattern: TestDataPattern;

  /**
   * Reuse Intelligence — the catalogue of reusable assets the repository
   * already provides. Empty for greenfield. Owned by Repo Intelligence; Script
   * Generation (and Healing / Migration / PR Generation / …) consume it to
   * REUSE before generating rather than duplicating existing assets.
   */
  reuse: ReuseCatalogue;

  /** false ⇒ values are safe greenfield defaults, not derived from a real repo. */
  fromProfile: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Reuse Intelligence — catalogue types                                      */
/* -------------------------------------------------------------------------- */

/** A reusable Page Object the repo already defines. */
export interface ReusablePageObject {
  name: string;
  path: string;
  /** Exported method names (e.g. login, logout). */
  methods: string[];
  /** Property names that carry a resolved selector (the locators it exposes). */
  locators: string[];
  baseClass: string | null;
  framework: TestFramework;
  /** Full scanned detail — used by the selector-level reuse matcher. */
  raw: ClassInfo;
}

/** A reusable helper module (functions grouped by their source file). */
export interface ReusableHelper {
  name: string;            // module name derived from the file (e.g. AuthHelper)
  path: string;
  functions: string[];     // exported function names in that module
}

/** A reusable fixture the repo already defines. */
export interface ReusableFixture {
  name: string;
  path: string;
}

/** A reusable API client (UserApi, OrderApi, …). */
export interface ReusableApi {
  name: string;
  path: string;
}

/** A reusable UI component (HeaderComponent, MenuComponent, …). */
export interface ReusableComponent {
  name: string;
  path: string;
}

/** A reusable test-data asset (users.json, test-data.ts, builders/factories). */
export interface ReusableTestData {
  name: string;
  path: string;
  type: 'json' | 'ts' | 'js' | 'csv';
  recordCount?: number;
}

export interface ReuseCatalogue {
  pageObjects: ReusablePageObject[];
  helpers: ReusableHelper[];
  fixtures: ReusableFixture[];
  apis: ReusableApi[];
  components: ReusableComponent[];
  testData: ReusableTestData[];
}

/** An empty catalogue (greenfield / no connected repo). */
export const EMPTY_REUSE_CATALOGUE: ReuseCatalogue = {
  pageObjects: [],
  helpers: [],
  fixtures: [],
  apis: [],
  components: [],
  testData: [],
};

/* -------------------------------------------------------------------------- */
/*  Zero-regression defaults                                                  */
/*                                                                            */
/*  These MUST equal the values Script Generation hardcoded historically so   */
/*  greenfield generation and the self-contained Test-Case-Lab bundle remain  */
/*  byte-for-byte unchanged.                                                  */
/* -------------------------------------------------------------------------- */

export const DEFAULT_CONVENTIONS = {
  framework: 'playwright' as TestFramework,
  testFolder: 'tests',
  pageObjectFolder: 'pages',
  fixtureFolder: 'fixtures',
  testDataFolder: 'tests/data', // historical hardcoded value for the data module
  helperFolder: 'utils',
  apiFolder: 'api',
  pageObjectPattern: 'class' as PageObjectPattern,
  importStyle: 'relative' as ImportStyle,
  importAlias: null as string | null,
  namingConvention: 'PascalCase' as NamingConvention,
  testDataPattern: 'ts' as TestDataPattern,
} as const;

/* -------------------------------------------------------------------------- */
/*  Builder                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Derive the canonical `ProjectConventionProfile` from a cached
 * `RepositoryProfile`. Pure function. Pass `null`/`undefined` for greenfield
 * generation — every field falls back to the historical default.
 */
export function buildConventionProfile(
  profile?: RepositoryProfile | null,
): ProjectConventionProfile {
  if (!profile) {
    return {
      framework: DEFAULT_CONVENTIONS.framework,
      testFolder: DEFAULT_CONVENTIONS.testFolder,
      pageObjectFolder: DEFAULT_CONVENTIONS.pageObjectFolder,
      fixtureFolder: DEFAULT_CONVENTIONS.fixtureFolder,
      testDataFolder: DEFAULT_CONVENTIONS.testDataFolder,
      helperFolder: DEFAULT_CONVENTIONS.helperFolder,
      apiFolder: DEFAULT_CONVENTIONS.apiFolder,
      pageObjectPattern: DEFAULT_CONVENTIONS.pageObjectPattern,
      importStyle: DEFAULT_CONVENTIONS.importStyle,
      importAlias: DEFAULT_CONVENTIONS.importAlias,
      namingConvention: DEFAULT_CONVENTIONS.namingConvention,
      testDataPattern: DEFAULT_CONVENTIONS.testDataPattern,
      reuse: EMPTY_REUSE_CATALOGUE,
      fromProfile: false,
    };
  }

  const fs: FolderStructure = profile.folderStructure ?? ({} as FolderStructure);

  return {
    framework: profile.framework ?? DEFAULT_CONVENTIONS.framework,

    testFolder: clean(fs.testFolder) ?? DEFAULT_CONVENTIONS.testFolder,
    pageObjectFolder: clean(fs.pageObjectFolder) ?? DEFAULT_CONVENTIONS.pageObjectFolder,
    fixtureFolder: clean(fs.fixtureFolder) ?? DEFAULT_CONVENTIONS.fixtureFolder,
    testDataFolder: clean(fs.testDataFolder) ?? DEFAULT_CONVENTIONS.testDataFolder,
    helperFolder: clean(fs.utilsFolder) ?? DEFAULT_CONVENTIONS.helperFolder,
    apiFolder: clean(fs.apiFolder) ?? DEFAULT_CONVENTIONS.apiFolder,

    pageObjectPattern: detectPageObjectPattern(profile),
    importStyle: detectImportStyle(profile).style,
    importAlias: detectImportStyle(profile).alias,
    namingConvention: detectNamingConvention(profile),
    testDataPattern: detectTestDataPattern(profile),

    reuse: buildReuseCatalogue(profile),

    fromProfile: true,
  };
}

/* -------------------------------------------------------------------------- */
/*  Reuse Intelligence — catalogue builder + "Ask Repo Intelligence" queries  */
/* -------------------------------------------------------------------------- */

const API_NAME_RE = /(api|client|service|endpoint)$/i;
const COMPONENT_NAME_RE = /component$/i;

/**
 * Derive the reuse catalogue from an already-scanned `RepositoryProfile`. Pure
 * function — a faithful, summarised view of the cached profile. Never scans the
 * filesystem and adds no new intelligence; it only re-shapes what the scan
 * already extracted so consumers can ask "what already exists?".
 */
export function buildReuseCatalogue(profile?: RepositoryProfile | null): ReuseCatalogue {
  if (!profile) return EMPTY_REUSE_CATALOGUE;

  const framework = profile.framework ?? DEFAULT_CONVENTIONS.framework;

  /* ── Page Objects ── */
  const pageObjects: ReusablePageObject[] = (profile.pageObjects ?? []).map((c) => ({
    name: c.name,
    path: normalize(c.filePath || ''),
    methods: (c.methods ?? []).map((m) => m.name),
    locators: (c.properties ?? []).filter((p) => !!p.selector).map((p) => p.name),
    baseClass: c.baseClass ?? null,
    framework,
    raw: c,
  }));

  /* ── Helpers (functions grouped into modules by source file) ── */
  const helpers = groupFunctionsByModule(profile.helperFunctions ?? []);

  /* ── Fixtures ── */
  const fixtures: ReusableFixture[] = dedupeByNamePath(
    (profile.fixtures ?? []).map((f) => ({ name: f.name, path: normalize(f.filePath || '') })),
  );

  /* ── Test data ── */
  const testData: ReusableTestData[] = (profile.dataFiles ?? []).map((d) => ({
    name: d.name,
    path: normalize(d.path || ''),
    type: d.type,
    recordCount: d.recordCount,
  }));

  /* ── APIs / Components — derived HONESTLY from names already catalogued ──
     The scan does not retain a dedicated API/component list, so we surface the
     ones whose class/module name clearly signals the role. Empty when none. */
  const namedAssets: Array<{ name: string; path: string }> = [
    ...pageObjects.map((p) => ({ name: p.name, path: p.path })),
    ...helpers.map((h) => ({ name: h.name, path: h.path })),
  ];
  const apis: ReusableApi[] = dedupeByNamePath(
    namedAssets.filter((a) => API_NAME_RE.test(a.name)),
  );
  const components: ReusableComponent[] = dedupeByNamePath(
    namedAssets.filter((a) => COMPONENT_NAME_RE.test(a.name)),
  );

  return { pageObjects, helpers, fixtures, apis, components, testData };
}

/** Group exported helper functions into per-file modules (e.g. AuthHelper). */
function groupFunctionsByModule(fns: FunctionSignature[]): ReusableHelper[] {
  const byFile = new Map<string, { name: string; functions: string[] }>();
  for (const fn of fns) {
    const path = normalize(fn.filePath || '');
    if (!path) continue;
    let entry = byFile.get(path);
    if (!entry) {
      entry = { name: moduleNameFromPath(path), functions: [] };
      byFile.set(path, entry);
    }
    if (fn.name && !entry.functions.includes(fn.name)) entry.functions.push(fn.name);
  }
  return [...byFile.entries()].map(([path, e]) => ({ name: e.name, path, functions: e.functions }));
}

/** Derive a module name from a file path: utils/AuthHelper.ts → AuthHelper. */
function moduleNameFromPath(path: string): string {
  const base = path.split('/').filter(Boolean).pop() || path;
  return base.replace(/\.[a-z0-9]+$/i, '');
}

function dedupeByNamePath<T extends { name: string; path: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const it of items) {
    const key = `${it.name}::${it.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

/** Normalize a name to a comparable token (case/separator-insensitive). */
function reuseNameToken(name: string): string {
  return (name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Normalize a page-object/class name down to its semantic intent so
 * `LoginPage` ≈ `Login` ≈ `LoginPageObject`. Mirrors the historical
 * Script-Generation matcher so reuse decisions are identical.
 */
function pageObjectIntent(name: string): string {
  return reuseNameToken(name).replace(/(pageobject|page|pom|screen|view|component|cmp)$/, '');
}

/**
 * "Does LoginPage already exist?" — find a reusable Page Object by name intent.
 * Returns the catalogued entry (carrying full `raw` detail) or null.
 */
export function findReusablePageObject(
  conv: ProjectConventionProfile,
  name: string,
): ReusablePageObject | null {
  const pos = conv.reuse?.pageObjects ?? [];
  if (!pos.length || !name) return null;
  const wanted = pageObjectIntent(name);
  // 1) exact intent match
  let hit = pos.find((p) => pageObjectIntent(p.name) === wanted);
  // 2) containment (LoginPage vs Login / SignInPage)
  if (!hit) {
    hit = pos.find((p) => {
      const n = pageObjectIntent(p.name);
      return n.length > 2 && wanted.length > 2 && (n.includes(wanted) || wanted.includes(n));
    });
  }
  return hit ?? null;
}

/** "Does AuthHelper exist?" — find a reusable helper module by name. */
export function findReusableHelper(
  conv: ProjectConventionProfile,
  name: string,
): ReusableHelper | null {
  const helpers = conv.reuse?.helpers ?? [];
  if (!helpers.length || !name) return null;
  const wanted = reuseNameToken(name);
  return (
    helpers.find((h) => reuseNameToken(h.name) === wanted) ??
    helpers.find((h) => h.functions.some((f) => reuseNameToken(f) === wanted)) ??
    null
  );
}

/** "Does baseFixture exist?" — find a reusable fixture by name. */
export function findReusableFixture(
  conv: ProjectConventionProfile,
  name: string,
): ReusableFixture | null {
  const fixtures = conv.reuse?.fixtures ?? [];
  if (!fixtures.length || !name) return null;
  const wanted = reuseNameToken(name);
  return fixtures.find((f) => reuseNameToken(f.name) === wanted) ?? null;
}

/** "Does checkout_data.json already exist?" — find a reusable test-data asset. */
export function findReusableTestData(
  conv: ProjectConventionProfile,
  nameOrFile: string,
): ReusableTestData | null {
  const data = conv.reuse?.testData ?? [];
  if (!data.length || !nameOrFile) return null;
  const wanted = reuseNameToken(nameOrFile);
  return (
    data.find((d) => reuseNameToken(d.name) === wanted) ??
    data.find((d) => reuseNameToken(d.path) === wanted) ??
    data.find((d) => reuseNameToken(stripExt(d.name)) === reuseNameToken(stripExt(nameOrFile))) ??
    null
  );
}

/** Find a reusable API client by name. */
export function findReusableApi(
  conv: ProjectConventionProfile,
  name: string,
): ReusableApi | null {
  const apis = conv.reuse?.apis ?? [];
  if (!apis.length || !name) return null;
  const wanted = reuseNameToken(name);
  return apis.find((a) => reuseNameToken(a.name) === wanted) ?? null;
}

/** Find a reusable component by name. */
export function findReusableComponent(
  conv: ProjectConventionProfile,
  name: string,
): ReusableComponent | null {
  const components = conv.reuse?.components ?? [];
  if (!components.length || !name) return null;
  const wanted = reuseNameToken(name);
  return components.find((c) => reuseNameToken(c.name) === wanted) ?? null;
}

/** True when the repository provides ANY reusable asset. */
export function hasReusableAssets(conv: ProjectConventionProfile): boolean {
  const r = conv.reuse;
  if (!r) return false;
  return (
    r.pageObjects.length > 0 ||
    r.helpers.length > 0 ||
    r.fixtures.length > 0 ||
    r.apis.length > 0 ||
    r.components.length > 0 ||
    r.testData.length > 0
  );
}

/* -------------------------------------------------------------------------- */
/*  Resolvers — the "ask Repo Intelligence" API                               */
/* -------------------------------------------------------------------------- */

/** Absolute (repo-root-relative) path where the shared test-data module lives. */
export function resolveTestDataModulePath(
  conv: ProjectConventionProfile,
  fileName = 'test-data.ts',
): string {
  return joinPath(conv.testDataFolder, fileName);
}

/** Repo-root-relative path for a fixture file. */
export function resolveFixturePath(conv: ProjectConventionProfile, fileName: string): string {
  return joinPath(conv.fixtureFolder, fileName);
}

/** Repo-root-relative path for a helper/utils file. */
export function resolveHelperPath(conv: ProjectConventionProfile, fileName: string): string {
  return joinPath(conv.helperFolder, fileName);
}

/**
 * Produce the import specifier a file in `fromDir` should use to import a
 * module located at `toModulePath` (repo-root-relative, WITHOUT extension).
 *
 * For the default `relative` style this returns e.g. `./data/test-data` or
 * `../data/test-data`. For `alias` style it returns `@/data/test-data`.
 */
export function resolveImportSpecifier(
  conv: ProjectConventionProfile,
  fromDir: string,
  toModulePath: string,
): string {
  const to = stripExt(normalize(toModulePath));
  if (conv.importStyle === 'alias' && conv.importAlias) {
    const prefix = conv.importAlias.endsWith('/') ? conv.importAlias : `${conv.importAlias}/`;
    return `${prefix}${to}`;
  }
  return relativeSpecifier(normalize(fromDir), to);
}

/* -------------------------------------------------------------------------- */
/*  Detection helpers                                                         */
/* -------------------------------------------------------------------------- */

function detectPageObjectPattern(profile: RepositoryProfile): PageObjectPattern {
  if ((profile.pageObjects?.length ?? 0) > 0) return 'class';
  if (profile.testPattern === 'page-object-model' || profile.folderStructure?.pageObjectFolder) {
    return 'class';
  }
  if (profile.testPattern === 'flat-scripts') return 'none';
  return DEFAULT_CONVENTIONS.pageObjectPattern;
}

/**
 * Import style detection is intentionally conservative: unless the repo clearly
 * signals a path alias, we report `relative` so generated imports are unchanged.
 * (Robust alias detection requires tsconfig `paths` parsing, which is not part
 * of the cached profile today — exposed here for future enrichment.)
 */
function detectImportStyle(profile: RepositoryProfile): { style: ImportStyle; alias: string | null } {
  const deps = profile.dependencies ?? [];
  const hasModuleAlias = deps.some(
    d => d.name === 'module-alias' || d.name === 'tsconfig-paths',
  );
  if (hasModuleAlias) return { style: 'alias', alias: '@' };
  return { style: DEFAULT_CONVENTIONS.importStyle, alias: DEFAULT_CONVENTIONS.importAlias };
}

function detectNamingConvention(profile: RepositoryProfile): NamingConvention {
  const c = profile.codingStyle?.namingConvention;
  if (c === 'PascalCase' || c === 'camelCase' || c === 'snake_case' || c === 'kebab-case' || c === 'mixed') {
    return c;
  }
  return DEFAULT_CONVENTIONS.namingConvention;
}

function detectTestDataPattern(profile: RepositoryProfile): TestDataPattern {
  const files = profile.dataFiles ?? [];
  if (files.length === 0) return DEFAULT_CONVENTIONS.testDataPattern; // 'ts' — matches emission
  let json = 0;
  let ts = 0;
  for (const f of files) {
    if (f.type === 'json' || f.type === 'csv') json++;
    else if (f.type === 'ts' || f.type === 'js') ts++;
  }
  if (json > 0 && ts === 0) return 'json';
  if (ts > 0 && json === 0) return 'ts';
  return 'mixed';
}

/* -------------------------------------------------------------------------- */
/*  Path utilities (POSIX, repo-root-relative)                                */
/* -------------------------------------------------------------------------- */

/** Strip leading "./" or "/" and trailing "/" from a folder path; null-safe. */
function clean(p: string | null | undefined): string | null {
  if (!p) return null;
  const c = p.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '').trim();
  return c.length ? c : null;
}

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function joinPath(dir: string, file: string): string {
  const d = normalize(dir);
  return d ? `${d}/${file}` : file;
}

function stripExt(p: string): string {
  // Drop a single trailing extension (e.g. test-data.ts → test-data). Keep
  // compound names intact otherwise.
  return p.replace(/\.[a-z0-9]+$/i, '');
}

/** Compute a relative import specifier from `fromDir` to `toPath` (no ext). */
function relativeSpecifier(fromDir: string, toPath: string): string {
  const from = fromDir ? fromDir.split('/').filter(Boolean) : [];
  const to = toPath.split('/').filter(Boolean);

  let i = 0;
  while (i < from.length && i < to.length && from[i] === to[i]) i++;

  const ups = from.length - i;
  const downs = to.slice(i);

  let spec: string;
  if (ups === 0) {
    spec = `./${downs.join('/')}`;
  } else {
    spec = `${'../'.repeat(ups)}${downs.join('/')}`;
  }
  return spec.replace(/\/+$/, '');
}
