/**
 * AI Test Coverage Intelligence Engine
 * Transforms requirements into senior-QA-level test scenarios & cases
 * with business awareness, coverage gap analysis, and automation readiness scoring.
 */

import OpenAI from 'openai';
import { logger } from '../utils/logger';
import { ModelSelector } from '../ai/model-selector';
import { CostTracker } from '../ai/cost-tracker';
import { KnowledgeOptimizer, type KnowledgeItem as OptimizerKnowledgeItem } from '../ai/knowledge-optimizer';

const MOD = 'test-coverage-engine';

/** Cosine similarity between two equal-length numeric vectors (0..1 for embeddings). */
function cosineSimilarity(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type CoverageType =
  | 'positive' | 'negative' | 'edge_cases' | 'boundary'
  | 'security' | 'api' | 'ui' | 'mobile' | 'accessibility'
  | 'performance' | 'integration' | 'regression'
  | 'cross_browser' | 'data_validation' | 'role_based' | 'localization';

export type RiskLevel = 'critical' | 'high' | 'medium' | 'low';

export interface RequirementInput {
  title: string;
  description: string;
  jiraId?: string;
  businessFlow?: string;
  acceptanceCriteria?: string;
  apiDocs?: string;
  releaseNotes?: string;
  module?: string;
}

export interface RequirementAnalysis {
  featureType: string;
  riskLevel: RiskLevel;
  businessCriticality: string;
  impactedModules: string[];
  userRolesAffected: string[];
  apiDependencies: string[];
  dbImpact: string;
  workflowSteps: string[];
  summary: string;
}

export interface TestScenario {
  scenario: string;
  coverageType: CoverageType;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  riskArea: string;
}

/**
 * Where a test case's coverage comes from — for traceability (RTM) and trust.
 *  - requirement: directly traces to the requirement / acceptance criteria.
 *  - knowledge:   grounded in provided App Knowledge / business rules.
 *  - test_data:   driven by a real project dataset (e.g. valid_users).
 *  - app_profile: grounded in the crawled application structure.
 *  - assumption:  AI-extrapolated beyond any provided evidence (e.g. a boundary
 *                 limit not stated anywhere). Surfaced explicitly so users can
 *                 trust or prune it instead of mistaking it for requirement coverage.
 */
export type TestCaseSource = 'requirement' | 'knowledge' | 'test_data' | 'app_profile' | 'gap_analysis' | 'assumption';

export interface TestCase {
  title: string;
  preconditions: string;
  steps: string[];
  expectedResult: string;
  testData: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  severity: 'critical' | 'major' | 'minor' | 'trivial';
  tags: string[];
  automationReady: boolean;
  automationComplexity: 'low' | 'medium' | 'high';
  selectorAvailability: 'high' | 'medium' | 'low' | 'unknown';
  /** Primary provenance of this case (defaults to 'requirement' if the model omits it). */
  source?: TestCaseSource;
  /** Short, human-readable justification for the source tag (e.g. "AC: valid login"). */
  sourceEvidence?: string;
}

export interface CoverageGap {
  area: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  suggestion: string;
}

/**
 * An open question the requirement leaves unanswered. Instead of fabricating an
 * "Assumption-Based" test case (e.g. a 255-char username limit nobody specified),
 * we surface the gap as a question for the author to resolve. This is more
 * honest and more valuable than a guessed test case.
 */
export interface MissingRequirement {
  /** The concrete question to ask the requirement author. */
  question: string;
  /** Functional area the question relates to (e.g. "Input validation"). */
  area: string;
  /** Why this matters / what's missing. */
  rationale: string;
}

/**
 * Generation mode.
 *  - 'strict'   : ONLY test cases that trace directly to the requirement.
 *                 Knowledge / Test Data / Profile are CONTEXT (they enrich a
 *                 requirement-derived case) — they never spawn new cases.
 *                 Assumptions become MissingRequirements, not test cases.
 *  - 'expanded' : strict coverage PLUS a separate set of suggested additional
 *                 cases (negative paths, security, etc. the requirement implies
 *                 but doesn't state). Only used when Coverage Gap Analysis is on.
 */
export type GenerationMode = 'strict' | 'expanded';

export interface GenerationResult {
  requirementAnalysis: RequirementAnalysis;
  scenarios: TestScenario[];
  testCases: TestCase[];
  /** Expansion cases (only populated in 'expanded' mode) — kept SEPARATE from
   *  the requirement-derived testCases so reviewers never confuse the two. */
  suggestedTestCases: TestCase[];
  /** Open questions raised instead of generating assumption-based test cases. */
  missingRequirements: MissingRequirement[];
  coverageGaps: CoverageGap[];
  /** Which mode produced this result. */
  mode: GenerationMode;
  stats: {
    totalScenarios: number;
    totalTestCases: number;
    coverageTypes: string[];
    automationReadyCount: number;
    gapsFound: number;
    tokensUsed: number;
    /** How many near-duplicate cases the semantic dedup pass removed. */
    duplicatesRemoved?: number;
    /** Count of separate suggested (expansion) cases. */
    suggestedCount?: number;
    /** Count of open questions raised instead of assumption test cases. */
    missingRequirementsCount?: number;
  };
}

export interface EnterpriseKnowledgeItem {
  id: number;
  category: string;
  title: string;
  description: string;
  tags: string[];
  relatedModules: string[];
  priority: string;
  metadata?: Record<string, any>;
}

export interface RepositoryIntelligence {
  repoId: string;
  techStack?: string[];
  architecture?: Record<string, any>;
  patterns?: string[];
  testingFrameworks?: string[];
  summary?: string;
}

export interface KnowledgeContext {
  modules?: Array<{ name: string; workflows?: string; businessRules?: string; apis?: string; }>;
  historicalBugs?: string[];
  existingTestCases?: string[];
  automationCoverage?: string[];
  enterpriseKnowledge?: EnterpriseKnowledgeItem[];
  repositoryContext?: RepositoryIntelligence;
  /**
   * Real application structure captured by the crawler (application_profiles.crawl_data).
   * When present, generation is grounded in REAL selectors, forms, flows and
   * credentials instead of generic guesses. Issue #2 fix.
   */
  applicationProfile?: ApplicationProfileContext;
  /**
   * Token-safe summaries of the project's Test Data sets (names, environments,
   * record counts, and a small sample of KEYS only — never values/secrets).
   * When present, generation references REAL project datasets (e.g. valid_users,
   * checkout_data) instead of inventing placeholder credentials/products.
   */
  testData?: Array<{ name: string; environment: string; recordCount: number; sampleKeys: string[] }>;
}

/** Compact, token-budgeted projection of an application profile for prompts. */
export interface ApplicationProfileContext {
  baseUrl?: string;
  name?: string;
  pageCount?: number;
  totalElements?: number;
  totalForms?: number;
  loginUrl?: string;
  username?: string;          // real username; password is NEVER included
  pages?: Array<{ url?: string; title?: string; pageType?: string; elementCount?: number; formCount?: number }>;
  forms?: Array<{
    page?: string;
    action?: string;
    method?: string;
    fields?: Array<{ name?: string; type?: string; required?: boolean; selector?: string; label?: string }>;
    submitSelector?: string;
  }>;
  keyElements?: Array<{ label?: string; tag?: string; selector?: string; role?: string }>;
}

/* ------------------------------------------------------------------ */
/*  Engine                                                             */
/* ------------------------------------------------------------------ */

export class TestCoverageEngine {
  private openai: OpenAI;
  private modelSelector: ModelSelector;
  private costTracker: CostTracker;

  constructor() {
    const apiKey = process.env['OPENAI_API_KEY'];
    if (!apiKey) throw new Error('OPENAI_API_KEY required for TestCoverageEngine');
    this.openai = new OpenAI({ apiKey });
    this.modelSelector = new ModelSelector();
    this.costTracker = new CostTracker();
  }

  /* ---- Build Enterprise Knowledge Block (uses KnowledgeOptimizer for smart selection) ---- */
  private buildEnterpriseKnowledgeBlock(knowledge?: KnowledgeContext, input?: RequirementInput): string {
    if (!knowledge?.enterpriseKnowledge?.length) return '';

    const items = knowledge.enterpriseKnowledge;

    // Use KnowledgeOptimizer for smart selection and formatting
    const optimizer = new KnowledgeOptimizer();
    const optimizerItems: OptimizerKnowledgeItem[] = items.map(i => ({
      id: i.id,
      category: i.category,
      title: i.title,
      description: i.description,
      tags: i.tags || [],
      related_modules: i.relatedModules || [],
      priority: i.priority,
      metadata: i.metadata,
    }));

    const optimized = optimizer.selectRelevantKnowledge(optimizerItems, {
      module: input?.module,
      testDescription: input ? `${input.title} ${input.description}` : undefined,
      tags: input?.businessFlow ? [input.businessFlow] : undefined,
    }, {
      maxTokens: 2000,
      maxItems: 10,
      format: 'test-case-lab',
    });

    if (!optimized.formattedContext) return '';

    logger.info(MOD, 'Enterprise knowledge optimized for test case lab', {
      totalItems: items.length,
      selectedItems: optimized.stats.selectedCount,
      estimatedTokens: optimized.stats.estimatedTokens,
      avgRelevance: optimized.stats.avgRelevanceScore,
    });

    return `\n\nCOMPANY-SPECIFIC KNOWLEDGE (${optimized.stats.selectedCount} of ${items.length} items — smart-selected by relevance):\n\n${optimized.formattedContext}

IMPORTANT: Use the above company-specific knowledge to:
1. Create test cases that validate business rules explicitly
2. Include regression tests for known bug patterns
3. Test workflow transitions and edge cases specific to this company
4. Verify integration points and dependencies
5. Avoid duplicating existing automation/manual test coverage`;
  }

  /* ---- Build Repository Intelligence Block ---- */
  private buildRepoIntelligenceBlock(knowledge?: KnowledgeContext): string {
    if (!knowledge?.repositoryContext) return '';
    const rc = knowledge.repositoryContext;
    const parts: string[] = [];

    if (rc.summary) parts.push(`Summary: ${rc.summary}`);
    if (rc.techStack?.length) parts.push(`Tech Stack: ${rc.techStack.join(', ')}`);
    if (rc.testingFrameworks?.length) parts.push(`Testing Frameworks: ${rc.testingFrameworks.join(', ')}`);
    if (rc.patterns?.length) parts.push(`Code Patterns: ${rc.patterns.join(', ')}`);
    if (rc.architecture && Object.keys(rc.architecture).length > 0) {
      parts.push(`Architecture: ${JSON.stringify(rc.architecture)}`);
    }

    if (parts.length === 0) return '';

    return `\n\nREPOSITORY INTELLIGENCE (analyzed from codebase):\n${parts.join('\n')}

Use this repository context to:
1. Align test scenarios with the actual tech stack and patterns used
2. Reference appropriate testing frameworks for test automation suggestions
3. Consider architectural boundaries and service interactions`;
  }

  /* ---- Build Application Profile Block (REAL crawled app structure — Issue #2) ---- */
  private buildApplicationProfileBlock(knowledge?: KnowledgeContext): string {
    const ap = knowledge?.applicationProfile;
    if (!ap) return '';
    const parts: string[] = [];

    const summary: string[] = [];
    if (ap.name) summary.push(`App: ${ap.name}`);
    if (ap.baseUrl) summary.push(`Base URL: ${ap.baseUrl}`);
    if (ap.pageCount != null) summary.push(`Pages crawled: ${ap.pageCount}`);
    if (ap.totalElements != null) summary.push(`Elements: ${ap.totalElements}`);
    if (ap.totalForms != null) summary.push(`Forms: ${ap.totalForms}`);
    if (summary.length) parts.push(summary.join(' | '));

    if (ap.loginUrl || ap.username) {
      parts.push(`\nAUTHENTICATION:\n  Login URL: ${ap.loginUrl || 'N/A'}\n  Username: ${ap.username || 'N/A'}\n  Password: use the placeholder <password> (never a real secret)`);
    }

    if (ap.pages?.length) {
      const pageLines = ap.pages.slice(0, 12).map(p =>
        `  - ${p.title || p.url || 'page'} [${p.pageType || 'unknown'}] (${p.elementCount ?? 0} elements, ${p.formCount ?? 0} forms)`
      );
      parts.push(`\nSITE MAP (real pages — reference these in navigation steps):\n${pageLines.join('\n')}`);
    }

    if (ap.forms?.length) {
      const formLines = ap.forms.slice(0, 8).map((f, i) => {
        const fields = (f.fields || []).slice(0, 10).map(fd =>
          `      • ${fd.label || fd.name || 'field'} (type=${fd.type || 'text'}${fd.required ? ', REQUIRED' : ''}) selector=${fd.selector || 'n/a'}`
        ).join('\n');
        return `  Form ${i + 1}${f.page ? ` on ${f.page}` : ''} [${f.method || 'GET'} ${f.action || ''}]:\n${fields}${f.submitSelector ? `\n      • submit selector=${f.submitSelector}` : ''}`;
      });
      parts.push(`\nFORMS (real fields + recommended selectors — use these EXACT selectors):\n${formLines.join('\n')}`);
    }

    if (ap.keyElements?.length) {
      const elLines = ap.keyElements.slice(0, 20).map(e =>
        `  - ${e.label || e.tag || 'element'}${e.role ? ` (role=${e.role})` : ''} selector=${e.selector || 'n/a'}`
      );
      parts.push(`\nKEY INTERACTIVE ELEMENTS (real selectors):\n${elLines.join('\n')}`);
    }

    if (parts.length === 0) return '';

    return `\n\nAPPLICATION PROFILE (REAL crawled application structure):\n${parts.join('\n')}

CRITICAL — Because this application has been crawled, you MUST:
1. Use the REAL selectors and field names above instead of generic placeholders.
2. Ground every navigation step in the real pages listed in the site map.
3. Write validation/negative tests against the actual REQUIRED form fields.
4. Set "selectorAvailability" to "high" for cases that use a real selector above.
5. Use the real login URL + username (with <password> placeholder) for auth steps.
Do NOT invent selectors or pages that are not present above.`;
  }

  /* ---- Build Test Data Block (REAL project datasets — token-safe summaries) ---- */
  private buildTestDataBlock(knowledge?: KnowledgeContext): string {
    const sets = knowledge?.testData;
    if (!sets?.length) return '';

    const lines = sets.slice(0, 12).map(ds => {
      const keys = ds.sampleKeys?.length ? ` — sample keys: ${ds.sampleKeys.slice(0, 5).join(', ')}` : '';
      return `  - ${ds.name} [${ds.environment}] (${ds.recordCount} record${ds.recordCount === 1 ? '' : 's'})${keys}`;
    });

    return `\n\nAVAILABLE TEST DATA (real datasets defined for this project):\n${lines.join('\n')}

Because these datasets exist, you MUST:
1. Reference the REAL dataset names and keys above (e.g. "log in using the standard_user record from valid_users") instead of inventing emails/passwords/products.
2. Use the actual keys as the data behind positive AND negative cases (e.g. a locked/invalid user from the data above for negative login).
3. Keep credentials and other secret values abstract — refer to the dataset/key, never embed a real password.
Do NOT invent placeholder data (john@test.com, password123, ABC Product) when a matching dataset above can supply it.`;
  }

  /* ---- Phase 2: Requirement Understanding ---- */
  async analyzeRequirement(
    input: RequirementInput,
    knowledge?: KnowledgeContext
  ): Promise<{ analysis: RequirementAnalysis; tokensUsed: number }> {
    const knowledgeBlock = knowledge?.modules?.length
      ? `\n\nAPPLICATION KNOWLEDGE:\n${knowledge.modules.map(m =>
          `Module: ${m.name}\n  Workflows: ${m.workflows || 'N/A'}\n  Business Rules: ${m.businessRules || 'N/A'}\n  APIs: ${m.apis || 'N/A'}`
        ).join('\n')}\n\nHistorical Bugs: ${(knowledge.historicalBugs || []).join('; ') || 'None'}\nExisting Tests: ${(knowledge.existingTestCases || []).join('; ') || 'None'}`
      : '';
    const enterpriseBlock = this.buildEnterpriseKnowledgeBlock(knowledge, input);
    // NOTE: Repository Intelligence is intentionally NOT injected here. Requirement
    // analysis (featureType/riskLevel/impactedModules) does not benefit from
    // code-level tech-stack/pattern details — sending it here only burns tokens
    // and latency. Repo intelligence is injected ONLY into the test-case
    // generation prompt below, where it can actually influence output.
    const appProfileBlock = this.buildApplicationProfileBlock(knowledge);
    const testDataBlock = this.buildTestDataBlock(knowledge);

    const prompt = `You are a senior QA architect analyzing a software requirement.

REQUIREMENT:
Title: ${input.title}
Description: ${input.description}
${input.acceptanceCriteria ? `Acceptance Criteria: ${input.acceptanceCriteria}` : ''}
${input.businessFlow ? `Business Flow: ${input.businessFlow}` : ''}
${input.module ? `Module: ${input.module}` : ''}
${input.apiDocs ? `API Documentation: ${input.apiDocs}` : ''}
${input.releaseNotes ? `Release Notes: ${input.releaseNotes}` : ''}${knowledgeBlock}${enterpriseBlock}${appProfileBlock}${testDataBlock}

Analyze this requirement and return a JSON object with:
- featureType: string (e.g. "authentication", "payment", "search", "data_entry", "reporting")
- riskLevel: "critical" | "high" | "medium" | "low"
- businessCriticality: brief explanation of business impact
- impactedModules: string[] of modules/components affected
- userRolesAffected: string[] of user roles impacted
- apiDependencies: string[] of API endpoints involved
- dbImpact: brief description of database changes
- workflowSteps: string[] ordered steps in the user workflow
- summary: 2-3 sentence executive summary

Return ONLY valid JSON, no markdown fences.`;

    const resp = await this.callLLM(prompt, 800);
    let analysis: RequirementAnalysis;
    try {
      analysis = JSON.parse(resp.content);
    } catch {
      analysis = {
        featureType: 'general',
        riskLevel: 'medium',
        businessCriticality: 'Standard feature',
        impactedModules: [input.module || 'unknown'],
        userRolesAffected: ['end_user'],
        apiDependencies: [],
        dbImpact: 'Unknown',
        workflowSteps: [],
        summary: input.description.slice(0, 200),
      };
    }
    return { analysis, tokensUsed: resp.tokensUsed };
  }

  /* ---- Phase 5: Test Case Generation ---- */
  async generateTestCoverage(
    input: RequirementInput,
    analysis: RequirementAnalysis,
    coverageTypes: CoverageType[],
    knowledge?: KnowledgeContext,
    mode: GenerationMode = 'strict'
  ): Promise<{
    scenarios: TestScenario[];
    testCases: TestCase[];
    suggestedTestCases: TestCase[];
    missingRequirements: MissingRequirement[];
    tokensUsed: number;
  }> {
    // EXPANDED mode only: auto-expand to a comprehensive baseline so the
    // *suggested additional coverage* bucket is thorough. In STRICT mode we do
    // NOT inflate the requested types — strict coverage must stay tightly scoped
    // to what the requirement actually asks for (no forced negative/boundary/etc).
    const expand = mode === 'expanded';
    if (expand) {
      const baselineTypes: CoverageType[] = ['positive', 'negative', 'edge_cases', 'boundary', 'integration'];
      coverageTypes = Array.from(new Set([...coverageTypes, ...baselineTypes]));
    } else if (coverageTypes.length === 0) {
      // Strict mode with no explicit types — default to positive (happy path)
      // which is what a single requirement most directly implies.
      coverageTypes = ['positive'];
    }

    const knowledgeBugs = knowledge?.historicalBugs?.length
      ? `\nHistorical bugs to consider: ${knowledge.historicalBugs.join('; ')}`
      : '';
    const knowledgeTests = knowledge?.existingTestCases?.length
      ? `\nExisting test coverage: ${knowledge.existingTestCases.join('; ')}`
      : '';
    const enterpriseBlock = this.buildEnterpriseKnowledgeBlock(knowledge, input);
    const repoBlock = this.buildRepoIntelligenceBlock(knowledge);
    const appProfileBlock = this.buildApplicationProfileBlock(knowledge);
    const testDataBlock = this.buildTestDataBlock(knowledge);

    // Build per-type coverage expectations
    const coverageExpectations = coverageTypes.map(ct => {
      const expectations: Record<string, string> = {
        positive: 'positive — 2-3 scenarios covering happy paths, successful workflows, valid inputs. 3-5 test cases each.',
        negative: 'negative — 2-3 scenarios covering invalid inputs, error handling, permission denied, missing data. 3-4 test cases each.',
        edge_cases: 'edge_cases — 2-3 scenarios covering corner cases, unusual inputs, empty states, concurrent actions, timing issues. 3-4 test cases each.',
        boundary: 'boundary — 2 scenarios covering min/max values, character limits, zero values, overflow conditions. 2-3 test cases each.',
        security: 'security — 2 scenarios covering auth bypass, injection, XSS, CSRF, session hijacking. 2-3 test cases each.',
        api: 'api — 2 scenarios covering endpoint contracts, response codes, payload validation, rate limits. 2-3 test cases each.',
        ui: 'ui — 2 scenarios covering layout, responsiveness, form validation, loading states. 2-3 test cases each.',
        mobile: 'mobile — 2 scenarios covering touch interactions, responsive behavior, orientation changes. 2-3 test cases each.',
        accessibility: 'accessibility — 2 scenarios covering screen reader, keyboard navigation, ARIA labels, color contrast. 2-3 test cases each.',
        performance: 'performance — 1-2 scenarios covering load time, large datasets, concurrent requests. 2-3 test cases each.',
        integration: 'integration — 2 scenarios covering cross-module flows, third-party API interactions, data consistency. 2-3 test cases each.',
        regression: 'regression — 2 scenarios covering previously broken features, critical paths after changes. 2-3 test cases each.',
        cross_browser: 'cross_browser — 1-2 scenarios covering Chrome, Firefox, Safari, Edge rendering differences. 2-3 test cases each.',
        data_validation: 'data_validation — 2 scenarios covering input sanitization, format validation, required fields, type checking. 2-3 test cases each.',
        role_based: 'role_based — 2 scenarios covering permission levels, role transitions, unauthorized access. 2-3 test cases each.',
        localization: 'localization — 1-2 scenarios covering language switching, RTL support, date/number formats. 2-3 test cases each.',
      };
      return expectations[ct] || `${ct} — 2 scenarios, 2-3 test cases each.`;
    }).join('\n  - ');

    // ── Mode-specific scope & volume guidance ──
    // STRICT: tightly scoped to the requirement, small case count, no expansion.
    // EXPANDED: strict coverage + a separate suggested-additional-coverage bucket.
    const scopeBlock = expand
      ? `GENERATION MODE: EXPANDED COVERAGE (Coverage Gap Analysis is ON)
  - Produce TWO separate buckets:
    1) "testCases" — STRICT requirement coverage (see the STRICT SCOPE rules below). This is still tightly scoped to the requirement.
    2) "suggestedTestCases" — ADDITIONAL coverage the requirement does not state but a senior QA would consider (negative paths, security, edge/boundary, role/permission, concurrency). These are SUGGESTIONS for review — keep them OUT of "testCases".
  - For suggestedTestCases you MAY use the requested coverage types as inspiration:
  - ${coverageExpectations}
  - Aim for quality over quantity: a handful of high-value suggestions, not dozens.`
      : `GENERATION MODE: STRICT REQUIREMENT COVERAGE (Coverage Gap Analysis is OFF)
  - Produce ONLY "testCases" that trace DIRECTLY to the stated requirement.
  - "suggestedTestCases" MUST be an empty array [].
  - DO NOT add negative, boundary, security, concurrency, or permission cases unless the REQUIREMENT itself states them.`;

    const volumeBlock = expand
      ? `OUTPUT VOLUME:
  - "testCases" (strict): typically 3-6 — only what the requirement directly demands.
  - "suggestedTestCases" (expansion): up to ~8 high-value additional cases. Fewer is fine.`
      : `OUTPUT VOLUME:
  - Generate ONLY as many cases as the requirement genuinely needs — typically 3-6 for a single, focused requirement.
  - Do NOT pad to hit a number. A small, precise set is the CORRECT result. Quality over quantity.`;

    const prompt = `You are a principal QA engineer. ${expand ? 'Generate strict requirement coverage PLUS clearly-separated suggested additional coverage.' : 'Generate ONLY the test cases that a single, focused requirement genuinely demands — no padding, no scope creep.'}

REQUIREMENT:
Title: ${input.title}
Description: ${input.description}
${input.acceptanceCriteria ? `Acceptance Criteria: ${input.acceptanceCriteria}` : ''}
${input.businessFlow ? `Business Flow: ${input.businessFlow}` : ''}

ANALYSIS:
Feature Type: ${analysis.featureType}
Risk Level: ${analysis.riskLevel}
Impacted Modules: ${analysis.impactedModules.join(', ')}
Workflow: ${analysis.workflowSteps.join(' → ')}
User Roles: ${analysis.userRolesAffected.join(', ')}${knowledgeBugs}${knowledgeTests}${enterpriseBlock}${repoBlock}${appProfileBlock}${testDataBlock}

${scopeBlock}

${volumeBlock}

STRICT SCOPE — the single most important rule (applies to "testCases"):
  - A test case belongs in "testCases" ONLY if it verifies behaviour the REQUIREMENT (title / description / acceptance criteria / business flow) explicitly states or directly implies.
  - APP KNOWLEDGE, TEST DATA, and APP PROFILE are CONTEXT — they ENRICH a requirement-derived case (e.g. use a real "standard_user" record as the test data for the login case). They DO NOT justify a brand-new case on their own.
  - Concrete example: a requirement "standard user logs in and reaches Inventory" justifies: (a) successful login, (b) navigation to Inventory. It does NOT justify "locked-out user login", "invalid username", "empty credentials", "max character limit", "concurrent login", or "session persistence" — the requirement never asked for those.
  - The existence of a "locked_users" or "problem_users" dataset is NOT a reason to generate a locked-user test for a valid-login requirement. Use such data only if the requirement is about that behaviour.

ASSUMPTIONS → MISSING REQUIREMENTS (do NOT fabricate test cases):
  - If you would need to ASSUME a value/limit/behaviour not stated anywhere (e.g. a username max length, a lockout threshold, a session timeout), DO NOT create a test case for it.
  - Instead, add an entry to "missingRequirements" phrased as a question for the requirement author (e.g. { "question": "What is the maximum username length?", "area": "Input validation", "rationale": "No length limit is stated, so a boundary test cannot be written reliably." }).
  - This is MORE valuable than a guessed test case. NEVER emit a test case with source "assumption".

QUALITY STANDARDS — each test case must have:
  - Specific, actionable title (NOT vague like "Verify login works")
  - Clear preconditions, numbered steps (3-6), precise expected result, realistic test data.

NO DUPLICATES:
  - Do NOT emit multiple cases that verify the same behaviour with different wording. "Verify successful login", "Verify navigation after login", and "Verify login+inventory integration" overlap heavily — keep the distinct ones, merge the rest.

SOURCE TAGGING — every test case (in BOTH buckets) MUST include:
  - "source": one of "requirement" | "knowledge" | "test_data" | "app_profile" | "gap_analysis"
      • "requirement" — directly verifies the stated requirement / acceptance criteria. (Most "testCases" should be this.)
      • "knowledge"  — the requirement case is grounded in / enriched by APP KNOWLEDGE business rules.
      • "test_data"  — the requirement case uses a real dataset listed under AVAILABLE TEST DATA.
      • "app_profile"— grounded in the crawled APP PROFILE structure/selectors.
      • "gap_analysis" — ONLY for "suggestedTestCases": coverage the requirement implies but does not state.
  - "source" MUST NOT be "assumption" — assumptions go to "missingRequirements" instead.
  - "sourceEvidence": a short phrase naming the exact evidence (e.g. "AC: standard user logs in", "standard_user dataset", "Authentication Rules knowledge").

IMPORTANT: Each test case must include a "scenarioIndex" field (0-based) linking it to the scenario it belongs to.

Return JSON (use [] for empty buckets):
{
  "scenarios": [{ "scenario": string, "coverageType": string, "priority": "P0"|"P1"|"P2"|"P3", "riskArea": string }],
  "testCases": [{
    "title": string, "scenarioIndex": number, "preconditions": string, "steps": string[],
    "expectedResult": string, "testData": string,
    "priority": "P0"|"P1"|"P2"|"P3", "severity": "critical"|"major"|"minor"|"trivial",
    "tags": string[], "automationReady": boolean,
    "automationComplexity": "low"|"medium"|"high", "selectorAvailability": "high"|"medium"|"low"|"unknown",
    "source": "requirement"|"knowledge"|"test_data"|"app_profile", "sourceEvidence": string
  }],
  "suggestedTestCases": [ /* same shape as a testCase; source usually "gap_analysis". EMPTY [] in strict mode. */ ],
  "missingRequirements": [{ "question": string, "area": string, "rationale": string }]
}

Return ONLY valid JSON. ${expand ? 'Keep strict requirement coverage and suggestions in SEPARATE buckets.' : 'Stay strictly within the requirement scope.'}`;

    const resp = await this.callLLM(prompt, 6000);
    let parsed: {
      scenarios?: TestScenario[];
      testCases?: TestCase[];
      suggestedTestCases?: TestCase[];
      missingRequirements?: MissingRequirement[];
    };
    try {
      parsed = JSON.parse(resp.content);
    } catch {
      logger.error(MOD, 'Failed to parse test generation response', { raw: resp.content.slice(0, 300) });
      parsed = { scenarios: [], testCases: [] };
    }

    let scenarios = parsed.scenarios || [];
    let testCases = parsed.testCases || [];
    let suggestedTestCases = expand ? (parsed.suggestedTestCases || []) : [];
    const missingRequirements = parsed.missingRequirements || [];

    // ── Safety net — enforce the strict/expanded contract even if the model
    //    misclassifies. Any case the model tagged "assumption" or "gap_analysis"
    //    is NOT requirement coverage: move it out of testCases.
    const isExpansionCase = (tc: TestCase) =>
      (tc as any).source === 'assumption' || (tc as any).source === 'gap_analysis';
    const misplaced = testCases.filter(isExpansionCase);
    if (misplaced.length > 0) {
      testCases = testCases.filter(tc => !isExpansionCase(tc));
      if (expand) {
        // Relocate genuine expansion cases into the suggestions bucket (drop pure assumptions).
        suggestedTestCases = [
          ...suggestedTestCases,
          ...misplaced.filter(tc => (tc as any).source !== 'assumption'),
        ];
      }
      logger.info(MOD, 'Strict-scope safety net relocated misclassified cases', {
        mode, relocated: misplaced.length, keptStrict: testCases.length,
      });
    }

    return { scenarios, testCases, suggestedTestCases, missingRequirements, tokensUsed: resp.tokensUsed };
  }

  /* ---- Phase 6: Coverage Gap Analysis ---- */
  async analyzeCoverageGaps(
    input: RequirementInput,
    analysis: RequirementAnalysis,
    scenarios: TestScenario[],
    knowledge?: KnowledgeContext
  ): Promise<{ gaps: CoverageGap[]; tokensUsed: number }> {
    const existingCoverage = knowledge?.existingTestCases?.length
      ? `\nExisting Test Cases: ${knowledge.existingTestCases.join('; ')}`
      : '';
    const enterpriseBlock = this.buildEnterpriseKnowledgeBlock(knowledge, input);
    // Repository Intelligence is NOT injected into gap analysis — gaps are about
    // what CANNOT be automated, which is unrelated to the codebase's tech stack.
    // Skipping it here saves tokens with zero loss of quality.

    const prompt = `You are a QA coverage analyst reviewing an ALREADY-COMPREHENSIVE automated test suite. The scenarios below represent extensive, release-ready automated coverage (positive, negative, edge cases, boundary, integration, security, etc.). Your ONLY job is to flag the small number of items that genuinely CANNOT or SHOULD NOT be covered by this automated test suite.

REQUIREMENT:
Title: ${input.title}
Description: ${input.description}
Feature Type: ${analysis.featureType}
Risk Level: ${analysis.riskLevel}
Workflow: ${analysis.workflowSteps.join(' → ')}
Impacted Modules: ${analysis.impactedModules.join(', ')}${existingCoverage}${enterpriseBlock}

CURRENT AUTOMATED SCENARIOS (already comprehensive):
${scenarios.map((s, i) => `${i + 1}. [${s.coverageType}] ${s.scenario}`).join('\n')}

CRITICAL RULES — read carefully:
1. The automated suite above is intended to be COMPREHENSIVE. Do NOT list anything that a normal automated functional, negative, edge-case, boundary, integration, security, performance, or API test could reasonably cover — those belong in the test suite, NOT in gaps. Assume they are already covered.
2. ONLY report a gap if it is genuinely IMPRACTICAL or IMPOSSIBLE to automate in a standard CI test suite. Valid gap categories are STRICTLY limited to:
   - Manual / exploratory verification that requires human judgment (e.g., subjective UX quality, visual design polish, real-user usability sessions).
   - Physical devices or hardware that cannot be virtualized (e.g., specific biometric scanners, printers, IoT hardware, real mobile device farms).
   - Third-party / external systems outside your control that cannot be reliably stubbed (e.g., live payment gateways in production, external regulatory bodies, real SMS/email delivery to carriers).
   - Extreme-scale or destructive conditions needing dedicated infrastructure (e.g., true production-scale load testing, chaos/disaster-recovery drills, data-center failover).
   - Real-money, legal, or irreversible operations that are unsafe to automate against production.
3. Concurrency, data boundaries, error recovery, cross-module interactions, security, standard performance, accessibility, and rollback/undo are ALL automatable — DO NOT list them as gaps. They must be assumed covered by the suite.
4. If the automated coverage is comprehensive and nothing genuinely falls into the categories above, return an EMPTY array []. An empty array is the EXPECTED and CORRECT result for most well-covered requirements.
5. Return AT MOST 3 gaps, and only if they truly qualify. Quality over quantity. Fewer is better.

Return JSON array (empty array if no genuine non-automatable gaps exist):
[{ "area": string, "description": string, "severity": "critical"|"high"|"medium"|"low", "suggestion": string }]

Return ONLY valid JSON array.`;

    const resp = await this.callLLM(prompt, 1500);
    let gaps: CoverageGap[];
    try {
      gaps = JSON.parse(resp.content);
    } catch {
      gaps = [];
    }
    return { gaps, tokensUsed: resp.tokensUsed };
  }

  /* ---- Full Pipeline ---- */
  async generateFullCoverage(
    input: RequirementInput,
    coverageTypes: CoverageType[],
    knowledge?: KnowledgeContext,
    options?: { includeCoverageGaps?: boolean; deduplicate?: boolean; mode?: GenerationMode }
  ): Promise<GenerationResult> {
    // The "Coverage Gap Analysis" toggle drives BOTH the generation mode and the
    // separate gap-analysis LLM call:
    //   • OFF → STRICT mode: only requirement-derived cases, no expansion, no gap call.
    //   • ON  → EXPANDED mode: requirement coverage + a separate "suggested additional
    //           coverage" bucket + the non-automatable gap analysis pass.
    // This matches the product rule: "make it strict — only if gap analysis is enabled
    // do we add extra cases." Callers can still force a mode via options.mode.
    const includeCoverageGaps = options?.includeCoverageGaps !== false;
    const mode: GenerationMode = options?.mode ?? (includeCoverageGaps ? 'expanded' : 'strict');
    logger.info(MOD, 'Starting full coverage generation', { title: input.title, coverageTypes, includeCoverageGaps, mode });

    // Phase 2: Analyze requirement
    const { analysis, tokensUsed: t1 } = await this.analyzeRequirement(input, knowledge);
    logger.info(MOD, 'Requirement analysis complete', { featureType: analysis.featureType, riskLevel: analysis.riskLevel });

    // Phase 5: Generate tests (mode-aware — strict vs expanded)
    const gen = await this.generateTestCoverage(input, analysis, coverageTypes, knowledge, mode);
    const { scenarios, testCases: rawTestCases, missingRequirements, tokensUsed: t2 } = gen;
    let rawSuggested = gen.suggestedTestCases || [];
    logger.info(MOD, 'Test generation complete', {
      scenarios: scenarios.length, testCases: rawTestCases.length,
      suggested: rawSuggested.length, missingRequirements: missingRequirements.length, mode,
    });

    // Phase 5b: Semantic de-duplication — drop near-identical cases (e.g. three
    // variants of the same happy-path login). Cheap batched embeddings call; fails
    // open. Can be disabled via options.deduplicate=false. Applied to both buckets.
    let testCases = rawTestCases;
    let suggestedTestCases = rawSuggested;
    let duplicatesRemoved = 0;
    if (options?.deduplicate !== false) {
      if (rawTestCases.length > 1) {
        const dedup = await this.deduplicateTestCases(rawTestCases);
        testCases = dedup.kept;
        duplicatesRemoved += dedup.removed;
      }
      if (rawSuggested.length > 1) {
        const dedupS = await this.deduplicateTestCases(rawSuggested);
        suggestedTestCases = dedupS.kept;
        duplicatesRemoved += dedupS.removed;
      }
    }

    // Phase 6: Gap analysis (only in expanded mode — saves a full LLM call in strict).
    let gaps: CoverageGap[] = [];
    let t3 = 0;
    if (includeCoverageGaps) {
      const gapResult = await this.analyzeCoverageGaps(input, analysis, scenarios, knowledge);
      gaps = gapResult.gaps;
      t3 = gapResult.tokensUsed;
      logger.info(MOD, 'Gap analysis complete', { gaps: gaps.length });
    } else {
      logger.info(MOD, 'Gap analysis skipped (strict mode) — saved one LLM call');
    }

    const totalTokens = t1 + t2 + t3;
    return {
      requirementAnalysis: analysis,
      scenarios,
      testCases,
      suggestedTestCases,
      missingRequirements,
      coverageGaps: gaps,
      mode,
      stats: {
        totalScenarios: scenarios.length,
        totalTestCases: testCases.length,
        coverageTypes,
        automationReadyCount: testCases.filter(tc => tc.automationReady).length,
        gapsFound: gaps.length,
        tokensUsed: totalTokens,
        duplicatesRemoved,
        suggestedCount: suggestedTestCases.length,
        missingRequirementsCount: missingRequirements.length,
      },
    };
  }

  /* ---- Semantic de-duplication of generated test cases ---- */
  /**
   * Removes near-duplicate test cases using embedding cosine similarity.
   * Two cases above `threshold` similarity are treated as duplicates; the
   * stronger one is kept (higher priority, then more detailed steps). This is a
   * single batched embeddings call (cheap + fast — text-embedding-3-small) and
   * FAILS OPEN: any error returns the original list unchanged so generation is
   * never blocked. Returns the kept cases plus how many were removed.
   */
  async deduplicateTestCases(
    testCases: TestCase[],
    threshold = 0.9
  ): Promise<{ kept: TestCase[]; removed: number }> {
    if (testCases.length < 2) return { kept: testCases, removed: 0 };

    try {
      // Embed a compact signature for each case: title + expected result carry the
      // semantic intent; including them keeps "same behaviour, different wording"
      // cases close in vector space.
      const signatures = testCases.map(tc =>
        `${tc.title || ''}. ${tc.expectedResult || ''}`.trim().slice(0, 500)
      );

      const modelConfig = this.modelSelector.selectModel('similarity');
      const resp = await this.openai.embeddings.create({
        model: modelConfig.model,
        input: signatures,
      });
      const vectors = resp.data.map(d => d.embedding as number[]);
      if (vectors.length !== testCases.length) {
        // Defensive: provider returned an unexpected count — skip dedup.
        return { kept: testCases, removed: 0 };
      }

      const priorityRank = (p?: string) => ({ P0: 0, P1: 1, P2: 2, P3: 3 }[p || 'P2'] ?? 2);
      // Prefer the "stronger" case to survive a duplicate pair.
      const isStronger = (a: TestCase, b: TestCase) => {
        const pr = priorityRank(a.priority) - priorityRank(b.priority);
        if (pr !== 0) return pr < 0;                       // higher priority wins
        const stepsDiff = (a.steps?.length || 0) - (b.steps?.length || 0);
        if (stepsDiff !== 0) return stepsDiff > 0;          // more detailed wins
        return (a.expectedResult?.length || 0) >= (b.expectedResult?.length || 0);
      };

      const removedIdx = new Set<number>();
      for (let i = 0; i < testCases.length; i++) {
        if (removedIdx.has(i)) continue;
        for (let j = i + 1; j < testCases.length; j++) {
          if (removedIdx.has(j)) continue;
          const sim = cosineSimilarity(vectors[i], vectors[j]);
          if (sim >= threshold) {
            // Drop the weaker of the pair.
            const loser = isStronger(testCases[i], testCases[j]) ? j : i;
            removedIdx.add(loser);
            if (loser === i) break; // i is gone — stop comparing it further
          }
        }
      }

      if (removedIdx.size === 0) return { kept: testCases, removed: 0 };
      const kept = testCases.filter((_, idx) => !removedIdx.has(idx));
      logger.info(MOD, 'Semantic dedup removed near-duplicate test cases', {
        before: testCases.length, after: kept.length, removed: removedIdx.size, threshold,
      });
      return { kept, removed: removedIdx.size };
    } catch (err: any) {
      logger.warn(MOD, 'Dedup failed (continuing with full set)', { error: err.message });
      return { kept: testCases, removed: 0 };
    }
  }

  /* ---- LLM Call Helper (cost-optimized) ---- */
  private async callLLM(prompt: string, maxTokens: number): Promise<{ content: string; tokensUsed: number }> {
    // Use ModelSelector for intelligent model selection
    const modelConfig = this.modelSelector.selectModel('test_generation', 'standard');
    const effectiveMaxTokens = Math.min(maxTokens, modelConfig.maxTokens);

    // Truncate prompt to avoid excessive token usage (token optimization)
    const maxPromptChars = parseInt(process.env['MAX_TOKENS_PER_REQUEST'] || '4000', 10) * 4;
    const truncatedPrompt = prompt.length > maxPromptChars
      ? prompt.slice(0, maxPromptChars) + '\n\n[Context truncated for cost optimization]'
      : prompt;

    const resp = await this.openai.chat.completions.create({
      model: modelConfig.model,
      temperature: modelConfig.temperature,
      max_tokens: effectiveMaxTokens,
      messages: [
        { role: 'system', content: 'You are a senior QA architect and test engineer. Always return valid JSON only — no markdown, no explanation, no code fences.' },
        { role: 'user', content: truncatedPrompt },
      ],
    });
    let content = resp.choices[0]?.message?.content || '{}';
    // Strip markdown code fences that GPT sometimes wraps around JSON
    content = content.trim();
    if (content.startsWith('```')) {
      content = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    const tokensUsed = (resp.usage?.prompt_tokens || 0) + (resp.usage?.completion_tokens || 0);

    // Track cost (fire-and-forget to avoid blocking)
    this.costTracker.trackRequest({
      model: modelConfig.model,
      tokensUsed,
      feature: 'test_coverage',
      taskType: 'test_generation',
    }).catch((err) => {
      logger.warn(MOD, 'Cost tracking failed (non-blocking)', { error: (err as Error).message });
    });

    return { content: content.trim(), tokensUsed };
  }
}
