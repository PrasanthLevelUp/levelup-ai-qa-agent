/**
 * Folder Structure Analyzer (Sprint 4 — Enterprise Script Generation Enhancement)
 * ================================================================================
 *
 * PURPOSE
 * -------
 * When LevelUp generates a test script for an existing repository, the script
 * must land in the *right place*, with the *right name*, following the team's
 * existing conventions — never inventing directories and NEVER deleting,
 * moving, or modifying files that already exist.
 *
 * This service produces a high-level `FolderIntelligence` summary (test root,
 * directory pattern, existing directories, naming conventions) and a concrete
 * file-placement decision for a given test case. It is a thin, additive layer
 * built ON TOP of the existing `analyzeRepoStructure()` (in
 * `src/script-gen/repo-analyzer.ts`) — it reuses that engine's mode/naming/
 * test-dir detection rather than duplicating it.
 *
 * SAFETY GUARANTEES
 * -----------------
 * • Pure / CPU-only — no filesystem or network access.
 * • Additive-only — it computes *target paths*; it never returns an instruction
 *   to overwrite an existing file. When a target path collides with an existing
 *   file, it appends a numeric suffix (login.spec.ts → login-2.spec.ts).
 * • Graceful degradation — with no `RepositoryProfile` it falls back to safe
 *   Playwright defaults (tests/generated/...).
 */

import { analyzeRepoStructure, type RepoStructureAnalysis } from '../script-gen/repo-analyzer';
import type { RepositoryProfile } from '../context/types';

/* -------------------------------------------------------------------------- */
/*  Public Types                                                              */
/* -------------------------------------------------------------------------- */

export type NamingStyle = 'kebab' | 'camel' | 'snake' | 'pascal';

/** Naming conventions detected across the repo's test assets. */
export interface NamingConventions {
  /** e.g. "{feature}.spec.ts" */
  testFiles: string;
  /** e.g. "{Page}Page.ts" */
  pageObjects: string;
  /** e.g. "{name}.fixture.ts" */
  fixtures: string;
  /** e.g. "{name}.helper.ts" */
  helpers: string;
  /** Dominant casing style for test file basenames. */
  style: NamingStyle;
  /** Test file suffix in use (e.g. ".spec.ts" / ".test.ts"). */
  testSuffix: string;
  /** Confidence in the detected style (0–1). */
  confidence: number;
}

/** High-level folder intelligence extracted from a repository profile. */
export interface FolderIntelligence {
  /** Root test directory (e.g. "tests", "e2e", "cypress/integration"). */
  testRoot: string;
  /** Sub-directory pattern (e.g. "tests/{feature}/"). */
  directoryPattern: string;
  /** Generation mode the repo follows. */
  mode: 'flat' | 'pom' | 'hybrid';
  /** Existing directories with file counts + per-dir naming pattern. */
  existingDirs: Array<{ path: string; fileCount: number; pattern: string }>;
  /** Detected naming conventions. */
  naming: NamingConventions;
  /** Detected page-object directory (if any). */
  pageObjectDir: string | null;
  /** Detected fixtures directory (if any). */
  fixtureDir: string | null;
  /** Whether the analysis is derived from a real profile vs. safe defaults. */
  fromProfile: boolean;
}

/** The kind of file we are placing. */
export type FileKind = 'test' | 'page-object' | 'fixture' | 'helper';

/** A concrete, safe placement decision for one generated file. */
export interface FilePlacement {
  kind: FileKind;
  /** Final relative path within the repo, e.g. "tests/e2e/auth/login-validation.spec.ts". */
  targetPath: string;
  /** Directory portion of the target path. */
  directory: string;
  /** Final file name (with extension). */
  fileName: string;
  /** Naming convention applied. */
  namingConvention: string;
  /** Whether a numeric suffix was appended to avoid an existing-file collision. */
  collisionAvoided: boolean;
  /** Human-readable rationale (surfaced in metadata). */
  reason: string;
}

