/**
 * AI Test Coverage Intelligence Engine
 * Transforms requirements into senior-QA-level test scenarios & cases
 * with business awareness, coverage gap analysis, and automation readiness scoring.
 */

import OpenAI from 'openai';
import { logger } from '../utils/logger';
import { ModelSelector } from '../ai/model-selector';
import { AnthropicClient, resolveAnthropicModel, isAnthropicConfigured } from '../ai/anthropic-client';
import { CostTracker } from '../ai/cost-tracker';
import { KnowledgeOptimizer, type KnowledgeItem as OptimizerKnowledgeItem } from '../ai/knowledge-optimizer';
import {
  IntelligenceOrchestrator,
  getIntelligenceOrchestrator,
  type OrchestratorSource,
  type IntelligenceScore,
} from '../services/intelligence-orchestrator';

const MOD = 'test-coverage-engine';

/**
 * Prompt version identifier — increment when the generation prompt logic changes.
 * Tracked in every generation so we can correlate quality with prompt evolution and
 * quickly diagnose "last week was better" reports by identifying which version ran.
 */
const PROMPT_VERSION = 'v3.2-senior-qa';

/**
 * Engine architecture version — increment when the pipeline or core algorithm changes
 * (e.g. dedup logic, grounding approach, evaluation reconciliation).
 */
const ENGINE_VERSION = 'test-coverage-v2';

/**
 * Adaptive generation tiers. Resource budget is made PROPORTIONAL to the work
 * requested instead of paying the full 8K-token + separate-analysis tax for every
 * requirement. Names are expectation-oriented (FAST/STANDARD/COMPREHENSIVE) — users
 * care about the experience, not the internal heuristic.
 *
 *   FAST          ≈ small requirement   — single generation call, lean budget
 *   STANDARD      ≈ medium requirement  — single generation call, mid budget
 *   COMPREHENSIVE ≈ large requirement / epic — analysis call + generation call, full budget
 *
 * Quality is NOT reduced: the generation prompt is identical across tiers. We only
 * scale the output/prompt token budget and whether the separate analysis round-trip
 * runs. Token caps are env-overridable so thresholds can be tuned from real telemetry.
 */
export type ComplexityTier = 'FAST' | 'STANDARD' | 'COMPREHENSIVE';

interface TierConfig {
  /** Max output tokens requested from the model for the generation call. */
  maxOutputTokens: number;
  /** Max prompt characters before truncation (keeps rich context + JSON schema intact). */
  maxPromptChars: number;
  /** Whether to run the separate LLM requirement-analysis round-trip. Only the
   *  COMPREHENSIVE tier does — FAST/STANDARD derive a heuristic analysis instead,
   *  saving one full network round-trip (~5-6s) for common requirements. */
  runAnalysis: boolean;
}

