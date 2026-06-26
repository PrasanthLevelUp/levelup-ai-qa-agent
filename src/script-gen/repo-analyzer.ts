/**
 * Repository Structure Analyzer
 *
 * Analyzes a RepositoryProfile (from the Repo Intelligence engine) to
 * produce a structured analysis that the code-generation layer uses
 * to decide *how* to emit files — flat-scripts, POM, hybrid, etc.
 *
 * This module never touches the network or filesystem; it operates
 * entirely on the in-memory RepositoryProfile.
 */

import type {
  RepositoryProfile,
  TestPattern,
  FolderStructure,
  CodingStyle,
  TestSuiteInfo,
} from '../context/types';
import {
  buildConventionProfile,
  type ProjectConventionProfile,
} from '../intelligence/project-convention-profile';

/* ------------------------------------------------------------------ */
/*  Public Types                                                        */
/* ------------------------------------------------------------------ */

/** The generation "shape" we'll emit. */
export type GenerationMode = 'flat' | 'pom' | 'hybrid';

/** Convention for translating a flow name into a file name. */
export interface NamingConvention {
  /** e.g. 'NN_description.spec.ts' */
  pattern: string;
  /** separator between the number prefix and the descriptive part */
  separator: string;
  /** how to case the descriptive part */
  casing: 'snake_case' | 'kebab-case' | 'camelCase' | 'PascalCase' | 'mixed';
  /** e.g. '.spec.ts' */
  extension: string;
  /** whether existing files use a numeric prefix */
  usesNumberPrefix: boolean;
}

export interface RepoStructureAnalysis {
  /* ── Layout ── */
  mode: GenerationMode;

  /* ── File naming ── */
  naming: NamingConvention;
  /** The next numeric prefix to use (e.g. 8 if the repo already has 01–07) */
  nextFileNumber: number;
  /** Test folder path (e.g. 'tests') */
  testDir: string;

  /* ── Page-object layout (POM repos) ── */
  /** Folder where page objects live (e.g. 'pages', 'page-objects'). */
  pageObjectDir: string;
  /**
   * Naming convention for page-object files, derived from the repo's
   * existing page objects (e.g. PascalCase `LoginPage.ts` rather than the
   * framework-default kebab-case `login-page.page.ts`).
   */
  pageObjectNaming: NamingConvention;

  /* ── Existing assets — things we must NOT overwrite ── */
  hasPlaywrightConfig: boolean;
  hasCIWorkflow: boolean;
  hasFixtures: boolean;
  hasUtils: boolean;
  hasPageObjects: boolean;
  /** Whether the repo already ships a README — avoid clobbering it */
  hasReadme: boolean;
  /** Whether the repo already has an env example / dotenv setup */
  hasEnvExample: boolean;
  existingTestFiles: string[];

  /* ── Style ── */
  tagPattern: string | null;      // e.g. '@smoke', '@login-positive'
  quoteStyle: 'single' | 'double' | 'mixed';
  semicolons: boolean;
  indentStyle: string;            // e.g. 'spaces-2'

  /** How the repo supplies credentials (inline, env, fixture, unknown) */
  credentialStyle: 'inline' | 'env' | 'fixture' | 'unknown';

  /**
   * The canonical Project Convention Profile (owned by Repo Intelligence).
   * Script Generation reads folder/import/naming conventions from here instead
   * of hardcoding them. Folders are always resolved (never null) and default to
   * the historical hardcoded values, so connected-repo behaviour only changes
   * when the repo genuinely uses a different convention.
   */
  conventions: ProjectConventionProfile;
}

/* ------------------------------------------------------------------ */
/*  Main Analyzer                                                       */
/* ------------------------------------------------------------------ */

/**
 * Derive a `RepoStructureAnalysis` from a stored `RepositoryProfile`.
 * Pure function — no side effects.
 */
