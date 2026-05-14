/**
 * AI Root Cause Analysis (RCA) Engine
 *
 * Analyzes test failures using GPT to produce:
 *  - Root cause (human-readable explanation)
 *  - Classification: app_bug | infra_issue | flaky_test | env_config | data_issue
 *  - Confidence score
 *  - Suggested fix
 *  - Severity: critical | high | medium | low
 *  - Affected component identification
 */

import OpenAI from 'openai';
import { logger } from '../utils/logger';
import type { FailureDetails } from '../core/failure-analyzer';

const MOD = 'rca-engine';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type RCAClassification =
  | 'app_bug'
  | 'infra_issue'
  | 'flaky_test'
  | 'env_config'
  | 'data_issue'
  | 'selector_drift'
  | 'unknown';

export type RCASeverity = 'critical' | 'high' | 'medium' | 'low';

export interface RCAResult {
  rootCause: string;
  classification: RCAClassification;
  severity: RCASeverity;
  confidence: number;
  suggestedFix: string;
  affectedComponent: string;
  isFlaky: boolean;
  flakyReason: string | null;
  summary: string;
  technicalDetails: string;
  tokensUsed: number;
  model: string;
  analysisTimeMs: number;
}

export interface RCAInput {
  failure: FailureDetails;
  jobId?: string;
  healingAttempted: boolean;
  healingSucceeded: boolean;
  healedLocator?: string;
  healingStrategy?: string;
  testFileContent?: string;
}

/* -------------------------------------------------------------------------- */
/*  Engine                                                                    */
/* -------------------------------------------------------------------------- */

