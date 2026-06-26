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

import type { RepositoryProfile, TestFramework, FolderStructure } from '../context/types';

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

  /** false ⇒ values are safe greenfield defaults, not derived from a real repo. */
  fromProfile: boolean;
}

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

    fromProfile: true,
  };
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
