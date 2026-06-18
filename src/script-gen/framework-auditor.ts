/**
 * Framework Auditor
 *
 * Enterprise-grade framework analysis for script generation. Goes beyond simple
 * code generation — audits the existing test framework (page objects, fixtures,
 * utils, data files, suites, tags), detects reusable assets, generates a
 * Framework Impact Analysis, Risk Assessment, Reuse Savings, and a Generation
 * Quality Report.
 *
 * Designed to make LevelUp AI behave like a senior automation architect, not
 * just a code generator.
 *
 * SECURITY: All operations are strictly project-scoped (company_id + project_id
 * + repository_id where applicable). Never leaks intelligence across projects.
 */

import type { RepositoryProfile } from '../context/types';
import { analyzeRepoStructure, type RepoStructureAnalysis } from './repo-analyzer';

/* ------------------------------------------------------------------ */
/*  Types                                                               */
/* ------------------------------------------------------------------ */

/** Deep inventory of framework assets beyond what repo-analyzer provides */
export interface FrameworkInventory {
  /** Page objects (already in repo-analyzer, but we add method counts) */
  pageObjects: PageObjectInfo[];
  /** Fixtures (base fixture, auth fixture, etc.) */
  fixtures: FixtureInfo[];
  /** Utilities (waitUtils, apiClient, commonUtils, etc.) */
  utilities: UtilityInfo[];
  /** Data files (users.json, testData.json, formData.json, etc.) */
  dataFiles: DataFileInfo[];
  /** Test suites (testng.xml, suite.yml, playwright projects) */
  suites: SuiteInfo[];
  /** Tags detected in existing tests (@smoke, @regression, etc.) */
  tags: string[];
  /** Environment files (.env, environments.ts) */
  envFiles: string[];
  /** Config files (playwright.config.ts, tsconfig.json) */
  configFiles: string[];
}

export interface PageObjectInfo {
  name: string;
  path: string;
  methodCount: number;
  lastModified?: Date;
}

export interface FixtureInfo {
  name: string;
  path: string;
  purpose: string; // e.g. 'auth', 'base', 'api'
}

export interface UtilityInfo {
  name: string;
  path: string;
  purpose: string; // e.g. 'wait helpers', 'api client', 'common actions'
}

export interface DataFileInfo {
  name: string;
  path: string;
  type: 'json' | 'ts' | 'js' | 'csv';
  purpose: string; // e.g. 'user credentials', 'test data', 'form data'
}

export interface SuiteInfo {
  name: string;
  path: string;
  type: 'playwright-project' | 'testng' | 'yaml' | 'other';
  tags?: string[];
}

/** Risk level for the generated changes */
export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

/** Qualitative assessment of framework reuse */
export type ReuseLevel = 'HIGH REUSE' | 'MEDIUM REUSE' | 'LOW REUSE' | 'NO REUSE';

/** Qualitative reuse opportunity level (defensible, no fabricated metrics) */
export type ReuseOpportunityLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';

/** Framework Impact Analysis — what will be created/updated/reused */
export interface FrameworkImpactAnalysis {
  /** Existing assets in the framework */
  existingAssets: string[];
  /** Files that will be created (new test specs, new page objects, etc.) */
  filesToCreate: FileImpact[];
  /** Files that will be updated (add methods to existing page objects, etc.) */
  filesToUpdate: FileImpact[];
  /** Files that will be reused as-is (existing login, fixtures, data, etc.) */
  filesToReuse: FileImpact[];
  /** Suggested tags for the generated tests */
  suggestedTags: string[];
  /** Existing suites discovered in the repository (derived, not assumed) */
  existingSuites: string[];
  /** Recommended suite — chosen from existingSuites when possible */
  suggestedSuite: string;
  /** Whether the recommended suite already exists in the repository */
  suggestedSuiteExists: boolean;
  /** Risk assessment */
  risk: RiskAssessment;
  /** Reuse opportunity (qualitative — replaces fabricated LOC savings) */
  reuseOpportunity: ReuseOpportunity;
}