export class RCAEngine {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(config?: { apiKey?: string; model?: string }) {
    const apiKey = config?.apiKey || process.env['OPENAI_API_KEY'];
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required for RCA Engine');
    }
    this.client = new OpenAI({ apiKey });
    this.model = config?.model || 'gpt-4o-mini';
  }

  /**
   * Perform AI-powered root cause analysis on a test failure.
   */
  async analyze(input: RCAInput): Promise<RCAResult> {
    const startTime = Date.now();

    logger.info(MOD, 'Starting RCA analysis', {
      testName: input.failure.testName,
      failureType: input.failure.failureType,
      healingAttempted: input.healingAttempted,
    });

    const prompt = this.buildPrompt(input);

    try {
      const completion = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: this.getSystemPrompt(),
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        temperature: 0.2,
        max_tokens: 1500,
        response_format: { type: 'json_object' },
      });

      const content = completion.choices?.[0]?.message?.content || '{}';
      const tokensUsed =
        (completion.usage?.prompt_tokens || 0) +
        (completion.usage?.completion_tokens || 0);

      const parsed = this.parseResponse(content);
      const analysisTimeMs = Date.now() - startTime;

      const result: RCAResult = {
        ...parsed,
        tokensUsed,
        model: this.model,
        analysisTimeMs,
      };

      logger.info(MOD, 'RCA analysis complete', {
        testName: input.failure.testName,
        classification: result.classification,
        severity: result.severity,
        confidence: result.confidence,
        isFlaky: result.isFlaky,
        tokensUsed,
        analysisTimeMs,
      });

      return result;
    } catch (error) {
      const analysisTimeMs = Date.now() - startTime;
      logger.error(MOD, 'RCA analysis failed', {
        testName: input.failure.testName,
        error: (error as Error).message,
      });

      // Return a degraded result rather than throwing
      return this.buildFallbackResult(input, analysisTimeMs);
    }
  }

  /* -------------------------------------------------------------------------- */
  /*  Prompt Construction                                                       */
  /* -------------------------------------------------------------------------- */

  private getSystemPrompt(): string {
    return `You are an expert QA engineer AI that performs Root Cause Analysis (RCA) on test failures.

You analyze Playwright/Selenium test failures and determine:
1. The actual root cause of the failure
2. Whether it's an application bug, infrastructure issue, flaky test, environment config, data issue, or selector drift
3. The severity level
4. A concrete suggested fix
5. Whether the test is flaky (intermittently failing)

You must respond with valid JSON matching this exact schema:
{
  "rootCause": "Clear, concise explanation of why the test failed",
  "classification": "app_bug | infra_issue | flaky_test | env_config | data_issue | selector_drift | unknown",
  "severity": "critical | high | medium | low",
  "confidence": 0.0-1.0,
  "suggestedFix": "Specific actionable fix recommendation",
  "affectedComponent": "Name of the UI component, page, or module affected",
  "isFlaky": true/false,
  "flakyReason": "Why it's flaky, or null",
  "summary": "One-line summary suitable for Slack/Jira",
  "technicalDetails": "Detailed technical explanation for developers"
}

Classification guide:
- selector_drift: Element selectors changed due to UI updates (most common in E2E tests)
- app_bug: Actual application defect causing unexpected behavior
- infra_issue: Network timeouts, server errors, browser crashes, CI environment issues
- flaky_test: Test passes sometimes and fails others due to timing, animations, race conditions
- env_config: Wrong URLs, missing env vars, auth issues, test data problems
- data_issue: Test data missing, stale, or in unexpected state
- unknown: Cannot determine with confidence

Be precise and actionable. Don't be vague.`;
  }

  private buildPrompt(input: RCAInput): string {
    const { failure, healingAttempted, healingSucceeded, healedLocator, healingStrategy } = input;

    let prompt = `## Test Failure Analysis Request

**Test Name:** ${failure.testName}
**Failure Type:** ${failure.failureType}
**URL Under Test:** ${failure.url || 'Unknown'}
**File:** ${failure.filePath}:${failure.lineNumber}

### Error Message
\`\`\`
${failure.errorMessage.slice(0, 800)}
\`\`\`

### Failed Line of Code
\`\`\`typescript
${failure.failedLineCode || 'Not available'}
\`\`\`

### Surrounding Code Context
\`\`\`typescript
${failure.surroundingCode?.slice(0, 600) || 'Not available'}
\`\`\`

### Failed Locator
\`${failure.failedLocator || 'N/A'}\`

### Timing Information
- Is timing-related: ${failure.isTimingIssue ? 'Yes' : 'No'}
`;

    if (healingAttempted) {
      prompt += `\n### Self-Healing Result
- Healing attempted: Yes
- Healing succeeded: ${healingSucceeded ? 'Yes' : 'No'}
`;
      if (healingSucceeded && healedLocator) {
        prompt += `- Healed locator: \`${healedLocator}\`
- Strategy used: ${healingStrategy || 'Unknown'}
`;
      }
    }

    if (input.testFileContent) {
      prompt += `\n### Full Test File
\`\`\`typescript
${input.testFileContent.slice(0, 1500)}
\`\`\`
`;
    }

    prompt += `\nAnalyze this failure and provide your RCA as JSON.`;

    return prompt;
  }

  /* -------------------------------------------------------------------------- */
  /*  Response Parsing                                                          */
  /* -------------------------------------------------------------------------- */

  private parseResponse(content: string): Omit<RCAResult, 'tokensUsed' | 'model' | 'analysisTimeMs'> {
    try {
      const data = JSON.parse(content);

      return {
        rootCause: data.rootCause || 'Unable to determine root cause',
        classification: this.validateClassification(data.classification),
        severity: this.validateSeverity(data.severity),
        confidence: Math.min(1, Math.max(0, parseFloat(data.confidence) || 0.5)),
        suggestedFix: data.suggestedFix || 'Review the test and application code',
        affectedComponent: data.affectedComponent || 'Unknown',
        isFlaky: Boolean(data.isFlaky),
        flakyReason: data.flakyReason || null,
        summary: data.summary || 'Test failure detected',
        technicalDetails: data.technicalDetails || '',
      };
    } catch {
      logger.warn(MOD, 'Failed to parse RCA response, using defaults');
      return {
        rootCause: 'AI analysis returned invalid response',
        classification: 'unknown',
        severity: 'medium',
        confidence: 0.3,
        suggestedFix: 'Manual investigation required',
        affectedComponent: 'Unknown',
        isFlaky: false,
        flakyReason: null,
        summary: 'RCA analysis incomplete — manual review needed',
        technicalDetails: `Raw response: ${content.slice(0, 200)}`,
      };
    }
  }

  private validateClassification(val: string): RCAClassification {
    const valid: RCAClassification[] = [
      'app_bug', 'infra_issue', 'flaky_test', 'env_config',
      'data_issue', 'selector_drift', 'unknown',
    ];
    return valid.includes(val as RCAClassification) ? (val as RCAClassification) : 'unknown';
  }

  private validateSeverity(val: string): RCASeverity {
    const valid: RCASeverity[] = ['critical', 'high', 'medium', 'low'];
    return valid.includes(val as RCASeverity) ? (val as RCASeverity) : 'medium';
  }

  /* -------------------------------------------------------------------------- */
  /*  Fallback (when AI call fails)                                             */
  /* -------------------------------------------------------------------------- */

  private buildFallbackResult(input: RCAInput, analysisTimeMs: number): RCAResult {
    const { failure } = input;

    // Rule-based fallback classification
    let classification: RCAClassification = 'unknown';
    let severity: RCASeverity = 'medium';
    let rootCause = 'Unable to perform AI analysis';
    let suggestedFix = 'Manual investigation required';

    const err = failure.errorMessage.toLowerCase();

    if (err.includes('timeout') && err.includes('locator')) {
      classification = 'selector_drift';
      rootCause = `Locator '${failure.failedLocator}' not found — likely changed after a UI update`;
      suggestedFix = 'Update the selector to match the current DOM structure';
      severity = 'high';
    } else if (err.includes('net::err') || err.includes('econnrefused') || err.includes('503')) {
      classification = 'infra_issue';
      rootCause = 'Application server or network is unreachable';
      suggestedFix = 'Check server health and network connectivity';
      severity = 'critical';
    } else if (err.includes('expect(') || err.includes('tobetruthy') || err.includes('tobevisible')) {
      classification = 'app_bug';
      rootCause = 'Assertion failed — application behavior does not match expected result';
      suggestedFix = 'Verify the application logic and expected test outcomes';
      severity = 'high';
    } else if (failure.isTimingIssue) {
      classification = 'flaky_test';
      rootCause = 'Test failure appears timing-related';
      suggestedFix = 'Add explicit waits or increase timeout values';
      severity = 'medium';
    }

    return {
      rootCause,
      classification,
      severity,
      confidence: 0.45,
      suggestedFix,
      affectedComponent: this.extractComponent(failure),
      isFlaky: classification === 'flaky_test',
      flakyReason: classification === 'flaky_test' ? 'Timing-related failure detected' : null,
      summary: `${classification}: ${rootCause.slice(0, 80)}`,
      technicalDetails: `Fallback analysis — AI call failed. Error: ${failure.errorMessage.slice(0, 300)}`,
      tokensUsed: 0,
      model: 'fallback',
      analysisTimeMs,
    };
  }

  private extractComponent(failure: FailureDetails): string {
    // Extract component name from file path or test name
    const fileName = failure.filePath.split('/').pop()?.replace('.spec.ts', '').replace('.test.ts', '') || '';
    const parts = failure.testName.split(' ');

    // Try to identify the page/component from test name
    const keywords = ['login', 'dashboard', 'checkout', 'profile', 'settings', 'signup', 'register', 'search', 'navigation', 'menu', 'form', 'table', 'modal', 'header', 'footer'];
    for (const kw of keywords) {
      if (failure.testName.toLowerCase().includes(kw) || fileName.toLowerCase().includes(kw)) {
        return kw.charAt(0).toUpperCase() + kw.slice(1) + ' Page';
      }
    }

    return fileName ? fileName.charAt(0).toUpperCase() + fileName.slice(1) : 'Unknown Component';
  }
}
