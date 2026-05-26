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

  /* ── Existing assets — things we must NOT overwrite ── */
  hasPlaywrightConfig: boolean;
  hasCIWorkflow: boolean;
  hasFixtures: boolean;
  hasUtils: boolean;
  hasPageObjects: boolean;
  existingTestFiles: string[];

  /* ── Style ── */
  tagPattern: string | null;      // e.g. '@smoke', '@login-positive'
  quoteStyle: 'single' | 'double' | 'mixed';
  semicolons: boolean;
  indentStyle: string;            // e.g. 'spaces-2'

  /** How the repo supplies credentials (inline, env, fixture, unknown) */
  credentialStyle: 'inline' | 'env' | 'fixture' | 'unknown';
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

  return {
    mode,
    naming,
    nextFileNumber,
    testDir,

    hasPlaywrightConfig: hasConfigFile(profile.folderStructure, 'playwright.config'),
    hasCIWorkflow: !!profile.ciIntegration || hasCIFiles(profile.folderStructure),
    hasFixtures: profile.hasCustomFixtures || !!profile.folderStructure.fixtureFolder,
    hasUtils: !!profile.folderStructure.utilsFolder,
    hasPageObjects: !!profile.folderStructure.pageObjectFolder || profile.pageObjects.length > 0,
    existingTestFiles,

    tagPattern: profile.codingStyle.tagConvention || null,
    quoteStyle: profile.codingStyle.quoteStyle ?? 'single',
    semicolons: profile.codingStyle.semicolons ?? true,
    indentStyle: profile.codingStyle.indentStyle ?? 'spaces-2',

    credentialStyle: detectCredentialStyle(profile),
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