const intEnv = (name: string, fallback: number): number => {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const TIER_CONFIGS: Record<ComplexityTier, TierConfig> = {
  FAST: {
    maxOutputTokens: intEnv('GEN_FAST_MAX_TOKENS', 2500),
    maxPromptChars: intEnv('GEN_FAST_MAX_PROMPT_CHARS', 24000),
    runAnalysis: false,
  },
  STANDARD: {
    maxOutputTokens: intEnv('GEN_STANDARD_MAX_TOKENS', 5000),
    maxPromptChars: intEnv('GEN_STANDARD_MAX_PROMPT_CHARS', 40000),
    runAnalysis: false,
  },
  COMPREHENSIVE: {
    maxOutputTokens: intEnv('GEN_COMPREHENSIVE_MAX_TOKENS', 8000),
    maxPromptChars: intEnv('GEN_COMPREHENSIVE_MAX_PROMPT_CHARS', 60000),
    runAnalysis: true,
  },
};

/** Complexity scoring weights — env-overridable so they can be tuned from telemetry.
 *  These define how much each signal contributes to the composite complexity score.
 *  Sum should ideally be 1.0 but code normalizes if not. Default weights favor
 *  coverage types + acceptance criteria (the actual work requested) over requirement
 *  length (which may just be verbose prose). */
interface ComplexityWeights {
  requirementChars: number;
  acceptanceCriteria: number;
  coverageTypes: number;
  businessFlow: number;
  intelligenceSources: number;
}

const floatEnv = (name: string, fallback: number): number => {
  const v = parseFloat(process.env[name] || '');
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

const COMPLEXITY_WEIGHTS: ComplexityWeights = {
  requirementChars: floatEnv('GEN_WEIGHT_REQ_CHARS', 0.10),
  acceptanceCriteria: floatEnv('GEN_WEIGHT_AC', 0.40),
  coverageTypes: floatEnv('GEN_WEIGHT_COVERAGE_TYPES', 0.40),
  businessFlow: floatEnv('GEN_WEIGHT_FLOW', 0.05),
  intelligenceSources: floatEnv('GEN_WEIGHT_SOURCES', 0.05),
};

/** Composite score ranges for tier classification — env-overridable. */
const FAST_THRESHOLD = floatEnv('GEN_FAST_THRESHOLD', 25);
const STANDARD_THRESHOLD = floatEnv('GEN_STANDARD_THRESHOLD', 40);

/** Signals used to classify requirement complexity — all cheap to compute, ZERO LLM calls. */
export interface ComplexitySignals {
  requirementChars: number;
  acceptanceCriteriaCount: number;
  businessFlowSteps: number;
  coverageTypeCount: number;
  intelligenceSourceCount: number;
  /** Weighted composite score (0-100) used for tier classification. Recorded for
   *  telemetry so weights + thresholds can be tuned from real data. */
  complexityScore: number;
}

export interface ComplexityEstimate {
  tier: ComplexityTier;
  signals: ComplexitySignals;
  /** Human-readable reason(s) the tier was chosen — surfaced for telemetry/tuning. */
  reason: string;
}

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

/**
 * Semantic meaning of each Coverage Type.
 *
 * The selected Coverage Types are the user's EXPLICIT testing intent, so the
 * model is given the GOAL of each selected type (not just its name). This is the
 * single biggest lever for getting comprehensive, well-organised output: Claude
 * follows an explicit objective far better than a bare label like "negative".
 *
 * `label`     — human title used for the per-type section header in the prompt.
 * `goal`      — what a senior QA engineer is trying to achieve with this type.
 * `lookFor`   — concrete, grounded angles to consider (kept requirement-relative,
 *               never a mandate to invent unsupported functionality).
 *
 * To add a future coverage type, add an entry here following the same pattern.
 */
export const COVERAGE_TYPE_GOALS: Record<CoverageType, { label: string; goal: string; lookFor: string }> = {
  positive: {
    label: 'Positive',
    goal: 'Verify the requirement works correctly for valid inputs and successful, expected user flows.',
    lookFor: 'happy paths, every valid variation of the main flow, alternate valid entry points, successful state transitions, and each distinct valid role/option the requirement supports.',
  },
  negative: {
    label: 'Negative',
    goal: 'Verify the requirement correctly REJECTS invalid input and handles incorrect user behaviour gracefully.',
    lookFor: 'invalid inputs, incorrect user actions, validation failures, business-rule violations, missing required data, wrong credentials/permissions, and clear error handling/messaging for each.',
  },
  edge_cases: {
    label: 'Edge Cases',
    goal: 'Verify the requirement behaves correctly in uncommon, corner and boundary-adjacent situations.',
    lookFor: 'empty values, whitespace (leading/trailing), maximum/long lengths, special characters, unicode/emoji, null/undefined, unusual sequences, repeated/rapid actions, and unexpected-but-possible user behaviour.',
  },
  boundary: {
    label: 'Boundary',
    goal: 'Verify behaviour exactly at, just below, and just above every defined limit.',
    lookFor: 'minimum and maximum values, character/length limits, zero and one, off-by-one (limit ±1), and numeric overflow/underflow for any limit the requirement states or implies.',
  },
  security: {
    label: 'Security',
    goal: 'Verify the requirement is resilient to abuse and unauthorised access.',
    lookFor: 'authentication/authorization bypass, injection (SQL/script), XSS, CSRF, session handling, and exposure of sensitive data — only where the requirement involves such a surface.',
  },
  api: {
    label: 'API',
    goal: 'Verify the API contract behind the requirement behaves correctly.',
    lookFor: 'endpoint contracts, status/response codes, request/response payload validation, required vs optional fields, and error responses for each documented endpoint.',
  },
  ui: {
    label: 'UI',
    goal: 'Verify the user interface for the requirement renders and behaves correctly.',
    lookFor: 'layout, inline form validation, loading/empty/error states, enabled/disabled controls, and visible feedback for user actions.',
  },
  mobile: {
    label: 'Mobile',
    goal: 'Verify the requirement works correctly on mobile form factors.',
    lookFor: 'touch interactions, responsive layout, orientation changes, and on-screen keyboard behaviour relevant to the requirement.',
  },
  accessibility: {
    label: 'Accessibility',
    goal: 'Verify the requirement is usable with assistive technology.',
    lookFor: 'screen-reader labels, keyboard-only navigation, focus order, ARIA roles, and colour-contrast for the elements involved.',
  },
  performance: {
    label: 'Performance',
    goal: 'Verify the requirement performs acceptably under realistic conditions.',
    lookFor: 'response/load time of the main flow, behaviour with large datasets, and concurrent requests where the requirement implies scale.',
  },
  integration: {
    label: 'Integration',
    goal: 'Verify the requirement works correctly end-to-end across modules and dependencies.',
    lookFor: 'cross-module flows, data consistency across steps, and interactions with the dependencies/APIs the requirement names.',
  },
  regression: {
    label: 'Regression',
    goal: 'Verify previously-working behaviour related to the requirement still holds after change.',
    lookFor: 'critical paths impacted by the change and any behaviour the requirement/release notes flag as previously broken.',
  },
  cross_browser: {
    label: 'Cross-Browser',
    goal: 'Verify the requirement renders and behaves consistently across browsers.',
    lookFor: 'rendering and interaction differences across Chrome, Firefox, Safari and Edge for the elements involved.',
  },
  data_validation: {
    label: 'Data Validation',
    goal: 'Verify all input data for the requirement is validated and sanitised correctly.',
    lookFor: 'format validation, type checking, required-field enforcement, input sanitisation, and acceptance of valid formats / rejection of invalid ones.',
  },
  role_based: {
    label: 'Role-Based',
    goal: 'Verify the requirement enforces the correct behaviour per user role/permission.',
    lookFor: 'each role the requirement names, permitted vs denied actions per role, role transitions, and unauthorized-access handling.',
  },
  localization: {
    label: 'Localization',
    goal: 'Verify the requirement works correctly across locales.',
    lookFor: 'language switching, RTL layout, and date/number/currency formatting where the requirement involves localised content.',
  },
};

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
  /**
   * What this scenario sets out to PROVE — the senior-QA "objective" of the
   * scenario, distinct from the title. Enterprise reviewers read the objective
   * first to decide whether the scenario is worth running. Example:
   * "Confirm a standard user with valid credentials reaches the Inventory page
   *  and the session is established." Defaults to the scenario text if omitted.
   */
  objective?: string;
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
  /**
   * The single, specific thing this test case verifies — the case-level
   * objective a senior QA writes before the steps. Sharper than the title and
   * sharper than the scenario objective (which is about the whole scenario).
   * Example: "Reject login when the password is correct but the account status
   * is 'locked', and show the account-locked message." Optional; the UI/export
   * falls back to the title when absent.
   */
  objective?: string;
  preconditions: string;
  steps: string[];
  expectedResult: string;
  testData: string;
  /**
   * The risk this case guards against, expressed in product terms (e.g.
   * "Unauthorized access", "Revenue loss on failed checkout", "Data corruption").
   * Lets reviewers prioritise by business risk, not just by P0/P1. Optional.
   */
  riskArea?: string;
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

/**
 * Per-coverage-type evaluation record. Every Coverage Type the user selected is
 * processed and reported here — so a type is NEVER silently dropped. When a type
 * legitimately yields no grounded tests, `status` is 'not_applicable' and
 * `reason` explains why (e.g. "Requirement defines no numeric limits, so no
 * boundary tests apply"), instead of the UI just showing nothing.
 */
export interface CoverageTypeEvaluation {
  coverageType: string;
  /** 'covered' — produced grounded scenarios/cases; 'not_applicable' — none apply. */
  status: 'covered' | 'not_applicable';
  /** How many scenarios were produced for this type. */
  scenarioCount: number;
  /** How many test cases were produced for this type. */
  testCaseCount: number;
  /** Required when status is 'not_applicable' — why no grounded test was possible. */
  reason?: string;
}

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
  /** Per-selected-type evaluation — proves every Coverage Type was processed. */
  coverageTypeEvaluations: CoverageTypeEvaluation[];
  /** Which mode produced this result. */
  mode: GenerationMode;
  /**
   * Signature transparency metric — how much of this generation was grounded in
   * real intelligence vs produced by the raw model. Present only when the
   * Intelligence Orchestrator ran (flag on + scope provided); undefined on the
   * legacy path. Surfaced to the API + dashboard.
   */
  intelligenceScore?: IntelligenceScore;
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
    /** Size of the generation prompt sent to the model — lets us correlate
     *  prompt size with output volume and cost over time (measure, don't just
     *  keep raising the budget). */
    promptChars?: number;
    /** Generated cases produced per 1,000 prompt chars — a cheap density signal
     *  for "are we getting more output for more context, or just paying more?". */
    casesPerKChars?: number;
    /** Generation versioning + telemetry — tracks which prompt/engine/model/tier
     *  produced this run plus timing & token breakdown, so quality regressions
     *  ("last week was better") can be correlated with code changes AND thresholds
     *  can be tuned from real engineering data instead of assumptions. */
    generationMetadata?: {
      promptVersion: string;
      engineVersion: string;
      model: string;
      timestamp: string;
      /** Adaptive complexity tier selected for this run. */
      complexityTier?: ComplexityTier;
      /** Cheap heuristic signals that drove the tier selection. */
      complexitySignals?: ComplexitySignals;
      /** Why this tier was chosen (for telemetry/tuning). */
      complexityReason?: string;
      /** Wall-clock time spent in the separate analysis LLM call (0 when skipped). */
      analysisMs?: number;
      /** Wall-clock time spent in the generation LLM call (+ dedup/gap as applicable). */
      generationMs?: number;
      /** Total wall-clock time for the full pipeline. */
      totalMs?: number;
      /** Tokens (prompt + completion) for the analysis call (0 when skipped). */
      analysisTokens?: number;
      /** Tokens (prompt + completion) for the generation call. */
      generationTokens?: number;
      /** Total tokens across every LLM call in this run. */
      totalTokens?: number;
      /** Number of scenarios produced. */
      scenarioCount?: number;
      /** Number of committed test cases produced. */
      testCaseCount?: number;
    };
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
  /**
   * Optional scope for intent-scoped retrieval via the shared
   * IntelligenceOrchestrator (Phase 2). When present AND the orchestrator flag
   * is on, generation uses a single orchestrated intelligence block in place of
   * the legacy flat repo / app-profile / test-data blocks (the rich enterprise
   * knowledge block is preserved). Absent / flag-off → legacy behaviour is
   * byte-for-byte unchanged.
   */
  orchestratorScope?: {
    companyId: number;
    projectId?: number;
    repoContextId?: number;
    targetUrl?: string;
  };
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
  // Phase 1 — optional Claude provider for Test Generation. When
  // TEST_PROVIDER=anthropic and a key is configured, callLLM routes to Claude
  // and transparently falls back to OpenAI on ANY error.
  private anthropic: AnthropicClient | null;
  private testProvider: string;
  private testModel: string;

  constructor() {
    const apiKey = process.env['OPENAI_API_KEY'];
    if (!apiKey) throw new Error('OPENAI_API_KEY required for TestCoverageEngine');
    this.openai = new OpenAI({ apiKey });
    this.modelSelector = new ModelSelector();
    this.costTracker = new CostTracker();

    this.testProvider = (process.env['TEST_PROVIDER'] || 'openai').toLowerCase();
    this.testModel = resolveAnthropicModel(process.env['TEST_MODEL']);
    this.anthropic =
      this.testProvider === 'anthropic' && isAnthropicConfigured()
        ? new AnthropicClient({ model: this.testModel })
        : null;
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
  /* ---- Adaptive complexity classification (heuristic, ZERO LLM calls) ---- */
  /**
   * Classify a requirement into FAST / STANDARD / COMPREHENSIVE using cheap,
   * observable signals — never spend model tokens deciding whether to spend model
   * tokens. The budget then becomes proportional to the work requested.
   *
   * Promotion rules (any single "large" trigger wins):
   *   COMPREHENSIVE — requirement > 1500 chars, OR ≥9 acceptance criteria, OR ≥7
   *                   business-flow steps, OR ≥6 coverage types, OR ≥3 intelligence
   *                   sources (rich grounding context deserves the full budget).
   *   FAST          — small on every axis: <500 chars, ≤3 AC, ≤2 flow steps,
   *                   ≤2 coverage types, ≤1 intelligence source.
   *   STANDARD      — everything in between.
   */
  estimateComplexity(
    input: RequirementInput,
    coverageTypes: CoverageType[],
    knowledge?: KnowledgeContext
  ): ComplexityEstimate {
    const countLines = (s?: string): number =>
      (s || '')
        .split(/\r?\n|(?<=[.;])\s+(?=[A-Z0-9])/)
        .map(l => l.trim())
        .filter(l => l.length > 0).length;

    // ---- Raw signal extraction (cheap, zero LLM) ----
    const requirementChars =
      (input.title?.length || 0) +
      (input.description?.length || 0) +
      (input.acceptanceCriteria?.length || 0) +
      (input.businessFlow?.length || 0) +
      (input.apiDocs?.length || 0) +
      (input.releaseNotes?.length || 0);

    const acceptanceCriteriaCount = countLines(input.acceptanceCriteria);
    const businessFlowSteps = countLines(input.businessFlow);
    const coverageTypeCount = coverageTypes.length;
    const intelligenceSourceCount =
      (knowledge?.modules?.length ? 1 : 0) +
      (knowledge?.enterpriseKnowledge?.length ? 1 : 0) +
      (knowledge?.applicationProfile ? 1 : 0) +
      (knowledge?.testData?.length ? 1 : 0) +
      (knowledge?.repositoryContext ? 1 : 0);

    // ---- Weighted scoring: normalize each signal to 0-100, then composite ----
    // Normalization caps chosen so that COMPREHENSIVE-tier complexity hits ~100%.
    // These represent the threshold where a requirement becomes objectively complex:
    //   • requirementChars: 1200 chars ≈ epic-sized text (title + long desc + many AC)
    //   • AC: 8 criteria ≈ detailed/epic requirement
    //   • coverage types: 5 types ≈ comprehensive testing (positive+negative+edge+boundary+security)
    //   • flow steps: 6 steps ≈ multi-step workflow
    //   • sources: 4 ≈ heavy intelligence use (modules + enterprise + profile + testData)
    // With these caps + weights (0.40 coverage, 0.40 AC), a requirement hits
    // COMPREHENSIVE when it requests significant testing work (4-5+ types OR 6+ AC)
    // even if the prose is short. Tune from telemetry after collecting data.
    const charScore = Math.min(100, (requirementChars / 1200) * 100);
    const acScore = Math.min(100, (acceptanceCriteriaCount / 8) * 100);
    const coverageScore = Math.min(100, (coverageTypeCount / 5) * 100);
    const flowScore = Math.min(100, (businessFlowSteps / 6) * 100);
    const sourceScore = Math.min(100, (intelligenceSourceCount / 4) * 100);

    // Weighted composite (env-overridable). Normalize weights to sum=1.0 for stability.
    const w = COMPLEXITY_WEIGHTS;
    const weightSum = w.requirementChars + w.acceptanceCriteria + w.coverageTypes + w.businessFlow + w.intelligenceSources;
    const normalizedWeights = {
      chars: w.requirementChars / weightSum,
      ac: w.acceptanceCriteria / weightSum,
      coverage: w.coverageTypes / weightSum,
      flow: w.businessFlow / weightSum,
      sources: w.intelligenceSources / weightSum,
    };

    const complexityScore =
      charScore * normalizedWeights.chars +
      acScore * normalizedWeights.ac +
      coverageScore * normalizedWeights.coverage +
      flowScore * normalizedWeights.flow +
      sourceScore * normalizedWeights.sources;

    // ---- Tier classification by composite score ----
    let tier: ComplexityTier;
    let reason: string;
    if (complexityScore < FAST_THRESHOLD) {
      tier = 'FAST';
      reason = `Low complexity score ${Math.round(complexityScore)} < ${FAST_THRESHOLD} (${coverageTypeCount} types, ${acceptanceCriteriaCount} AC, ${requirementChars} chars)`;
    } else if (complexityScore < STANDARD_THRESHOLD) {
      tier = 'STANDARD';
      reason = `Medium complexity score ${Math.round(complexityScore)} (${FAST_THRESHOLD}–${STANDARD_THRESHOLD}) — ${coverageTypeCount} types, ${acceptanceCriteriaCount} AC, ${requirementChars} chars`;
    } else {
      tier = 'COMPREHENSIVE';
      reason = `High complexity score ${Math.round(complexityScore)} ≥ ${STANDARD_THRESHOLD} (${coverageTypeCount} types, ${acceptanceCriteriaCount} AC, ${requirementChars} chars)`;
    }

    return {
      tier,
      signals: {
        requirementChars,
        acceptanceCriteriaCount,
        businessFlowSteps,
        coverageTypeCount,
        intelligenceSourceCount,
        complexityScore: Math.round(complexityScore * 10) / 10, // 1 decimal precision for telemetry
      },
      reason,
    };
  }

  /**
   * Derive a RequirementAnalysis WITHOUT an LLM call, for the FAST/STANDARD tiers
   * that skip the separate analysis round-trip. The generation prompt already
   * carries the full requirement text + AC + flow, so a lightweight heuristic
   * analysis is sufficient context — this is the latency saving, not a quality cut.
   */
  private heuristicAnalysis(
    input: RequirementInput,
    estimate: ComplexityEstimate
  ): RequirementAnalysis {
    const hay = `${input.title} ${input.description} ${input.module || ''}`.toLowerCase();
    const featureType =
      /login|auth|password|sign[\s-]?in|credential|lock/.test(hay) ? 'authentication' :
      /pay|checkout|billing|invoice|card|transaction/.test(hay) ? 'payment' :
      /search|filter|query/.test(hay) ? 'search' :
      /report|dashboard|analytic|export/.test(hay) ? 'reporting' :
      /form|input|register|submit|create|edit|update/.test(hay) ? 'data_entry' :
      'general';
    // Risk: critical-sounding domains skew higher even without the analysis call.
    const riskLevel: RequirementAnalysis['riskLevel'] =
      featureType === 'authentication' || featureType === 'payment' ? 'high' : 'medium';

    const workflowSteps = (input.businessFlow || '')
      .split(/\r?\n|(?<=[.;])\s+(?=[A-Z0-9])/)
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 20);

    return {
      featureType,
      riskLevel,
      businessCriticality: 'Derived heuristically (analysis call skipped for this tier)',
      impactedModules: [input.module || 'unknown'],
      userRolesAffected: ['end_user'],
      apiDependencies: [],
      dbImpact: 'Unknown',
      workflowSteps,
      summary: (input.description || input.title || '').slice(0, 200),
    };
  }

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

  /**
   * Derive a short, keyword-friendly intent from the requirement to seed the
   * orchestrator's intent-scoped retrieval. Title + business flow are the
   * strongest signals; falls back to acceptance criteria / description.
   */
  private deriveIntent(input: RequirementInput): string {
    const base =
      [input.title, input.businessFlow].filter(Boolean).join(' ') ||
      input.acceptanceCriteria ||
      input.description ||
      '';
    return base.split(/\s+/).slice(0, 12).join(' ').trim();
  }

  /**
   * Phase 2 — build the intent-scoped orchestrated intelligence block for Test
   * Case generation, mirroring Script Gen's integration. Gathers reuse
   * candidates (repository graph), app-profile structure, project datasets and
   * learned patterns for the requirement's intent, and returns a compact,
   * confidence-annotated block plus the signature Intelligence Score.
   *
   * Knowledge is intentionally NOT requested from the orchestrator here — Test
   * Case Lab already builds a richer, KnowledgeOptimizer-selected enterprise
   * knowledge block which is preserved alongside this block.
   *
   * Fully gated: returns an empty block unless INTELLIGENCE_ORCHESTRATOR is on
   * AND an orchestrator scope (companyId) is provided. Any failure degrades to
   * an empty block so generation is never blocked.
   */
  private async buildOrchestratedIntelligenceBlock(
    input: RequirementInput,
    knowledge?: KnowledgeContext,
  ): Promise<{ block: string; intelligenceScore?: IntelligenceScore }> {
    if (!IntelligenceOrchestrator.isEnabled()) return { block: '' };
    const scope = knowledge?.orchestratorScope;
    if (!scope || scope.companyId == null) return { block: '' };

    const intent = this.deriveIntent(input);
    if (!intent) return { block: '' };

    const sources: OrchestratorSource[] = ['repository', 'appProfile', 'testData', 'patterns'];

    try {
      const orchestrator = getIntelligenceOrchestrator();
      const intel = await orchestrator.gatherIntelligence({
        intent,
        repoContextId: scope.repoContextId,
        companyId: scope.companyId,
        projectId: scope.projectId,
        targetUrl: scope.targetUrl,
        caller: 'test-case-lab',
        sources,
      });

      if (!intel.available) {
        return { block: '', intelligenceScore: intel.metadata.intelligenceScore };
      }

      const promptBlock = orchestrator.buildPromptContext(intel);
      if (!promptBlock || promptBlock.startsWith('(No intelligence')) {
        return { block: '', intelligenceScore: intel.metadata.intelligenceScore };
      }

      logger.info(MOD, 'Injecting orchestrated intelligence into test-case prompt', {
        intent,
        sourcesUsed: intel.metadata.sourcesUsed,
        confidenceScore: intel.metadata.confidenceScore,
        intelligenceScore: intel.metadata.intelligenceScore,
      });

      return {
        block: `\n--- ORCHESTRATED INTELLIGENCE (INTENT-SCOPED) ---\n${promptBlock}\n--- END ORCHESTRATED INTELLIGENCE ---`,
        intelligenceScore: intel.metadata.intelligenceScore,
      };
    } catch (err: any) {
      logger.warn(MOD, 'Orchestrated intelligence failed (non-blocking)', { error: err?.message });
      return { block: '' };
    }
  }

  /* ---- Phase 5: Test Case Generation ---- */
  async generateTestCoverage(
    input: RequirementInput,
    analysis: RequirementAnalysis,
    coverageTypes: CoverageType[],
    knowledge?: KnowledgeContext,
    mode: GenerationMode = 'strict',
    // Adaptive generation: token + prompt budgets scale with requirement
    // complexity. Defaults preserve the pre-adaptive COMPREHENSIVE behavior so
    // existing callers are unaffected. NOTE: only the *budgets* change per tier —
    // the prompt itself is identical across tiers (quality is not reduced).
    maxOutputTokens: number = 8000,
    maxPromptChars: number = 60000
  ): Promise<{
    scenarios: TestScenario[];
    testCases: TestCase[];
    suggestedTestCases: TestCase[];
    missingRequirements: MissingRequirement[];
    coverageTypeEvaluations: CoverageTypeEvaluation[];
    tokensUsed: number;
    /** Size of the generation prompt actually sent — for measurability
     *  (prompt size → output volume → tokens/cost), per the "measure, don't
     *  just keep raising the budget" principle. */
    promptChars: number;
    /** Intelligence Score from the orchestrator (undefined on the legacy path). */
    intelligenceScore?: IntelligenceScore;
  }> {
    // GAP-ANALYSIS (expanded) mode only: auto-expand to a comprehensive baseline so
    // the *suggested additional coverage* (assumption-based) bucket is thorough.
    // In STANDARD mode we keep the requested types — committed coverage is grounded
    // in the requirement AND the provided context (knowledge / profile / test data),
    // not padded with ungrounded assumptions.
    const expand = mode === 'expanded';
    if (expand) {
      const baselineTypes: CoverageType[] = ['positive', 'negative', 'edge_cases', 'boundary', 'integration'];
      coverageTypes = Array.from(new Set([...coverageTypes, ...baselineTypes]));
    } else if (coverageTypes.length === 0) {
      // Standard mode with no explicit types — default to positive (happy path).
      coverageTypes = ['positive'];
    }

    const knowledgeBugs = knowledge?.historicalBugs?.length
      ? `\nHistorical bugs to consider: ${knowledge.historicalBugs.join('; ')}`
      : '';
    const knowledgeTests = knowledge?.existingTestCases?.length
      ? `\nExisting test coverage: ${knowledge.existingTestCases.join('; ')}`
      : '';
    const enterpriseBlock = this.buildEnterpriseKnowledgeBlock(knowledge, input);
    // Phase 2 — intent-scoped orchestrated intelligence. When available, it
    // REPLACES the legacy flat repo / app-profile / test-data blocks (the rich
    // enterprise-knowledge block is always kept). Fully additive: '' when the
    // flag is off or no scope/intelligence is present → legacy blocks are used.
    const orchestrated = await this.buildOrchestratedIntelligenceBlock(input, knowledge);
    const useOrchestrated = orchestrated.block.length > 0;
    const orchestratedBlock = orchestrated.block;
    const repoBlock = useOrchestrated ? '' : this.buildRepoIntelligenceBlock(knowledge);
    const appProfileBlock = useOrchestrated ? '' : this.buildApplicationProfileBlock(knowledge);
    const testDataBlock = useOrchestrated ? '' : this.buildTestDataBlock(knowledge);

    // ── Per-type coverage objectives ──
    // Each SELECTED coverage type is an INDEPENDENT objective with its own goal and
    // the signals to look for. Passing the semantic MEANING (not just the name) is
    // what drives Claude to produce a dedicated, comprehensive section per type
    // instead of collapsing everything into a single positive scenario.
    const coverageObjectives = coverageTypes.map((ct, i) => {
      const g = COVERAGE_TYPE_GOALS[ct];
      if (!g) return `  ${i + 1}. ${ct}  (use coverageType: "${ct}") — generate every grounded scenario and test case this coverage type implies for the requirement.`;
      return `  ${i + 1}. ${g.label}  (use coverageType: "${ct}")\n       Goal: ${g.goal}\n       Look for: ${g.lookFor}`;
    }).join('\n');

    // ── Mode-specific scope guidance ──
    // STANDARD (default): committed coverage grounded in requirement + context
    //   (App Knowledge, App Profile, Test Data). No assumptions.
    // GAP ANALYSIS (expanded): grounded coverage + a separate assumption-based
    //   suggestions bucket + missing-requirement questions.
    const scopeBlock = expand
      ? `GENERATION MODE: GAP ANALYSIS (Coverage Gap Analysis is ON)
  Produce THREE outputs:
    1) "testCases" — GROUNDED coverage (see GROUNDED SCOPE below) derived from the REQUIREMENT and the PROVIDED CONTEXT (App Knowledge, App Profile, Test Data), organised by the coverage objectives below. This is the same committed coverage you would produce in Standard mode.
    2) "suggestedTestCases" — ADDITIONAL, ASSUMPTION-BASED coverage a senior QA would still consider (negative paths, security, edge/boundary, role/permission, concurrency, timeouts) that is NOT grounded in the requirement or context. Keep these OUT of "testCases".
    3) "missingRequirements" — open questions for unstated values/limits/behaviours (see the ASSUMPTIONS rule).`
      : `GENERATION MODE: STANDARD COVERAGE (Coverage Gap Analysis is OFF)
  Produce "testCases" GROUNDED in the REQUIREMENT and the PROVIDED CONTEXT, organised by the coverage objectives below. App Knowledge, App Profile and Test Data are FIRST-CLASS inputs by default — use them to drive AND enrich real, committed test cases (see GROUNDED SCOPE below).
  "suggestedTestCases" MUST be an empty array [] and "missingRequirements" MUST be an empty array [] — assumptions are surfaced only when Gap Analysis is ON.`;

    const prompt = `You are a principal QA engineer with deep product intuition, writing an enterprise-grade test design. Think the way a senior tester actually works: first UNDERSTAND the requirement deeply, enumerate every situation worth testing, and only then organise that thinking into the selected coverage types. Be exhaustive — the client has chosen these coverage types deliberately and expects EACH ONE covered thoroughly. Never stop at the first obvious case, and never let one type (usually positive) crowd out the others.

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
User Roles: ${analysis.userRolesAffected.join(', ')}${knowledgeBugs}${knowledgeTests}${enterpriseBlock}${orchestratedBlock}${repoBlock}${appProfileBlock}${testDataBlock}

${scopeBlock}

COVERAGE OBJECTIVES — the user explicitly selected these. Treat EACH as a separate, independent objective; every one MUST be addressed in the output:
${coverageObjectives}

HOW A SENIOR QA ENGINEER REASONS — follow these phases INTERNALLY before you emit JSON (do NOT output your reasoning, only the final JSON):

  PHASE 1 — EXTRACT TEST OBLIGATIONS from the Acceptance Criteria.
    Do not paste the AC. Decompose each criterion (including Given/When/Then) into its testable parts:
      • Precondition (the state that must exist, e.g. "a locked account exists")
      • Action (what the user/system does, e.g. "submit login")
      • Expected (the observable outcome, e.g. "account-locked message shown")
      • Risk (what breaks if this fails, e.g. "Authentication / unauthorized access")
    Every obligation you extract MUST be verified by at least one test case. Missing an AC obligation is the worst failure mode — do not let it happen.

  PHASE 2 — INFER FLOW SCENARIOS from the Business Flow / Workflow.
    From the flow (e.g. Login → Dashboard → Checkout → Payment) reason beyond the happy path WITHOUT being told to:
      • interrupted flow (user abandons or a step fails midway)
      • resume flow (user returns and continues)
      • session timeout / expiry during the flow
      • navigation (back/forward, deep-link into a later step, refresh)
      • state carried between steps (data from step N still valid at step N+1)
    Include the flow-derived scenarios that are RELEVANT to the requirement and to the selected coverage types.

  PHASE 3 — ENUMERATE, THEN BUCKET (do not generate one bucket at a time).
    First list EVERY distinct situation worth testing that the obligations (Phase 1), the flow (Phase 2), and the provided context imply. THEN assign each situation to the selected coverage type it best belongs to:
      "What scenarios exist? → Which are Positive? → Which are Negative? → Which are Edge? → …"
    This guarantees a situation is never missed just because you were thinking about one bucket at a time.

  PHASE 4 — COVER EVERY SELECTED TYPE EXHAUSTIVELY.
    - Handle each selected coverage type ON ITS OWN. Do NOT merge several types into one scenario, and do NOT collapse the work down to a single happy-path scenario.
    - For each type, emit ALL the distinct grounded scenarios it genuinely implies — one scenario per distinct situation — and the concrete test cases under each. A real requirement normally yields MULTIPLE scenarios and MULTIPLE cases per selected type.
    - There are NO fixed counts and NO upper cap. The client selected these types on purpose — be thorough. Let the requirement + context decide depth, but never pad with reworded repetition or ungrounded guesses.
    - Every scenario MUST set "coverageType" to the exact id of the type it belongs to (e.g. "positive", "negative", "edge_cases"). Group your work by coverage type.
    - Each scenario MUST set "objective": one sentence stating what the scenario PROVES.
    - Each test case MUST set "scenarioIndex" (0-based) to its scenario, plus its own "objective" (the single thing it verifies) and "riskArea" (the product risk it guards against).

EVERY SELECTED TYPE MUST BE EVALUATED — populate "coverageTypeEvaluations":
  - Add exactly one entry per selected coverage type.
  - If the type applies, set status "covered" (you will have produced scenarios/cases for it).
  - If a type honestly does NOT apply to THIS requirement given the available context (e.g. "localization" for a backend-only rule with no localised content), still add an entry with status "not_applicable" and a one-line "reason" explaining why — NEVER silently skip a selected type.

GROUNDED SCOPE — the single most important rule (defines what belongs in "testCases"):
  - A test case belongs in "testCases" if it is GROUNDED in any of the following:
      • the REQUIREMENT (title / description / acceptance criteria / business flow) — explicitly stated or directly implied; OR
      • APP KNOWLEDGE — a documented business rule relevant to this feature (e.g. "accounts lock after 3 failed logins" makes a lockout case GROUNDED, not an assumption); OR
      • APP PROFILE — real pages/forms/elements/selectors of the application; OR
      • TEST DATA — a dataset/scenario RELEVANT to the requirement (use the real records as the case's test data, and cover the scenarios that dataset is meant to exercise).
  - These four are FIRST-CLASS, DEFAULT inputs. Use them to DRIVE and ENRICH committed cases — do not hold back grounded coverage.
  - Being comprehensive does NOT mean inventing: the ONLY thing excluded from "testCases" is an ASSUMPTION — a behaviour/value/limit absent from BOTH the requirement AND all provided context.
  - Guard against irrelevant grounding: an UNRELATED dataset alone (e.g. a "locked_users" set when the requirement and knowledge never mention lockout) is NOT a reason to test that behaviour. Ground in context that is RELEVANT to this requirement.
  - Concrete example: requirement "standard user logs in and reaches Inventory", with a "standard_user" dataset and an App Profile of the login + inventory pages → GROUNDED testCases: successful login (using the real standard_user record), navigation to Inventory, and any login/inventory behaviour the App Knowledge documents. If nothing states lockout/length limits/concurrency, those are ASSUMPTIONS — ${expand ? 'put them in suggestedTestCases / missingRequirements.' : 'OMIT them (they appear only when Gap Analysis is ON).'}
${expand ? `
ASSUMPTIONS → SUGGESTIONS & MISSING REQUIREMENTS (Gap Analysis is ON):
  - Assumption-based test ideas (ungrounded negative/boundary/security/concurrency/permission) go in "suggestedTestCases" with source "gap_analysis" — NEVER in "testCases".
  - If an idea needs you to ASSUME a value/limit not stated anywhere (e.g. username max length, lockout threshold, session timeout), DO NOT invent a test — add a "missingRequirements" entry phrased as a question (e.g. { "question": "What is the maximum username length?", "area": "Input validation", "rationale": "No length limit is stated, so a boundary test cannot be written reliably." }).
  - NEVER emit a test case with source "assumption".` : `
ASSUMPTIONS (Gap Analysis is OFF):
  - Do NOT generate assumption-based cases and do NOT fill "missingRequirements". Both "suggestedTestCases" and "missingRequirements" MUST be []. Staying grounded does NOT mean under-generating — produce every case the requirement + provided context genuinely support.`}

QUALITY STANDARDS — each test case must be enterprise-reusable and carry the full schema:
  - Specific, actionable title (NOT vague like "Verify login works").
  - "objective": the one precise thing this case verifies.
  - "riskArea": the product risk it guards against (e.g. "Unauthorized access", "Revenue loss").
  - Clear preconditions, numbered steps (3-6), precise expected result, realistic test data drawn from AVAILABLE TEST DATA when relevant.
  - Automation fields ("automationReady", "automationComplexity", "selectorAvailability") set honestly.

NO TRIVIAL DUPLICATES:
  - Do NOT emit two cases that verify the SAME behaviour with reworded titles. But distinct situations (different input, role, state, or error) are NOT duplicates — keep them all. Only merge true restatements of one another.

SOURCE TAGGING — every test case (in BOTH buckets) MUST include:
  - "source": one of "requirement" | "knowledge" | "test_data" | "app_profile" | "gap_analysis"
      • "requirement" — directly verifies the stated requirement / acceptance criteria.
      • "knowledge"  — grounded in an APP KNOWLEDGE business rule (a valid committed source by default).
      • "test_data"  — grounded in / using a real dataset or scenario from AVAILABLE TEST DATA (a valid committed source by default).
      • "app_profile"— grounded in the crawled APP PROFILE structure/selectors (a valid committed source by default).
      • "gap_analysis" — ONLY for "suggestedTestCases": assumption-based coverage NOT grounded in the requirement or context.
  - "source" MUST NOT be "assumption" — assumptions go to "missingRequirements" instead.
  - "sourceEvidence": a short phrase naming the exact evidence (e.g. "AC: standard user logs in", "standard_user dataset", "Authentication Rules knowledge").

Return JSON (use [] for empty buckets):
{
  "scenarios": [{ "scenario": string, "objective": string, "coverageType": string, "priority": "P0"|"P1"|"P2"|"P3", "riskArea": string }],
  "testCases": [{
    "title": string, "objective": string, "scenarioIndex": number, "riskArea": string,
    "preconditions": string, "steps": string[],
    "expectedResult": string, "testData": string,
    "priority": "P0"|"P1"|"P2"|"P3", "severity": "critical"|"major"|"minor"|"trivial",
    "tags": string[], "automationReady": boolean,
    "automationComplexity": "low"|"medium"|"high", "selectorAvailability": "high"|"medium"|"low"|"unknown",
    "source": "requirement"|"knowledge"|"test_data"|"app_profile", "sourceEvidence": string
  }],
  "coverageTypeEvaluations": [{ "coverageType": string, "status": "covered"|"not_applicable", "reason": string }],
  "suggestedTestCases": [ /* same shape as a testCase; source "gap_analysis". MUST be [] in Standard mode. */ ],
  "missingRequirements": [{ "question": string, "area": string, "rationale": string }]
}

Return ONLY valid JSON. Address EVERY selected coverage type, organise scenarios by coverageType, and be comprehensive while staying grounded. ${expand ? 'Keep grounded coverage and assumption-based suggestions in SEPARATE buckets.' : 'Use ALL provided context to ground committed coverage; keep suggestedTestCases and missingRequirements empty.'}`;

    // Exhaustive, multi-type coverage with a rich grounding context: request the
    // full output budget and a generous prompt-char budget so neither the input
    // context nor the JSON schema at the end of the prompt is truncated.
    const resp = await this.callLLM(prompt, maxOutputTokens, { complexity: 'complex', maxPromptChars });
    let parsed: {
      scenarios?: TestScenario[];
      testCases?: TestCase[];
      suggestedTestCases?: TestCase[];
      missingRequirements?: MissingRequirement[];
      coverageTypeEvaluations?: CoverageTypeEvaluation[];
    };
    try {
      parsed = JSON.parse(resp.content);
    } catch {
      logger.error(MOD, 'Failed to parse test generation response', { raw: resp.content.slice(0, 300) });
      parsed = { scenarios: [], testCases: [] };
    }

    let scenarios = parsed.scenarios || [];
    let testCases = parsed.testCases || [];
    // Assumptions (suggestions + missing-requirement questions) are surfaced ONLY
    // when Gap Analysis is ON. In Standard mode both buckets are forced empty so
    // committed coverage stays grounded in the requirement + provided context.
    let suggestedTestCases = expand ? (parsed.suggestedTestCases || []) : [];
    const missingRequirements = expand ? (parsed.missingRequirements || []) : [];

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

    // ── Per-type evaluation — guarantees EVERY selected coverage type is accounted
    //    for. We trust the model's "not_applicable" reasons but always reconcile the
    //    counts against what was actually produced, and synthesise any entry the
    //    model forgot so the UI can show "covered (N scenarios / M cases)" or an
    //    explicit "not applicable — <reason>" for each type the user selected.
    const coverageTypeEvaluations = this.buildCoverageTypeEvaluations(
      coverageTypes,
      scenarios,
      testCases,
      parsed.coverageTypeEvaluations
    );

    return { scenarios, testCases, suggestedTestCases, missingRequirements, coverageTypeEvaluations, tokensUsed: resp.tokensUsed, promptChars: prompt.length, intelligenceScore: orchestrated.intelligenceScore };
  }

  /**
   * Reconcile per-coverage-type evaluations. For each SELECTED coverage type we
   * compute how many scenarios/cases were actually produced and merge that with
   * the model's self-reported evaluation. Guarantees one entry per selected type
   * (no silent skips): a type with produced coverage is "covered"; a type with
   * none is "not_applicable" carrying the model's reason when available.
   */
  private buildCoverageTypeEvaluations(
    coverageTypes: CoverageType[],
    scenarios: TestScenario[],
    testCases: TestCase[],
    modelEvaluations?: CoverageTypeEvaluation[]
  ): CoverageTypeEvaluation[] {
    const byType = new Map<string, CoverageTypeEvaluation>();
    (modelEvaluations || []).forEach(ev => {
      if (ev && ev.coverageType) byType.set(ev.coverageType, ev);
    });

    return coverageTypes.map((ct): CoverageTypeEvaluation => {
      // Scenarios tagged with this coverage type, and the cases linked to them.
      const typeScenarioIdx = new Set<number>();
      scenarios.forEach((s, i) => {
        if (s.coverageType === ct) typeScenarioIdx.add(i);
      });
      const scenarioCount = typeScenarioIdx.size;
      const testCaseCount = testCases.filter(tc => {
        const idx = (tc as any).scenarioIndex;
        return typeof idx === 'number' && typeScenarioIdx.has(idx);
      }).length;

      const modelEv = byType.get(ct);
      if (scenarioCount > 0 || testCaseCount > 0) {
        return { coverageType: ct, status: 'covered', scenarioCount, testCaseCount };
      }
      // Nothing produced for this type — surface WHY rather than silently dropping it.
      return {
        coverageType: ct,
        status: 'not_applicable',
        scenarioCount: 0,
        testCaseCount: 0,
        reason:
          modelEv?.reason ||
          (modelEv?.status === 'not_applicable'
            ? 'Not applicable to this requirement given the available context.'
            : 'No grounded scenarios applied for this coverage type given the requirement and provided context.'),
      };
    });
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
    //   • OFF → STANDARD mode: committed coverage GROUNDED in the requirement AND all
    //           provided context (App Knowledge, App Profile, Test Data). No assumptions,
    //           no separate suggestions, no gap call.
    //   • ON  → EXPANDED mode: the same grounded coverage + a separate assumption-based
    //           "suggested additional coverage" bucket + missing-requirement questions +
    //           the non-automatable gap analysis pass.
    // Product rule: context is a first-class default input; assumptions appear only when
    // Gap Analysis is enabled. Callers can still force a mode via options.mode.
    const includeCoverageGaps = options?.includeCoverageGaps !== false;
    const mode: GenerationMode = options?.mode ?? (includeCoverageGaps ? 'expanded' : 'strict');
    logger.info(MOD, 'Starting full coverage generation', { title: input.title, coverageTypes, includeCoverageGaps, mode });

    // Pipeline wall-clock start — used for the end-to-end totalMs telemetry.
    const pipelineStart = Date.now();

    // Adaptive generation: classify the requirement's complexity with a pure
    // HEURISTIC (zero LLM tokens — we never spend a model call to decide how
    // big the budget should be) and route to a FAST / STANDARD / COMPREHENSIVE
    // tier. The tier only scales token + prompt budgets and whether the separate
    // analysis round-trip runs — the generation prompt itself is identical, so
    // quality is preserved.
    const complexity = this.estimateComplexity(input, coverageTypes, knowledge);
    const tierCfg = TIER_CONFIGS[complexity.tier];
    logger.info(MOD, 'Complexity classified', {
      tier: complexity.tier,
      reason: complexity.reason,
      signals: complexity.signals,
      maxOutputTokens: tierCfg.maxOutputTokens,
      maxPromptChars: tierCfg.maxPromptChars,
      runAnalysis: tierCfg.runAnalysis,
    });

    // Phase 2: Analyze requirement.
    // COMPREHENSIVE tier runs the dedicated analysis LLM call; FAST/STANDARD
    // skip it and derive an equivalent analysis heuristically — saving a full
    // Claude round-trip (~2 Claude calls + ~8K tokens) on small requirements.
    const analysisStart = Date.now();
    let analysis: RequirementAnalysis;
    let t1 = 0;
    if (tierCfg.runAnalysis) {
      const analyzed = await this.analyzeRequirement(input, knowledge);
      analysis = analyzed.analysis;
      t1 = analyzed.tokensUsed;
    } else {
      analysis = this.heuristicAnalysis(input, complexity);
    }
    const analysisMs = Date.now() - analysisStart;
    logger.info(MOD, 'Requirement analysis complete', {
      featureType: analysis.featureType, riskLevel: analysis.riskLevel,
      tier: complexity.tier, analyzedViaLLM: tierCfg.runAnalysis, analysisMs,
    });

    // Phase 5: Generate tests (mode-aware — strict vs expanded). Token + prompt
    // budgets come from the selected tier.
    const generationStart = Date.now();
    const gen = await this.generateTestCoverage(
      input, analysis, coverageTypes, knowledge, mode,
      tierCfg.maxOutputTokens, tierCfg.maxPromptChars,
    );
    const generationMs = Date.now() - generationStart;
    const { scenarios, testCases: rawTestCases, missingRequirements, coverageTypeEvaluations, tokensUsed: t2, promptChars, intelligenceScore } = gen;
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
    const result: GenerationResult = {
      requirementAnalysis: analysis,
      scenarios,
      testCases,
      suggestedTestCases,
      missingRequirements,
      coverageGaps: gaps,
      coverageTypeEvaluations,
      mode,
      intelligenceScore,
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
        promptChars,
        casesPerKChars: promptChars > 0
          ? Math.round((testCases.length / promptChars) * 1000 * 100) / 100
          : 0,
        generationMetadata: {
          promptVersion: PROMPT_VERSION,
          engineVersion: ENGINE_VERSION,
          model: this.testModel || 'unknown',
          timestamp: new Date().toISOString(),
          // Adaptive generation telemetry — persisted in the requirement's
          // `analysis` JSONB and surfaced in History. Captured so tier
          // thresholds can be tuned from real data (not guesses).
          complexityTier: complexity.tier,
          complexitySignals: complexity.signals,
          complexityReason: complexity.reason,
          analysisMs,
          generationMs,
          totalMs: Date.now() - pipelineStart,
          analysisTokens: t1,
          generationTokens: t2,
          totalTokens,
          scenarioCount: scenarios.length,
          testCaseCount: testCases.length,
        },
      },
    };
    logger.info(MOD, 'Generation complete', {
      promptVersion: PROMPT_VERSION,
      engineVersion: ENGINE_VERSION,
      model: this.testModel,
      tier: complexity.tier,
      promptChars,
      totalTestCases: testCases.length,
      scenarioCount: scenarios.length,
      tokensUsed: totalTokens,
      analysisTokens: t1,
      generationTokens: t2,
      analysisMs,
      generationMs,
      totalMs: result.stats.generationMetadata!.totalMs,
      casesPerKChars: result.stats.casesPerKChars,
      timestamp: result.stats.generationMetadata!.timestamp,
    });
    return result;
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

      // Scenario-aware survivor tracking. A test case belongs to a scenario
      // (scenarioIndex). We must NEVER remove the last surviving case of a
      // scenario — otherwise that scenario is orphaned ("No test cases linked")
      // and the total case count drops below the scenario count. Cases without a
      // numeric scenarioIndex share a single bucket (-1).
      const scenarioKey = (tc: TestCase): number => {
        const idx = (tc as any).scenarioIndex;
        return typeof idx === 'number' ? idx : -1;
      };
      const survivorsPerScenario = new Map<number, number>();
      for (const tc of testCases) {
        const k = scenarioKey(tc);
        survivorsPerScenario.set(k, (survivorsPerScenario.get(k) || 0) + 1);
      }

      const removedIdx = new Set<number>();
      const tryRemove = (idx: number): boolean => {
        const k = scenarioKey(testCases[idx]);
        // Protect the last surviving case of its scenario.
        if ((survivorsPerScenario.get(k) || 0) <= 1) return false;
        removedIdx.add(idx);
        survivorsPerScenario.set(k, (survivorsPerScenario.get(k) || 0) - 1);
        return true;
      };

      for (let i = 0; i < testCases.length; i++) {
        if (removedIdx.has(i)) continue;
        for (let j = i + 1; j < testCases.length; j++) {
          if (removedIdx.has(j)) continue;
          const sim = cosineSimilarity(vectors[i], vectors[j]);
          if (sim >= threshold) {
            // Drop the weaker of the pair — but only if doing so does not orphan
            // its scenario. If the preferred loser is protected, try the other;
            // if both are last-of-scenario, keep both (distinct coverage).
            const preferredLoser = isStronger(testCases[i], testCases[j]) ? j : i;
            const otherCandidate = preferredLoser === j ? i : j;
            const removed = tryRemove(preferredLoser) || tryRemove(otherCandidate);
            if (removed && removedIdx.has(i)) break; // i is gone — stop comparing it
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
  private async callLLM(
    prompt: string,
    maxTokens: number,
    opts?: { complexity?: 'simple' | 'standard' | 'complex'; maxPromptChars?: number }
  ): Promise<{ content: string; tokensUsed: number }> {
    // Use ModelSelector for intelligent model selection
    const modelConfig = this.modelSelector.selectModel('test_generation', opts?.complexity || 'standard');
    const effectiveMaxTokens = Math.min(maxTokens, modelConfig.maxTokens);

    // Truncate prompt to avoid excessive token usage (token optimization).
    // Callers that build long, structured prompts where the OUTPUT SCHEMA sits at
    // the END (e.g. test generation) pass an explicit, larger budget so the JSON
    // contract is never truncated away — silently dropping it would make the model
    // emit malformed output. Default keeps the historical cost-safety behaviour.
    const maxPromptChars = opts?.maxPromptChars
      ?? parseInt(process.env['MAX_TOKENS_PER_REQUEST'] || '4000', 10) * 4;
    const truncatedPrompt = prompt.length > maxPromptChars
      ? prompt.slice(0, maxPromptChars) + '\n\n[Context truncated for cost optimization]'
      : prompt;

    const systemPrompt = 'You are a senior QA architect and test engineer. Always return valid JSON only — no markdown, no explanation, no code fences.';

    let content = '';
    let tokensUsed = 0;
    let usedModel = modelConfig.model;

    // Provider routing — Claude when TEST_PROVIDER=anthropic + configured;
    // transparent fallback to OpenAI on ANY error so a request never fails
    // because of the new provider.
    let routed = false;
    if (this.anthropic) {
      try {
        const r = await this.anthropic.createChatCompletion({
          model: this.testModel,
          temperature: modelConfig.temperature,
          maxTokens: effectiveMaxTokens,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: truncatedPrompt },
          ],
          jsonMode: true,
        });
        content = r.content || '{}';
        tokensUsed = r.tokensUsed;
        usedModel = r.model;
        routed = true;
      } catch (err) {
        logger.warn(MOD, 'Anthropic test generation failed; falling back to OpenAI', {
          error: (err as Error).message,
        });
      }
    }

    if (!routed) {
      const resp = await this.openai.chat.completions.create({
        model: modelConfig.model,
        temperature: modelConfig.temperature,
        max_tokens: effectiveMaxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: truncatedPrompt },
        ],
      });
      content = resp.choices[0]?.message?.content || '{}';
      tokensUsed = (resp.usage?.prompt_tokens || 0) + (resp.usage?.completion_tokens || 0);
      usedModel = modelConfig.model;
    }

    // Strip markdown code fences that models sometimes wrap around JSON
    content = content.trim();
    if (content.startsWith('```')) {
      content = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    // Track cost (fire-and-forget to avoid blocking). Records the model that
    // actually served the request so cost attribution stays accurate.
    this.costTracker.trackRequest({
      model: usedModel,
      tokensUsed,
      feature: 'test_coverage',
      taskType: 'test_generation',
    }).catch((err) => {
      logger.warn(MOD, 'Cost tracking failed (non-blocking)', { error: (err as Error).message });
    });

    return { content: content.trim(), tokensUsed };
  }
}