export interface FileImpact {
  path: string;
  type: 'test' | 'page-object' | 'fixture' | 'util' | 'data' | 'config';
  reason: string; // why it's being created/updated/reused
  estimatedLOC?: number;
}

export interface RiskAssessment {
  level: RiskLevel;
  reasons: string[];
  mitigations: string[];
}

/**
 * Reuse Opportunity Analysis — qualitative, defensible assessment of how much of
 * the existing framework can be reused. Intentionally avoids fabricated
 * "Without Reuse vs With Reuse LOC" numbers that become a trust issue when a
 * customer asks "how did you calculate that?". Instead we report the concrete
 * assets that can be reused and a level derived purely from that count.
 */
export interface ReuseOpportunity {
  /** Qualitative level derived from the number of concrete reusable assets */
  level: ReuseOpportunityLevel;
  /** Concrete, verifiable assets that can be reused (e.g. LoginPage, BaseFixture) */
  assetsReused: string[];
  /** Human-readable summary of the reuse opportunity */
  summary: string;
}

/** Generation Quality Report — qualitative assessment of framework compliance */
export interface GenerationQualityReport {
  overallAssessment: ReuseLevel;
  pageObjectReuse: ReuseCategoryScore;
  fixtureReuse: ReuseCategoryScore;
  utilityReuse: ReuseCategoryScore;
  dataReuse: ReuseCategoryScore;
  conventionMatch: ReuseCategoryScore;
  tagRecommendation: ReuseCategoryScore;
}

export interface ReuseCategoryScore {
  score: 'EXCELLENT' | 'GOOD' | 'FAIR' | 'POOR';
  detail: string;
}

/**
 * Framework Assets Catalog — a high-level inventory snapshot of the repository's
 * framework knowledge. This is the foundation of the future Repository
 * Intelligence screen: Script Generation *consumes* this catalog rather than
 * rescanning the repo on every generation.
 */
export interface FrameworkAssetsCatalog {
  pageObjects: number;
  fixtures: number;
  utilities: number;
  dataFiles: number;
  suites: number;
  tags: number;
  /** When the underlying repository profile was last scanned, if known */
  lastRepositoryScan?: string;
}

/** Complete framework audit result */
export interface FrameworkAuditResult {
  inventory: FrameworkInventory;
  /** High-level catalog snapshot (counts + last scan) */
  catalog: FrameworkAssetsCatalog;
  impactAnalysis: FrameworkImpactAnalysis;
  qualityReport: GenerationQualityReport;
  /** Project isolation context */
  scope: {
    companyId: number;
    projectId?: number;
    repositoryId?: number;
  };
}

/* ------------------------------------------------------------------ */
/*  Main Auditor                                                        */
/* ------------------------------------------------------------------ */

/**
 * Audit a repository's test framework and produce a comprehensive report.
 *
 * SECURITY: Strictly project-scoped. Only analyzes assets within the specified
 * company_id + project_id + repository_id. Never leaks intelligence across
 * projects.
 *
 * @param profile RepositoryProfile from the Repo Intelligence engine
 * @param generationContext What's being generated (test specs, page objects, etc.)
 * @param scope Project isolation context
 */
export async function auditFramework(
  profile: RepositoryProfile,
  generationContext: GenerationContext,
  scope: {
    companyId: number;
    projectId?: number;
    repositoryId?: number;
    /** When the repository profile was last scanned by Repo Intelligence */
    lastScannedAt?: Date | string;
  },
): Promise<FrameworkAuditResult> {
  // 1. Start with the existing repo structure analysis. NOTE: this is a pure,
  //    in-memory read of the *already-scanned* RepositoryProfile produced by
  //    Repository Intelligence — it does NOT re-scan the repo on every
  //    generation. Repository Intelligence owns framework knowledge; Script
  //    Generation only consumes it here.
  const repoAnalysis = analyzeRepoStructure(profile);

  // 2. Build deep framework inventory
  const inventory = await buildFrameworkInventory(profile, repoAnalysis, scope);

  // 3. Build the high-level Framework Assets Catalog snapshot
  const catalog = buildAssetsCatalog(inventory, scope.lastScannedAt);

  // 4. Compute framework impact analysis
  const impactAnalysis = computeImpactAnalysis(
    inventory,
    generationContext,
    repoAnalysis,
  );

  // 5. Compute generation quality report
  const qualityReport = computeQualityReport(inventory, impactAnalysis);

  return {
    inventory,
    catalog,
    impactAnalysis,
    qualityReport,
    scope: {
      companyId: scope.companyId,
      projectId: scope.projectId,
      repositoryId: scope.repositoryId,
    },
  };
}

