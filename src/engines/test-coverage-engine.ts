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
}

export interface CoverageGap {
  area: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  suggestion: string;
}

export interface GenerationResult {
  requirementAnalysis: RequirementAnalysis;
  scenarios: TestScenario[];
  testCases: TestCase[];
  coverageGaps: CoverageGap[];
  stats: {
    totalScenarios: number;
    totalTestCases: number;
    coverageTypes: string[];
    automationReadyCount: number;
    gapsFound: number;
    tokensUsed: number;
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
    const repoBlock = this.buildRepoIntelligenceBlock(knowledge);

    const prompt = `You are a senior QA architect analyzing a software requirement.

REQUIREMENT:
Title: ${input.title}
Description: ${input.description}
${input.acceptanceCriteria ? `Acceptance Criteria: ${input.acceptanceCriteria}` : ''}
${input.businessFlow ? `Business Flow: ${input.businessFlow}` : ''}
${input.module ? `Module: ${input.module}` : ''}
${input.apiDocs ? `API Documentation: ${input.apiDocs}` : ''}
${input.releaseNotes ? `Release Notes: ${input.releaseNotes}` : ''}${knowledgeBlock}${enterpriseBlock}${repoBlock}

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
    knowledge?: KnowledgeContext
  ): Promise<{ scenarios: TestScenario[]; testCases: TestCase[]; tokensUsed: number }> {
    // Auto-expand to a comprehensive baseline so core coverage is always thorough.
    // Even if the caller only requested a couple of types, we always include the
    // foundational automatable coverage types. This pushes the bulk of testing into
    // CORE coverage (so gap analysis has little left to report).
    const baselineTypes: CoverageType[] = ['positive', 'negative', 'edge_cases', 'boundary', 'integration'];
    coverageTypes = Array.from(new Set([...coverageTypes, ...baselineTypes]));

    const knowledgeBugs = knowledge?.historicalBugs?.length
      ? `\nHistorical bugs to consider: ${knowledge.historicalBugs.join('; ')}`
      : '';
    const knowledgeTests = knowledge?.existingTestCases?.length
      ? `\nExisting test coverage: ${knowledge.existingTestCases.join('; ')}`
      : '';
    const enterpriseBlock = this.buildEnterpriseKnowledgeBlock(knowledge, input);
    const repoBlock = this.buildRepoIntelligenceBlock(knowledge);

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

    const numTypes = coverageTypes.length;
    const minScenarios = Math.max(8, numTypes * 2);
    const minTestCases = Math.max(15, numTypes * 4);

    const prompt = `You are a principal QA engineer writing release-ready test coverage. Generate comprehensive, thorough test scenarios and detailed test cases that a QA lead would approve for production release.

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
User Roles: ${analysis.userRolesAffected.join(', ')}${knowledgeBugs}${knowledgeTests}${enterpriseBlock}${repoBlock}

COVERAGE TYPES REQUESTED (${numTypes} types): ${coverageTypes.join(', ')}

MANDATORY COVERAGE REQUIREMENTS:
  - ${coverageExpectations}

MINIMUM OUTPUT TARGETS:
  - At least ${minScenarios} scenarios total across all coverage types
  - At least ${minTestCases} test cases total
  - Every requested coverage type MUST have at least 2 scenarios and 4 test cases
  - Critical/high risk areas need MORE test cases

QUALITY STANDARDS — Each test case must have:
  - Specific, actionable title (NOT vague like "Verify login works")
  - Clear preconditions (what must be true before testing)
  - Numbered steps (3-6 steps, specific user actions)
  - Precise expected result (what exactly should happen)
  - Realistic test data examples

BAD examples (NEVER generate):
  - "Verify login works" (too vague)
  - "Test error handling" (no specificity)
  - "Check boundary values" (which values?)

GOOD examples:
  - "Verify session token invalidation after password reset from another device"
  - "Verify failed login throttling locks account after 5 consecutive attempts within 15 minutes"
  - "Verify SQL injection prevention in search field with payload: ' OR 1=1 --"
  - "Verify form submission with maximum character limit (255 chars) in name field"

IMPORTANT: Each test case must include a "scenarioIndex" field (0-based) linking it to the scenario it belongs to. This ensures proper grouping.

Return JSON:
{
  "scenarios": [{ "scenario": string, "coverageType": string, "priority": "P0"|"P1"|"P2"|"P3", "riskArea": string }],
  "testCases": [{
    "title": string,
    "scenarioIndex": number,
    "preconditions": string,
    "steps": string[],
    "expectedResult": string,
    "testData": string,
    "priority": "P0"|"P1"|"P2"|"P3",
    "severity": "critical"|"major"|"minor"|"trivial",
    "tags": string[],
    "automationReady": boolean,
    "automationComplexity": "low"|"medium"|"high",
    "selectorAvailability": "high"|"medium"|"low"|"unknown"
  }]
}

Return ONLY valid JSON. Generate comprehensive coverage — this is for a production release.`;

    const resp = await this.callLLM(prompt, 6000);
    let parsed: { scenarios: TestScenario[]; testCases: TestCase[] };
    try {
      parsed = JSON.parse(resp.content);
    } catch {
      logger.error(MOD, 'Failed to parse test generation response', { raw: resp.content.slice(0, 300) });
      parsed = { scenarios: [], testCases: [] };
    }
    return { ...parsed, tokensUsed: resp.tokensUsed };
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
    const repoBlock = this.buildRepoIntelligenceBlock(knowledge);

    const prompt = `You are a QA coverage analyst reviewing an ALREADY-COMPREHENSIVE automated test suite. The scenarios below represent extensive, release-ready automated coverage (positive, negative, edge cases, boundary, integration, security, etc.). Your ONLY job is to flag the small number of items that genuinely CANNOT or SHOULD NOT be covered by this automated test suite.

REQUIREMENT:
Title: ${input.title}
Description: ${input.description}
Feature Type: ${analysis.featureType}
Risk Level: ${analysis.riskLevel}
Workflow: ${analysis.workflowSteps.join(' → ')}
Impacted Modules: ${analysis.impactedModules.join(', ')}${existingCoverage}${enterpriseBlock}${repoBlock}

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
    knowledge?: KnowledgeContext
  ): Promise<GenerationResult> {
    logger.info(MOD, 'Starting full coverage generation', { title: input.title, coverageTypes });

    // Phase 2: Analyze requirement
    const { analysis, tokensUsed: t1 } = await this.analyzeRequirement(input, knowledge);
    logger.info(MOD, 'Requirement analysis complete', { featureType: analysis.featureType, riskLevel: analysis.riskLevel });

    // Phase 5: Generate tests
    const { scenarios, testCases, tokensUsed: t2 } = await this.generateTestCoverage(
      input, analysis, coverageTypes, knowledge
    );
    logger.info(MOD, 'Test generation complete', { scenarios: scenarios.length, testCases: testCases.length });

    // Phase 6: Gap analysis
    const { gaps, tokensUsed: t3 } = await this.analyzeCoverageGaps(
      input, analysis, scenarios, knowledge
    );
    logger.info(MOD, 'Gap analysis complete', { gaps: gaps.length });

    const totalTokens = t1 + t2 + t3;
    return {
      requirementAnalysis: analysis,
      scenarios,
      testCases,
      coverageGaps: gaps,
      stats: {
        totalScenarios: scenarios.length,
        totalTestCases: testCases.length,
        coverageTypes,
        automationReadyCount: testCases.filter(tc => tc.automationReady).length,
        gapsFound: gaps.length,
        tokensUsed: totalTokens,
      },
    };
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