export function analyzeRepoStructure(profile: RepositoryProfile): RepoStructureAnalysis {
  const mode = detectMode(profile);
  const testDir = detectTestDir(profile.folderStructure);
  const existingTestFiles = extractTestFilePaths(profile);
  const naming = detectNaming(existingTestFiles, profile.codingStyle);
  const nextFileNumber = computeNextNumber(existingTestFiles, naming);
  const pageObjectDir = detectPageObjectDir(profile.folderStructure);
  const pageObjectNaming = detectPageObjectNaming(profile);

  return {
    mode,
    naming,
    nextFileNumber,
    testDir,
    pageObjectDir,
    pageObjectNaming,

    hasPlaywrightConfig: hasConfigFile(profile.folderStructure, 'playwright.config'),
    hasCIWorkflow: !!profile.ciIntegration || hasCIFiles(profile.folderStructure),
    hasFixtures: profile.hasCustomFixtures || !!profile.folderStructure.fixtureFolder,
    hasUtils: !!profile.folderStructure.utilsFolder,
    hasPageObjects: !!profile.folderStructure.pageObjectFolder || profile.pageObjects.length > 0,
    hasReadme: hasReadmeFile(profile.folderStructure),
    hasEnvExample: hasEnvFile(profile.folderStructure, profile),
    existingTestFiles,

    tagPattern: profile.codingStyle.tagConvention || null,
    quoteStyle: profile.codingStyle.quoteStyle ?? 'single',
    semicolons: profile.codingStyle.semicolons ?? true,
    indentStyle: profile.codingStyle.indentStyle ?? 'spaces-2',

    credentialStyle: detectCredentialStyle(profile),

    conventions: buildConventionProfile(profile),
  };
}

/* ------------------------------------------------------------------ */
/*  Internal Helpers                                                    */
/* ------------------------------------------------------------------ */

function detectMode(profile: RepositoryProfile): GenerationMode {
  const tp: TestPattern = profile.testPattern;

  if (tp === 'flat-scripts') return 'flat';
  if (tp === 'page-object-model') return 'pom';
  if (tp === 'hybrid') return 'hybrid';

  // Heuristics for 'unknown' / other patterns
  if (profile.pageObjects.length > 0 || profile.folderStructure.pageObjectFolder) return 'pom';
  if (profile.totalTestFiles > 0 && profile.pageObjects.length === 0) return 'flat';

  return 'pom'; // safe default — existing behaviour
}