/**
 * Build the Framework Assets Catalog — counts of each asset type plus the last
 * repository scan time. Becomes the Repository Intelligence overview screen.
 */
function buildAssetsCatalog(
  inventory: FrameworkInventory,
  lastScannedAt?: Date | string,
): FrameworkAssetsCatalog {
  let lastRepositoryScan: string | undefined;
  if (lastScannedAt) {
    const d = lastScannedAt instanceof Date ? lastScannedAt : new Date(lastScannedAt);
    if (!Number.isNaN(d.getTime())) {
      lastRepositoryScan = formatDate(d);
    }
  }

  return {
    pageObjects: inventory.pageObjects.length,
    fixtures: inventory.fixtures.length,
    utilities: inventory.utilities.length,
    dataFiles: inventory.dataFiles.length,
    suites: inventory.suites.length,
    tags: inventory.tags.length,
    lastRepositoryScan,
  };
}

/**
 * Context for what's being generated — used to decide what files will be
 * created/updated/reused.
 */
export interface GenerationContext {
  /** Test case requirements (step descriptions, expected flows) */
  testCases?: Array<{ id: string; title: string; steps: string[] }>;
  /** URL being tested */
  baseUrl?: string;
  /** Whether this is a new project (greenfield) or existing framework */
  isGreenfield: boolean;
  /** Desired output format (playwright, selenium, etc.) */
  framework: 'playwright' | 'selenium' | 'cypress' | 'other';
}

/* ------------------------------------------------------------------ */
/*  Inventory Builder                                                   */
/* ------------------------------------------------------------------ */

async function buildFrameworkInventory(
  profile: RepositoryProfile,
  repoAnalysis: RepoStructureAnalysis,
  scope: { companyId: number; projectId?: number; repositoryId?: number },
): Promise<FrameworkInventory> {
  // Extract page objects (already in profile, but we add method counts)
  const pageObjects = extractPageObjects(profile);

  // Extract fixtures
  const fixtures = extractFixtures(profile);

  // Extract utilities
  const utilities = extractUtilities(profile);

  // Extract data files
  const dataFiles = extractDataFiles(profile);

  // Extract suites
  const suites = extractSuites(profile);

  // Extract tags
  const tags = extractTags(profile);

  // Extract env files
  const envFiles = extractEnvFiles(profile);

  // Extract config files
  const configFiles = extractConfigFiles(profile);

  return {
    pageObjects,
    fixtures,
    utilities,
    dataFiles,
    suites,
    tags,
    envFiles,
    configFiles,
  };
}

function extractPageObjects(profile: RepositoryProfile): PageObjectInfo[] {
  const pos: PageObjectInfo[] = [];
  if (!profile.pageObjects) return pos;

  for (const cls of profile.pageObjects) {
    pos.push({
      name: cls.name,
      path: cls.filePath,
      methodCount: cls.methods?.length ?? 0,
    });
  }
  return pos;
}

function extractFixtures(profile: RepositoryProfile): FixtureInfo[] {
  const fixtures: FixtureInfo[] = [];
  if (!profile.fixtures) return fixtures;

  for (const fixture of profile.fixtures) {
    const name = fixture.filePath.split('/').pop() ?? fixture.name;
    let purpose = 'custom fixture';
    if (name.toLowerCase().includes('base')) purpose = 'base';
    if (name.toLowerCase().includes('auth') || name.toLowerCase().includes('login'))
      purpose = 'auth';
    if (name.toLowerCase().includes('api')) purpose = 'api';
    fixtures.push({ name, path: fixture.filePath, purpose });
  }
  return fixtures;
}

