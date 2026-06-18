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
  /** Suggested suite (smoke, sanity, regression, nightly, etc.) */
  suggestedSuite: string;
  /** Risk assessment */
  risk: RiskAssessment;
  /** Reuse savings */
  reuseSavings: ReuseSavings;
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

export interface ReuseSavings {
  withoutReuseLOC: number;
  withReuseLOC: number;
  codeReductionPercent: number;
  reusedAssets: string[];
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

/** Complete framework audit result */
export interface FrameworkAuditResult {
  inventory: FrameworkInventory;
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
  scope: { companyId: number; projectId?: number; repositoryId?: number },
): Promise<FrameworkAuditResult> {
  // 1. Start with the existing repo structure analysis
  const repoAnalysis = analyzeRepoStructure(profile);

  // 2. Build deep framework inventory
  const inventory = await buildFrameworkInventory(profile, repoAnalysis, scope);

  // 3. Compute framework impact analysis
  const impactAnalysis = computeImpactAnalysis(
    inventory,
    generationContext,
    repoAnalysis,
  );

  // 4. Compute generation quality report
  const qualityReport = computeQualityReport(inventory, impactAnalysis);

  return {
    inventory,
    impactAnalysis,
    qualityReport,
    scope,
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

  // Suggested suite
  const suggestedSuite = suggestSuite(context, suggestedTags);

  // Risk assessment
  const risk = assessRisk(filesToCreate, filesToUpdate, inventory);

  // Reuse savings
  const reuseSavings = computeReuseSavings(filesToCreate, filesToReuse);

  return {
    existingAssets,
    filesToCreate,
    filesToUpdate,
    filesToReuse,
    suggestedTags,
    suggestedSuite,
    risk,
    reuseSavings,
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

function suggestSuite(context: GenerationContext, tags: string[]): string {
  if (tags.includes('@smoke')) return 'smoke';
  if (tags.includes('@sanity')) return 'sanity';
  return 'nightly-regression';
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

function computeReuseSavings(
  filesToCreate: FileImpact[],
  filesToReuse: FileImpact[],
): ReuseSavings {
  const withoutReuseLOC = filesToCreate.reduce(
    (sum, f) => sum + (f.estimatedLOC ?? 0),
    0,
  ) + filesToReuse.length * 50; // Assume 50 LOC per reusable asset if we had to recreate it

  const withReuseLOC = filesToCreate.reduce((sum, f) => sum + (f.estimatedLOC ?? 0), 0);

  const codeReductionPercent =
    withoutReuseLOC > 0 ? Math.round(((withoutReuseLOC - withReuseLOC) / withoutReuseLOC) * 100) : 0;

  const reusedAssets = filesToReuse.map((f) => f.path.split('/').pop() ?? f.path);

  return {
    withoutReuseLOC,
    withReuseLOC,
    codeReductionPercent,
    reusedAssets,
  };
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

  // Overall assessment based on reuse %
  let overallAssessment: ReuseLevel = 'NO REUSE';
  if (impact.reuseSavings.codeReductionPercent >= 70) {
    overallAssessment = 'HIGH REUSE';
  } else if (impact.reuseSavings.codeReductionPercent >= 40) {
    overallAssessment = 'MEDIUM REUSE';
  } else if (impact.reuseSavings.codeReductionPercent >= 10) {
    overallAssessment = 'LOW REUSE';
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