/* -------------------------------------------------------------------------- */
/*  FolderStructureAnalyzer                                                   */
/* -------------------------------------------------------------------------- */

export class FolderStructureAnalyzer {
  private readonly analysis: RepoStructureAnalysis | null;
  private readonly profile: RepositoryProfile | null;

  constructor(profile?: RepositoryProfile | null) {
    this.profile = profile ?? null;
    this.analysis = profile ? safeAnalyze(profile) : null;
  }

  /* --------------------------- Intelligence ----------------------------- */

  /** Build the high-level folder intelligence summary. */
  analyze(): FolderIntelligence {
    if (!this.profile || !this.analysis) {
      return DEFAULT_FOLDER_INTELLIGENCE();
    }

    const fs = this.profile.folderStructure;
    const testRoot = this.analysis.testDir || 'tests';
    const naming = this.detectNamingConventions();
    const existingDirs = this.collectExistingDirs(testRoot);

    // Directory pattern: if the repo groups tests by feature sub-dirs, mirror
    // that; otherwise place directly under the test root.
    const groupsByFeature = existingDirs.some((d) => d.path !== testRoot && d.fileCount > 0);
    const directoryPattern = groupsByFeature ? `${testRoot}/{feature}/` : `${testRoot}/`;

    return {
      testRoot,
      directoryPattern,
      mode: this.analysis.mode,
      existingDirs,
      naming,
      pageObjectDir: fs.pageObjectFolder ? stripSlashes(fs.pageObjectFolder) : null,
      fixtureDir: fs.fixtureFolder ? stripSlashes(fs.fixtureFolder) : null,
      fromProfile: true,
    };
  }

  /* ---------------------------- Placement ------------------------------- */

  /**
   * Decide where a generated file should live and what it should be named.
   *
   * @param kind         the file kind being placed
   * @param featureName  the feature / test-case slug source (e.g. "Login validation")
   * @param existingFiles repo file paths already present (used for collision + feature dir matching)
   * @param pageName     for page objects: the page/class name (e.g. "Login")
   */
  decidePlacement(
    kind: FileKind,
    featureName: string,
    existingFiles: string[] = [],
    pageName?: string,
  ): FilePlacement {
    const intel = this.analyze();
    const naming = intel.naming;
    const slug = this.applyStyle(featureName, naming.style);

    let directory: string;
    let fileName: string;
    let reason: string;

    switch (kind) {
      case 'page-object': {
        directory = intel.pageObjectDir || `${intel.testRoot}/pages`;
        const base = this.toPascal(pageName || featureName);
        fileName = `${base}Page.ts`;
        reason = intel.pageObjectDir
          ? `Placed in detected page-object directory (${directory}).`
          : `No PO directory detected — used safe default ${directory}.`;
        break;
      }
      case 'fixture': {
        directory = intel.fixtureDir || `${intel.testRoot}/fixtures`;
        fileName = `${slug}.fixture.ts`;
        reason = intel.fixtureDir
          ? `Placed in detected fixtures directory (${directory}).`
          : `No fixtures directory detected — used safe default ${directory}.`;
        break;
      }
      case 'helper': {
        directory = this.profile?.folderStructure.utilsFolder
          ? stripSlashes(this.profile.folderStructure.utilsFolder)
          : `${intel.testRoot}/utils`;
        fileName = `${slug}.helper.ts`;
        reason = `Helper placed in ${directory}.`;
        break;
      }
      case 'test':
      default: {
        // Try to match an existing feature sub-directory by keyword overlap.
        const matchedDir = this.matchFeatureDir(featureName, intel);
        directory = matchedDir || (intel.fromProfile ? intel.testRoot : `${intel.testRoot}/generated`);
        const numberPrefix = this.analysis?.naming.usesNumberPrefix
          ? `${pad(this.analysis.nextFileNumber)}${this.analysis.naming.separator}`
          : '';
        fileName = `${numberPrefix}${slug}${naming.testSuffix}`;
        reason = matchedDir
          ? `Matched existing feature directory (${matchedDir}) by keyword.`
          : intel.fromProfile
            ? `Placed under detected test root (${intel.testRoot}).`
            : `No repo intelligence — used safe default ${directory}.`;
        break;
      }
    }

    // Collision avoidance — NEVER overwrite an existing file.
    const { finalName, avoided } = this.avoidCollision(directory, fileName, existingFiles);

    return {
      kind,
      directory,
      fileName: finalName,
      targetPath: `${directory}/${finalName}`.replace(/\/+/g, '/'),
      namingConvention: naming.style,
      collisionAvoided: avoided,
      reason: avoided ? `${reason} Appended numeric suffix to avoid overwriting an existing file.` : reason,
    };
  }