function extractUtilities(profile: RepositoryProfile): UtilityInfo[] {
  const utils: UtilityInfo[] = [];
  if (!profile.helperFunctions) return utils;

  // Extract from helperFunctions (repo intelligence captures these)
  for (const helper of profile.helperFunctions) {
    const name = helper.filePath.split('/').pop() ?? helper.name;
    let purpose = 'utility';
    if (name.toLowerCase().includes('wait')) purpose = 'wait helpers';
    if (name.toLowerCase().includes('api')) purpose = 'api client';
    if (name.toLowerCase().includes('common')) purpose = 'common actions';
    utils.push({ name, path: helper.filePath, purpose });
  }
  return utils;
}

function extractDataFiles(profile: RepositoryProfile): DataFileInfo[] {
  // TODO: Repo intelligence doesn't yet capture data files as a structured field.
  // When repo-intelligence is enhanced to scan data/ folders, populate this.
  return [];
}

function extractSuites(profile: RepositoryProfile): SuiteInfo[] {
  const suites: SuiteInfo[] = [];
  if (!profile.testSuites) return suites;

  for (const suite of profile.testSuites) {
    let type: SuiteInfo['type'] = 'other';
    const name = suite.filePath.split('/').pop() ?? suite.name;
    if (name === 'playwright.config.ts' || name === 'playwright.config.js')
      type = 'playwright-project';
    if (name === 'testng.xml') type = 'testng';
    if (name.endsWith('.yml') || name.endsWith('.yaml')) type = 'yaml';

    suites.push({
      name: suite.name,
      path: suite.filePath,
      type,
      tags: suite.tags || [],
    });
  }
  return suites;
}

function extractTags(profile: RepositoryProfile): string[] {
  const tags = new Set<string>();
  if (!profile.testSuites) return [];

  // Extract tags from existing test suites
  for (const suite of profile.testSuites) {
    if (suite.tags) {
      suite.tags.forEach((t: string) => tags.add(t));
    }
  }
  return Array.from(tags);
}

function extractEnvFiles(profile: RepositoryProfile): string[] {
  // TODO: Repo intelligence doesn't yet capture env files.
  // When enhanced, populate this from profile.dependencies or a new field.
  return [];
}

function extractConfigFiles(profile: RepositoryProfile): string[] {
  const configFiles: string[] = [];
  if (profile.testSuites) {
    for (const suite of profile.testSuites) {
      const name = suite.filePath.split('/').pop() ?? '';
      if (
        name === 'playwright.config.ts' ||
        name === 'playwright.config.js' ||
        name === 'tsconfig.json' ||
        name === 'jest.config.js' ||
        name === 'vitest.config.ts'
      ) {
        configFiles.push(suite.filePath);
      }
    }
  }
  return configFiles;
}

/* ------------------------------------------------------------------ */
/*  Impact Analysis                                                     */
/* ------------------------------------------------------------------ */