function detectTestDir(fs: FolderStructure): string {
  if (fs.testFolder) {
    // Strip leading slash / "./"
    return fs.testFolder.replace(/^\.?\//, '');
  }
  return 'tests'; // Playwright default
}

function detectPageObjectDir(fs: FolderStructure): string {
  if (fs.pageObjectFolder) {
    return fs.pageObjectFolder.replace(/^\.?\//, '').replace(/\/$/, '');
  }
  return 'pages'; // POM default
}

/**
 * Derive the naming convention used by the repo's existing page-object files.
 *
 * This is what lets us emit `LoginPage.ts` (PascalCase, plain `.ts`) for a repo
 * that already follows that convention, instead of the framework-default
 * kebab-case `login-page.page.ts`.
 */
function detectPageObjectNaming(profile: RepositoryProfile): NamingConvention {
  const baseNames = (profile.pageObjects ?? [])
    .map(po => (po.filePath || '').split('/').pop() || '')
    .filter(Boolean);

  // Fall back to the repo-wide naming convention when no page objects exist yet.
  if (baseNames.length === 0) {
    const casing = (profile.codingStyle?.namingConvention ?? 'PascalCase') as NamingConvention['casing'];
    const separator = casing === 'snake_case' ? '_' : casing === 'kebab-case' ? '-' : '';
    return {
      pattern: `Name.page.ts`,
      separator,
      casing: casing === 'mixed' ? 'PascalCase' : casing,
      extension: '.page.ts',
      usesNumberPrefix: false,
    };
  }

  // Detect extension (e.g. '.page.ts' vs '.ts').
  const extMatch = baseNames[0].match(/(\.\w+\.\w+|\.\w+)$/);
  const extension = extMatch ? extMatch[0] : '.ts';

  // Strip the extension to inspect the descriptive part.
  const descriptiveParts = baseNames
    .map(n => n.replace(/(\.\w+\.\w+|\.\w+)$/, ''))
    .filter(Boolean);

  let casing: NamingConvention['casing'] = 'PascalCase';
  let separator = '';

  if (descriptiveParts.length > 0) {
    const kebabCount = descriptiveParts.filter(d => d.includes('-')).length;
    const snakeCount = descriptiveParts.filter(d => d.includes('_')).length;
    const pascalCount = descriptiveParts.filter(d => /^[A-Z][a-zA-Z0-9]*$/.test(d) && /[a-z]/.test(d)).length;
    const camelCount = descriptiveParts.filter(d => /^[a-z][a-zA-Z0-9]*$/.test(d) && /[A-Z]/.test(d)).length;

    if (kebabCount > snakeCount && kebabCount >= pascalCount) {
      casing = 'kebab-case';
      separator = '-';
    } else if (snakeCount > 0 && snakeCount >= pascalCount) {
      casing = 'snake_case';
      separator = '_';
    } else if (pascalCount >= camelCount && pascalCount > 0) {
      casing = 'PascalCase';
      separator = '';
    } else if (camelCount > 0) {
      casing = 'camelCase';
      separator = '';
    } else {
      // Single-word names with no separators → honour repo coding style.
      casing = (profile.codingStyle?.namingConvention as NamingConvention['casing']) ?? 'PascalCase';
      if (casing === 'mixed') casing = 'PascalCase';
      separator = casing === 'snake_case' ? '_' : casing === 'kebab-case' ? '-' : '';
    }
  }

  return {
    pattern: `Name${extension}`,
    separator,
    casing,
    extension,
    usesNumberPrefix: false,
  };
}

/* ------------------------------------------------------------------ */
/*  Shared file-name builders (used by the default POM generator)       */
/* ------------------------------------------------------------------ */

/** Split a raw name (camelCase, "Login Page", "login_page", etc.) into lowercase words. */
function splitWords(raw: string): string[] {
  return raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // split camelCase / PascalCase
    .replace(/[^a-zA-Z0-9]+/g, ' ')         // separators → space
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.toLowerCase());
}

/** Apply a casing convention to a list of words. */
export function applyCasing(words: string[], casing: NamingConvention['casing'], separator = '-'): string {
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  switch (casing) {
    case 'snake_case':
      return words.join('_');
    case 'kebab-case':
      return words.join('-');
    case 'camelCase':
      return words.map((w, i) => (i === 0 ? w : cap(w))).join('');
    case 'PascalCase':
      return words.map(cap).join('');
    default:
      return words.join(separator || '-');
  }
}

/**
 * Build a page-object file name from a raw page-object name using the
 * repo's detected convention (e.g. "Login Page" → `LoginPage.ts`).
 */
export function buildPageObjectFileName(rawName: string, naming: NamingConvention): string {
  const words = splitWords(rawName);
  if (words.length === 0) return `Page${naming.extension}`;
  return `${applyCasing(words, naming.casing, naming.separator)}${naming.extension}`;
}

/**
 * Build a test spec file name from a flow name using the repo's detected
 * convention, optionally prefixing a zero-padded number.
 */
export function buildSpecFileName(flowName: string, naming: NamingConvention, num = 1): string {
  const words = splitWords(flowName);
  const desc = words.length > 0 ? applyCasing(words, naming.casing, naming.separator) : 'test';
  if (naming.usesNumberPrefix) {
    const prefix = String(num).padStart(2, '0');
    return `${prefix}${naming.separator || '-'}${desc}${naming.extension}`;
  }
  return `${desc}${naming.extension}`;
}

function extractTestFilePaths(profile: RepositoryProfile): string[] {
  const paths: string[] = [];
  for (const suite of profile.testSuites ?? []) {
    if (suite.filePath) paths.push(suite.filePath);
  }
  return paths;
}

function detectNaming(
  testFiles: string[],
  codingStyle: CodingStyle,
): NamingConvention {
  if (testFiles.length === 0) {
    // No existing files → use framework-standard kebab
    return {
      pattern: 'description.spec.ts',
      separator: '-',
      casing: 'kebab-case',
      extension: '.spec.ts',
      usesNumberPrefix: false,
    };
  }

  // Extract just the base filenames
  const baseNames = testFiles.map(f => {
    const parts = f.split('/');
    return parts[parts.length - 1];
  });

  // Detect numeric prefix
  const numPrefixRe = /^(\d+)[_\-. ]/;
  const prefixedCount = baseNames.filter(n => numPrefixRe.test(n)).length;
  const usesNumberPrefix = prefixedCount >= Math.ceil(baseNames.length * 0.5); // majority

  // Detect extension
  const extMatch = baseNames[0]?.match(/(\.\w+\.\w+|\.\w+)$/);
  const extension = extMatch ? extMatch[0] : '.spec.ts';

  // Detect separator and casing from the descriptive part
  let separator = '_';
  let casing: NamingConvention['casing'] = codingStyle.namingConvention ?? 'snake_case';

  // Analyse descriptive parts (strip prefix + extension)
  const descriptiveParts = baseNames.map(n => {
    let d = n.replace(numPrefixRe, '').replace(/\.\w+\.\w+$|\.\w+$/, '');
    return d;
  }).filter(Boolean);

  if (descriptiveParts.length > 0) {
    const snakeCount = descriptiveParts.filter(d => d.includes('_')).length;
    const kebabCount = descriptiveParts.filter(d => d.includes('-')).length;

    if (snakeCount >= kebabCount) {
      separator = '_';
      casing = 'snake_case';
    } else {
      separator = '-';
      casing = 'kebab-case';
    }
  }

  const pattern = usesNumberPrefix
    ? `NN${separator}description${extension}`
    : `description${extension}`;

  return { pattern, separator, casing, extension, usesNumberPrefix };
}

function computeNextNumber(testFiles: string[], naming: NamingConvention): number {
  if (!naming.usesNumberPrefix) return 1;

  let maxNum = 0;
  const numRe = /^(\d+)/;
  for (const f of testFiles) {
    const base = f.split('/').pop() || '';
    const m = base.match(numRe);
    if (m) {
      const n = parseInt(m[1], 10);
      if (n > maxNum) maxNum = n;
    }
  }
  return maxNum + 1;
}

function hasConfigFile(fs: FolderStructure, prefix: string): boolean {
  return (fs.configFiles ?? []).some(f => f.toLowerCase().includes(prefix.toLowerCase()));
}

function hasCIFiles(fs: FolderStructure): boolean {
  const all = [...(fs.configFiles ?? []), ...(fs.supportFiles ?? [])];
  return all.some(f =>
    f.includes('.github/workflows') ||
    f.includes('Jenkinsfile') ||
    f.includes('.gitlab-ci') ||
    f.includes('azure-pipelines'),
  );
}

/** All file-path-ish entries we know about in the folder structure. */
function allKnownFiles(fs: FolderStructure): string[] {
  return [...(fs.configFiles ?? []), ...(fs.supportFiles ?? [])];
}

function hasReadmeFile(fs: FolderStructure): boolean {
  return allKnownFiles(fs).some(f => /(^|\/)readme(\.\w+)?$/i.test(f));
}

function hasEnvFile(fs: FolderStructure, profile: RepositoryProfile): boolean {
  // A committed .env / .env.example, or a dotenv dependency, both indicate the
  // repo already manages its own environment configuration.
  const hasEnvCommitted = allKnownFiles(fs).some(f =>
    /(^|\/)\.env(\.\w+)?$/i.test(f) || f.toLowerCase().includes('.env.example'),
  );
  const hasDotenvDep = (profile.dependencies ?? []).some(d => d.name === 'dotenv');
  return hasEnvCommitted || hasDotenvDep;
}

function detectCredentialStyle(profile: RepositoryProfile): RepoStructureAnalysis['credentialStyle'] {
  // Check for env-based credentials (common patterns: process.env.*)
  const hasEnvCreds = profile.helperFunctions.some(fn =>
    fn.name.toLowerCase().includes('login') || fn.name.toLowerCase().includes('auth'),
  );
  if (profile.hasCustomFixtures && hasEnvCreds) return 'fixture';

  // Check dependencies for dotenv → suggests env-based
  const hasDotenv = profile.dependencies.some(d => d.name === 'dotenv');
  if (hasDotenv) return 'env';

  // Flat scripts often hardcode creds inline
  if (profile.testPattern === 'flat-scripts') return 'inline';

  return 'unknown';
}