  /* ----------------------------- Helpers -------------------------------- */

  /** Detect dominant naming conventions across the repo's test files. */
  private detectNamingConventions(): NamingConventions {
    const files = this.analysis?.existingTestFiles ?? [];
    const basenames = files.map((f) => f.split('/').pop() || '').filter(Boolean);

    const patterns: Record<NamingStyle, RegExp> = {
      kebab: /^[a-z0-9]+(-[a-z0-9]+)*\.(spec|test)\.(ts|js)$/,
      camel: /^[a-z]+[A-Z][a-zA-Z0-9]*\.(spec|test)\.(ts|js)$/,
      snake: /^[a-z0-9]+(_[a-z0-9]+)*\.(spec|test)\.(ts|js)$/,
      pascal: /^[A-Z][a-zA-Z0-9]+\.(spec|test)\.(ts|js)$/,
    };
    const counts: Record<NamingStyle, number> = { kebab: 0, camel: 0, snake: 0, pascal: 0 };
    for (const b of basenames) {
      for (const [style, re] of Object.entries(patterns)) {
        if (re.test(b)) counts[style as NamingStyle]++;
      }
    }

    // Fall back to the repo-analyzer's casing detection when no test files match.
    let dominant: NamingStyle = (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] as NamingStyle) || 'kebab';
    let dominantCount = counts[dominant];
    if (dominantCount === 0 && this.analysis) {
      dominant = casingToStyle(this.analysis.naming.casing);
    }

    const testSuffix = this.analysis?.naming.extension || detectSuffix(basenames) || '.spec.ts';
    const confidence = basenames.length ? dominantCount / basenames.length : 0;