function computeImpactAnalysis(
  inventory: FrameworkInventory,
  context: GenerationContext,
  repoAnalysis: RepoStructureAnalysis,
): FrameworkImpactAnalysis {
  const existingAssets = buildExistingAssetsList(inventory);
  const filesToCreate: FileImpact[] = [];
  const filesToUpdate: FileImpact[] = [];
  const filesToReuse: FileImpact[] = [];

  // Determine what files we'll create
  if (context.testCases && context.testCases.length > 0) {
    for (const tc of context.testCases) {
      filesToCreate.push({
        path: `${repoAnalysis.testDir}/${tc.id}.spec.ts`,
        type: 'test',
        reason: `New test spec for "${tc.title}"`,
        estimatedLOC: 50,
      });
    }
  }

  // Determine what we'll reuse (login, fixtures, data)
  if (inventory.pageObjects.some((po) => po.name.toLowerCase().includes('login'))) {
    filesToReuse.push({
      path: inventory.pageObjects.find((po) => po.name.toLowerCase().includes('login'))!
        .path,
      type: 'page-object',
      reason: 'Existing LoginPage → login()',
      estimatedLOC: 0,
    });
  }

  if (inventory.fixtures.some((f) => f.purpose === 'base' || f.purpose === 'auth')) {
    const fixture = inventory.fixtures.find((f) => f.purpose === 'base' || f.purpose === 'auth')!;
    filesToReuse.push({
      path: fixture.path,
      type: 'fixture',
      reason: `Existing ${fixture.name} → authenticated context`,
      estimatedLOC: 0,
    });
  }

  if (inventory.dataFiles.some((d) => d.purpose === 'user credentials')) {
    const dataFile = inventory.dataFiles.find((d) => d.purpose === 'user credentials')!;
    filesToReuse.push({
      path: dataFile.path,
      type: 'data',
      reason: `Existing ${dataFile.name} → user credentials`,
      estimatedLOC: 0,
    });
  }

  // Suggested tags (based on test case complexity)
  const suggestedTags = suggestTags(context, inventory);

  // Suite recommendation — derived from the repository's actual suites/tags,
  // never a hardcoded assumption.
  const { existingSuites, suggestedSuite, suggestedSuiteExists } = recommendSuite(
    inventory,
    suggestedTags,
  );

  // Risk assessment
  const risk = assessRisk(filesToCreate, filesToUpdate, inventory);

  // Reuse opportunity (qualitative — no fabricated LOC)
  const reuseOpportunity = computeReuseOpportunity(filesToReuse);

  return {
    existingAssets,
    filesToCreate,
    filesToUpdate,
    filesToReuse,
    suggestedTags,
    existingSuites,
    suggestedSuite,
    suggestedSuiteExists,
    risk,
    reuseOpportunity,
  };
}

function buildExistingAssetsList(inventory: FrameworkInventory): string[] {
  const assets: string[] = [];
  for (const po of inventory.pageObjects) {
    assets.push(`✓ ${po.name} (${po.methodCount} methods${po.lastModified ? `, last modified ${formatDate(po.lastModified)}` : ''})`);
  }
  for (const fixture of inventory.fixtures) {
    assets.push(`✓ ${fixture.name} (${fixture.purpose})`);
  }
  for (const util of inventory.utilities) {
    assets.push(`✓ ${util.name} (${util.purpose})`);
  }
  for (const data of inventory.dataFiles) {
    assets.push(`✓ ${data.name} (${data.purpose})`);
  }
  return assets;
}

function suggestTags(context: GenerationContext, inventory: FrameworkInventory): string[] {
  // Simple heuristic: if test cases are short and critical, suggest @smoke
  // Otherwise suggest @regression
  if (!context.testCases || context.testCases.length === 0) return ['@regression'];

  const avgSteps =
    context.testCases.reduce((sum, tc) => sum + (tc.steps?.length ?? 0), 0) /
    context.testCases.length;

  if (avgSteps <= 3) {
    // Short flow → smoke-critical
    return ['@smoke'];
  } else {
    // Multi-step → regression
    return ['@regression'];
  }
}

/**
 * Recommend a suite for the generated tests. The recommendation is *derived*
 * from the repository's actual suites and tags discovered by Repository
 * Intelligence — never a hardcoded assumption like "nightly-regression".
 *
 * Resolution order:
 *  1. Collect the real suite names known to the repo (from suite files and
 *     tags such as @smoke / @regression).
 *  2. If the suggested tag (e.g. @smoke) maps to an existing suite, recommend it.
 *  3. Otherwise prefer a conventional existing suite (regression > sanity > smoke).
 *  4. Only if the repo has no suites at all do we fall back to a clearly-labelled
 *     suggestion, flagged with suggestedSuiteExists = false.
 */
