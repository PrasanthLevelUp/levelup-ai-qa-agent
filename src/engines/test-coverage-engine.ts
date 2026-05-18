/**
 * AI Test Coverage Intelligence Engine
 * Transforms requirements into senior-QA-level test scenarios & cases
 * with business awareness, coverage gap analysis, and automation readiness scoring.
 */

import OpenAI from 'openai';
import { logger } from '../utils/logger';

const MOD = 'test-coverage-engine';
const MODEL = 'gpt-4o-mini';

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

export interface KnowledgeContext {
  modules?: Array<{ name: string; workflows?: string; businessRules?: string; apis?: string; }>;
  historicalBugs?: string[];
  existingTestCases?: string[];
  automationCoverage?: string[];
}

/* ------------------------------------------------------------------ */
/*  Engine                                                             */
/* ------------------------------------------------------------------ */

export class TestCoverageEngine {
  private openai: OpenAI;

  constructor() {
    const apiKey = process.env['OPENAI_API_KEY'];
    if (!apiKey) throw new Error('OPENAI_API_KEY required for TestCoverageEngine');
    this.openai = new OpenAI({ apiKey });
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

    const prompt = `You are a senior QA architect analyzing a software requirement.

REQUIREMENT:
Title: ${input.title}
Description: ${input.description}
${input.acceptanceCriteria ? `Acceptance Criteria: ${input.acceptanceCriteria}` : ''}
${input.businessFlow ? `Business Flow: ${input.businessFlow}` : ''}
${input.module ? `Module: ${input.module}` : ''}
${input.apiDocs ? `API Documentation: ${input.apiDocs}` : ''}
${input.releaseNotes ? `Release Notes: ${input.releaseNotes}` : ''}${knowledgeBlock}

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
    const knowledgeBugs = knowledge?.historicalBugs?.length
      ? `\nHistorical bugs to consider: ${knowledge.historicalBugs.join('; ')}`
      : '';
    const knowledgeTests = knowledge?.existingTestCases?.length
      ? `\nExisting test coverage: ${knowledge.existingTestCases.join('; ')}`
      : '';

    const prompt = `You are a senior QA engineer with 15+ years experience. Generate test coverage that a real senior QA engineer would write — NOT generic textbook cases.

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
User Roles: ${analysis.userRolesAffected.join(', ')}${knowledgeBugs}${knowledgeTests}

COVERAGE TYPES REQUESTED: ${coverageTypes.join(', ')}

GENERATE:
1. Test Scenarios (high-level, 2-4 per coverage type)
2. Detailed Test Cases (3-6 per scenario, senior-QA quality)

BAD examples (do NOT generate these):
- "Verify login works" (too vague)
- "Verify password works" (no specificity)

GOOD examples:
- "Verify session token invalidation after password reset"
- "Verify concurrent login policy enforcement for same role"
- "Verify failed login throttling after 5 attempts"
- "Verify remember-me session persistence after browser restart"

Return JSON with:
{
  "scenarios": [{ "scenario": string, "coverageType": string, "priority": "P0"|"P1"|"P2"|"P3", "riskArea": string }],
  "testCases": [{
    "title": string,
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

Return ONLY valid JSON.`;

    const resp = await this.callLLM(prompt, 4000);
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

    const prompt = `You are a QA coverage analyst. Analyze the following test scenarios for a requirement and identify COVERAGE GAPS — things that should be tested but are NOT covered.

REQUIREMENT:
Title: ${input.title}
Description: ${input.description}
Feature Type: ${analysis.featureType}
Risk Level: ${analysis.riskLevel}
Workflow: ${analysis.workflowSteps.join(' → ')}
Impacted Modules: ${analysis.impactedModules.join(', ')}${existingCoverage}

CURRENT SCENARIOS:
${scenarios.map((s, i) => `${i + 1}. [${s.coverageType}] ${s.scenario}`).join('\n')}

Identify missing coverage areas. Think about:
- Edge cases around workflows
- Concurrency issues
- Data boundary conditions
- Error recovery paths
- Cross-module interactions
- Security implications
- Performance under load
- Accessibility gaps
- Rollback/undo scenarios

Return JSON array:
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

  /* ---- LLM Call Helper ---- */
  private async callLLM(prompt: string, maxTokens: number): Promise<{ content: string; tokensUsed: number }> {
    const resp = await this.openai.chat.completions.create({
      model: MODEL,
      temperature: 0.3,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: 'You are a senior QA architect and test engineer. Always return valid JSON only — no markdown, no explanation, no code fences.' },
        { role: 'user', content: prompt },
      ],
    });
    const content = resp.choices[0]?.message?.content || '{}';
    const tokensUsed = (resp.usage?.prompt_tokens || 0) + (resp.usage?.completion_tokens || 0);
    return { content, tokensUsed };
  }
}