    return {
      testFiles: `{feature}${testSuffix}`,
      pageObjects: '{Page}Page.ts',
      fixtures: '{name}.fixture.ts',
      helpers: '{name}.helper.ts',
      style: dominant,
      testSuffix,
      confidence,
    };
  }

  /** Group existing test files into their containing directories with counts. */
  private collectExistingDirs(testRoot: string): FolderIntelligence['existingDirs'] {
    const files = this.analysis?.existingTestFiles ?? [];
    const byDir = new Map<string, number>();
    for (const f of files) {
      const dir = f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : testRoot;
      byDir.set(dir, (byDir.get(dir) ?? 0) + 1);
    }
    const style = this.analysis ? casingToStyle(this.analysis.naming.casing) : 'kebab';
    return Array.from(byDir.entries()).map(([path, fileCount]) => ({ path, fileCount, pattern: style }));
  }

  /** Find an existing feature directory whose name overlaps the feature keywords. */
  private matchFeatureDir(featureName: string, intel: FolderIntelligence): string | null {
    const tokens = tokenize(featureName);
    if (!tokens.length) return null;
    let best: { path: string; score: number } | null = null;
    for (const d of intel.existingDirs) {
      const dirTokens = tokenize(d.path);
      const hits = tokens.filter((t) => dirTokens.includes(t)).length;
      if (hits > 0 && (!best || hits > best.score)) best = { path: d.path, score: hits };
    }
    return best ? best.path : null;
  }

  /** Append a numeric suffix until the path no longer collides. */
  private avoidCollision(
    directory: string,
    fileName: string,
    existingFiles: string[],
  ): { finalName: string; avoided: boolean } {
    const existing = new Set(existingFiles.map((f) => f.replace(/^\.?\//, '')));
    const target = `${directory}/${fileName}`.replace(/\/+/g, '/').replace(/^\.?\//, '');
    if (!existing.has(target)) return { finalName: fileName, avoided: false };

    // Split "name.spec.ts" → base "name", ext ".spec.ts"
    const extMatch = fileName.match(/(\.\w+\.\w+|\.\w+)$/);
    const ext = extMatch ? extMatch[0] : '';
    const base = ext ? fileName.slice(0, -ext.length) : fileName;
    let n = 2;
    let candidate = `${base}-${n}${ext}`;
    while (existing.has(`${directory}/${candidate}`.replace(/\/+/g, '/').replace(/^\.?\//, ''))) {
      n++;
      candidate = `${base}-${n}${ext}`;
    }
    return { finalName: candidate, avoided: true };
  }

  /* --------------------------- Casing utils ----------------------------- */

  private applyStyle(name: string, style: NamingStyle): string {
    const words = name
      .replace(/[^a-zA-Z0-9]+/g, ' ')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (!words.length) return 'generated';
    switch (style) {
      case 'snake': return words.join('_');
      case 'camel': return words[0] + words.slice(1).map(cap).join('');
      case 'pascal': return words.map(cap).join('');
      case 'kebab':
      default: return words.join('-');
    }
  }

  private toPascal(name: string): string {
    return this.applyStyle(name, 'pascal') || 'Generated';
  }
}

/* -------------------------------------------------------------------------- */
/*  Module-level helpers                                                      */
/* -------------------------------------------------------------------------- */

function safeAnalyze(profile: RepositoryProfile): RepoStructureAnalysis | null {
  try {
    return analyzeRepoStructure(profile);
  } catch {
    return null;
  }
}

function DEFAULT_FOLDER_INTELLIGENCE(): FolderIntelligence {
  return {
    testRoot: 'tests',
    directoryPattern: 'tests/generated/',
    mode: 'pom',
    existingDirs: [],
    naming: {
      testFiles: '{feature}.spec.ts',
      pageObjects: '{Page}Page.ts',
      fixtures: '{name}.fixture.ts',
      helpers: '{name}.helper.ts',
      style: 'kebab',
      testSuffix: '.spec.ts',
      confidence: 0,
    },
    pageObjectDir: null,
    fixtureDir: null,
    fromProfile: false,
  };
}

function casingToStyle(casing: string): NamingStyle {
  switch (casing) {
    case 'snake_case': return 'snake';
    case 'camelCase': return 'camel';
    case 'PascalCase': return 'pascal';
    case 'kebab-case':
    default: return 'kebab';
  }
}

function detectSuffix(basenames: string[]): string {
  const test = basenames.filter((b) => /\.test\.(ts|js)$/.test(b)).length;
  const spec = basenames.filter((b) => /\.spec\.(ts|js)$/.test(b)).length;
  if (test > spec) return basenames.some((b) => b.endsWith('.test.js')) ? '.test.js' : '.test.ts';
  if (spec > 0) return basenames.some((b) => b.endsWith('.spec.js')) ? '.spec.js' : '.spec.ts';
  return '.spec.ts';
}

function stripSlashes(p: string): string {
  return p.replace(/^\.?\//, '').replace(/\/$/, '');
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function cap(w: string): string {
  return w.charAt(0).toUpperCase() + w.slice(1);
}

function tokenize(s: string): string[] {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t.length > 2 && !['tests', 'test', 'spec', 'the', 'and'].includes(t));
}

/** Functional shorthand: build folder intelligence from a profile. */
export function analyzeFolderStructure(profile?: RepositoryProfile | null): FolderIntelligence {
  return new FolderStructureAnalyzer(profile).analyze();
}