function recommendSuite(
  inventory: FrameworkInventory,
  tags: string[],
): { existingSuites: string[]; suggestedSuite: string; suggestedSuiteExists: boolean } {
  const existingSuites = collectExistingSuites(inventory);

  const matchExisting = (candidate: string): string | undefined =>
    existingSuites.find((s) => s.toLowerCase() === candidate.toLowerCase());

  // 1. Tag-driven match against an existing suite (strip leading @).
  for (const tag of tags) {
    const bare = tag.replace(/^@/, '').toLowerCase();
    const matched = matchExisting(bare);
    if (matched) {
      return { existingSuites, suggestedSuite: matched, suggestedSuiteExists: true };
    }
  }

  // 2. Prefer a conventional existing suite, in priority order.
  for (const preferred of ['regression', 'sanity', 'smoke']) {
    const matched = matchExisting(preferred);
    if (matched) {
      return { existingSuites, suggestedSuite: matched, suggestedSuiteExists: true };
    }
  }

  // 3. Any existing suite is better than an assumption.
  if (existingSuites.length > 0) {
    return {
      existingSuites,
      suggestedSuite: existingSuites[0],
      suggestedSuiteExists: true,
    };
  }

  // 4. No suites in the repo — derive a sensible suggestion from the tag and
  //    flag clearly that it does not yet exist.
  const fallback = tags.includes('@smoke') ? 'smoke' : 'regression';
  return { existingSuites, suggestedSuite: fallback, suggestedSuiteExists: false };
}

/**
 * Collect the distinct, human-meaningful suite names known to the repository:
 * suite categories/file names plus tag-derived suite names (@smoke → smoke).
 */
function collectExistingSuites(inventory: FrameworkInventory): string[] {
  const suites = new Set<string>();

  for (const suite of inventory.suites) {
    // Skip pure config files — they're not runnable suites.
    if (suite.type === 'playwright-project' && /\.config\.[tj]s$/.test(suite.name)) {
      continue;
    }
    if (suite.name) suites.add(suite.name);
    for (const t of suite.tags ?? []) {
      const bare = t.replace(/^@/, '').trim();
      if (bare) suites.add(bare);
    }
  }

  // Tags discovered across the framework also represent runnable suites.
  for (const tag of inventory.tags) {
    const bare = tag.replace(/^@/, '').trim();
    if (bare) suites.add(bare);
  }

  return Array.from(suites);
}

function assessRisk(
  filesToCreate: FileImpact[],
  filesToUpdate: FileImpact[],
  inventory: FrameworkInventory,
): RiskAssessment {
  const reasons: string[] = [];
  const mitigations: string[] = [];
  let level: RiskLevel = 'LOW';

  if (filesToUpdate.length === 0) {
    reasons.push('No existing files modified');
    level = 'LOW';
  } else if (filesToUpdate.length <= 2) {
    reasons.push(`${filesToUpdate.length} existing file(s) updated`);
    reasons.push('Existing framework conventions preserved');
    level = 'MEDIUM';
    mitigations.push('Review updated files before merging');
  } else {
    reasons.push(`${filesToUpdate.length} framework files modified`);
    reasons.push('Existing fixture/page-object changes required');
    level = 'HIGH';
    mitigations.push('Thorough review required');
    mitigations.push('Run regression suite after merge');
  }

  return { level, reasons, mitigations };
}

/**
 * Compute a qualitative Reuse Opportunity. Deliberately does NOT estimate
 * "Without Reuse LOC vs With Reuse LOC" — those numbers are not mathematically
 * defensible and become a trust issue when a customer asks how they were
 * calculated. Instead we report the concrete assets that can be reused and a
 * level derived purely from how many real assets were found.
 */
function computeReuseOpportunity(filesToReuse: FileImpact[]): ReuseOpportunity {
  const assetsReused = filesToReuse.map((f) => f.path.split('/').pop() ?? f.path);
  const count = assetsReused.length;

  let level: ReuseOpportunityLevel = 'NONE';
  if (count >= 3) level = 'HIGH';
  else if (count === 2) level = 'MEDIUM';
  else if (count === 1) level = 'LOW';

  let summary: string;
  if (count === 0) {
    summary = 'No existing assets available to reuse (greenfield generation).';
  } else {
    summary = `${count} existing framework asset(s) can be reused instead of regenerated: ${assetsReused.join(', ')}.`;
  }

  return { level, assetsReused, summary };
}

/* ------------------------------------------------------------------ */
/*  Quality Report                                                      */
/* ------------------------------------------------------------------ */

function computeQualityReport(
  inventory: FrameworkInventory,
  impact: FrameworkImpactAnalysis,
): GenerationQualityReport {
  const pageObjectReuse = scorePageObjectReuse(inventory, impact);
  const fixtureReuse = scoreFixtureReuse(inventory, impact);
  const utilityReuse = scoreUtilityReuse(inventory, impact);
  const dataReuse = scoreDataReuse(inventory, impact);
  const conventionMatch = scoreConventionMatch(inventory);
  const tagRecommendation = scoreTagRecommendation(impact);

  // Overall assessment derived from the qualitative reuse opportunity level
  // (number of real reusable assets) — not a fabricated percentage.
  let overallAssessment: ReuseLevel = 'NO REUSE';
  switch (impact.reuseOpportunity.level) {
    case 'HIGH':
      overallAssessment = 'HIGH REUSE';
      break;
    case 'MEDIUM':
      overallAssessment = 'MEDIUM REUSE';
      break;
    case 'LOW':
      overallAssessment = 'LOW REUSE';
      break;
    default:
      overallAssessment = 'NO REUSE';
  }

  return {
    overallAssessment,
    pageObjectReuse,
    fixtureReuse,
    utilityReuse,
    dataReuse,
    conventionMatch,
    tagRecommendation,
  };
}

function scorePageObjectReuse(
  inventory: FrameworkInventory,
  impact: FrameworkImpactAnalysis,
): ReuseCategoryScore {
  const reusedPOs = impact.filesToReuse.filter((f) => f.type === 'page-object').length;
  if (reusedPOs >= 3)
    return { score: 'EXCELLENT', detail: `${reusedPOs} page objects reused` };
  if (reusedPOs >= 1) return { score: 'GOOD', detail: `${reusedPOs} page object(s) reused` };
  return { score: 'FAIR', detail: 'No existing page objects reused' };
}

function scoreFixtureReuse(
  inventory: FrameworkInventory,
  impact: FrameworkImpactAnalysis,
): ReuseCategoryScore {
  const reusedFixtures = impact.filesToReuse.filter((f) => f.type === 'fixture').length;
  if (reusedFixtures >= 1)
    return { score: 'EXCELLENT', detail: 'Base/auth fixture reused' };
  return { score: 'FAIR', detail: 'No existing fixtures reused' };
}

function scoreUtilityReuse(
  inventory: FrameworkInventory,
  impact: FrameworkImpactAnalysis,
): ReuseCategoryScore {
  const reusedUtils = impact.filesToReuse.filter((f) => f.type === 'util').length;
  if (reusedUtils >= 2) return { score: 'EXCELLENT', detail: `${reusedUtils} utils reused` };
  if (reusedUtils >= 1) return { score: 'GOOD', detail: `${reusedUtils} utility reused` };
  return { score: 'FAIR', detail: 'No existing utils reused' };
}

function scoreDataReuse(
  inventory: FrameworkInventory,
  impact: FrameworkImpactAnalysis,
): ReuseCategoryScore {
  const reusedData = impact.filesToReuse.filter((f) => f.type === 'data').length;
  if (reusedData >= 1)
    return { score: 'EXCELLENT', detail: 'Existing test data reused' };
  return { score: 'FAIR', detail: 'Created new test data file' };
}

function scoreConventionMatch(inventory: FrameworkInventory): ReuseCategoryScore {
  // Simple heuristic: if we have page objects + fixtures, conventions are strong
  if (inventory.pageObjects.length >= 3 && inventory.fixtures.length >= 1) {
    return { score: 'EXCELLENT', detail: 'Matched naming and structure' };
  }
  if (inventory.pageObjects.length >= 1 || inventory.fixtures.length >= 1) {
    return { score: 'GOOD', detail: 'Followed framework conventions' };
  }
  return { score: 'FAIR', detail: 'Greenfield — established new conventions' };
}

function scoreTagRecommendation(impact: FrameworkImpactAnalysis): ReuseCategoryScore {
  if (impact.suggestedTags.length > 0) {
    return {
      score: 'EXCELLENT',
      detail: `Tagged as ${impact.suggestedTags.join(', ')}`,
    };
  }
  return { score: 'FAIR', detail: 'No tags recommended' };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                             */
/* ------------------------------------------------------------------ */

function formatDate(d: Date): string {
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays <= 7) return `${diffDays} days ago`;
  return d.toISOString().split('T')[0];
}
