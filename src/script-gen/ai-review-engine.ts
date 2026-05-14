/**
 * AI Review Engine
 * Reviews generated test scripts for quality issues.
 * 
 * Checks for:
 * - Flaky selectors (CSS class-only, generated IDs, XPath)
 * - Unstable waits (waitForTimeout)
 * - Weak assertions (toBeTruthy without context)
 * - Missing validations
 * - Hardcoded values that should be env vars
 * - Missing error handling
 */

import OpenAI from 'openai';
import { logger } from '../utils/logger';
import type { GeneratedFile, TestPlan } from './script-gen-engine';

const MOD = 'ai-review';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type IssueSeverity = 'critical' | 'warning' | 'info';
export type IssueCategory = 'flaky_selector' | 'unstable_wait' | 'weak_assertion'
  | 'missing_validation' | 'hardcoded_value' | 'missing_error_handling'
  | 'best_practice' | 'maintainability';

export interface ReviewIssue {
  file: string;
  line?: number;
  severity: IssueSeverity;
  category: IssueCategory;
  message: string;
  suggestion: string;
  autoFixable: boolean;
}

export interface ReviewResult {
  issues: ReviewIssue[];
  score: number;              // 0-100, overall quality
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  reviewTimeMs: number;
  tokensUsed: number;
}

/* -------------------------------------------------------------------------- */
/*  Static Rule-Based Review                                                  */
/* -------------------------------------------------------------------------- */

const FLAKY_PATTERNS: { pattern: RegExp; message: string; suggestion: string }[] = [
  {
    pattern: /waitForTimeout\s*\(/,
    message: 'Hard-coded wait detected — tests will be slow and flaky',
    suggestion: 'Use waitForLoadState, waitForSelector, or expect().toBeVisible() instead',
  },
  {
    pattern: /page\.waitForTimeout/,
    message: 'page.waitForTimeout is unreliable',
    suggestion: 'Replace with page.waitForLoadState("networkidle") or element.waitFor()',
  },
  {
    pattern: /\.nth\(\d+\)/,
    message: 'Index-based selector is fragile — breaks if DOM order changes',
    suggestion: 'Use a more specific selector (data-testid, role, label)',
  },
  {
    pattern: /page\.\$\(/,
    message: 'Legacy page.$() API — prefer page.locator() for auto-waiting',
    suggestion: 'Use page.locator() instead of page.$()',
  },
  {
    pattern: /xpath=/i,
    message: 'XPath selector is fragile and breaks with DOM changes',
    suggestion: 'Use CSS selectors, roles, or data-testid instead',
  },
  {
    pattern: /expect\(true\)\.toBe\(true\)/,
    message: 'Empty assertion — provides no actual validation',
    suggestion: 'Add meaningful assertions about page content or state',
  },
  {
    pattern: /toBeDefined\(\)/,
    message: 'Weak assertion — toBeDefined rarely catches real issues',
    suggestion: 'Use specific assertions like toBeVisible(), toHaveText(), toHaveURL()',
  },
  {
    pattern: /\b(admin123|password|123456|test123)\b/i,
    message: 'Hardcoded credential detected',
    suggestion: 'Use process.env variables for credentials',
  },
  {
    pattern: /localhost:\d+/,
    message: 'Hardcoded localhost URL',
    suggestion: 'Use process.env.BASE_URL for configurable URLs',
  },
  {
    pattern: /\.css-[a-zA-Z0-9]+/,
    message: 'CSS-in-JS generated class selector — will break on rebuild',
    suggestion: 'Use data-testid, role, or text-based selectors',
  },
];

/* -------------------------------------------------------------------------- */
/*  Engine                                                                    */
/* -------------------------------------------------------------------------- */

export class AIReviewEngine {
  private readonly openai: OpenAI;
  private readonly model: string;

  constructor(config?: { apiKey?: string; model?: string }) {
    const apiKey = config?.apiKey || process.env['OPENAI_API_KEY'];
    if (!apiKey) throw new Error('OPENAI_API_KEY required for AI review');
    this.openai = new OpenAI({ apiKey });
    this.model = config?.model || 'gpt-4o-mini';
  }

  /**
   * Review generated files for quality issues.
   * Combines static rule-based analysis with AI-powered review.
   */
  async review(files: GeneratedFile[], testPlan?: TestPlan): Promise<ReviewResult> {
    const startTime = Date.now();
    let tokensUsed = 0;

    // Static rule-based review
    const staticIssues = this.staticReview(files);

    // AI-powered review (for test files only)
    let aiIssues: ReviewIssue[] = [];
    const testFiles = files.filter(f => f.type === 'test');
    if (testFiles.length > 0) {
      try {
        const aiResult = await this.aiReview(testFiles);
        aiIssues = aiResult.issues;
        tokensUsed = aiResult.tokensUsed;
      } catch (e) {
        logger.warn(MOD, 'AI review failed, using static review only', { error: (e as Error).message });
      }
    }

    // Merge and deduplicate
    const allIssues = [...staticIssues, ...aiIssues];
    const uniqueIssues = this.deduplicateIssues(allIssues);

    const criticalCount = uniqueIssues.filter(i => i.severity === 'critical').length;
    const warningCount = uniqueIssues.filter(i => i.severity === 'warning').length;
    const infoCount = uniqueIssues.filter(i => i.severity === 'info').length;

    // Score: start at 100, deduct for issues
    let score = 100;
    score -= criticalCount * 15;
    score -= warningCount * 5;
    score -= infoCount * 1;
    score = Math.max(0, Math.min(100, score));

    return {
      issues: uniqueIssues,
      score,
      criticalCount,
      warningCount,
      infoCount,
      reviewTimeMs: Date.now() - startTime,
      tokensUsed,
    };
  }

  /**
   * Static rule-based review.
   */
  private staticReview(files: GeneratedFile[]): ReviewIssue[] {
    const issues: ReviewIssue[] = [];

    for (const file of files) {
      if (file.type !== 'test' && file.type !== 'page-object') continue;

      const lines = file.content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        for (const pattern of FLAKY_PATTERNS) {
          if (pattern.pattern.test(line)) {
            issues.push({
              file: file.path,
              line: i + 1,
              severity: line.includes('waitForTimeout') ? 'critical' : 'warning',
              category: inferCategory(pattern.message),
              message: pattern.message,
              suggestion: pattern.suggestion,
              autoFixable: false,
            });
          }
        }
      }

      // Check for missing assertions in test files
      if (file.type === 'test' && !file.content.includes('expect(')) {
        issues.push({
          file: file.path,
          severity: 'critical',
          category: 'missing_validation',
          message: 'Test file has no assertions (expect() calls)',
          suggestion: 'Add meaningful assertions to validate expected behavior',
          autoFixable: false,
        });
      }

      // Check for missing error handling
      if (file.type === 'test' && !file.content.includes('.catch(') && !file.content.includes('try')) {
        issues.push({
          file: file.path,
          severity: 'info',
          category: 'missing_error_handling',
          message: 'No explicit error handling in test',
          suggestion: 'Consider adding .catch() for non-critical waits or try/catch for setup steps',
          autoFixable: false,
        });
      }
    }

    return issues;
  }

  /**
   * AI-powered deep review.
   */
  private async aiReview(testFiles: GeneratedFile[]): Promise<{ issues: ReviewIssue[]; tokensUsed: number }> {
    const filesContent = testFiles.map(f => `=== ${f.path} ===\n${f.content}`).join('\n\n');

    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'system',
          content: `You are a senior QA engineer reviewing Playwright test scripts.
Find issues and respond with JSON: { "issues": [{ "file": "string", "severity": "critical|warning|info", "category": "string", "message": "string", "suggestion": "string" }] }

Focus on:
1. Flaky selectors that will break easily
2. Missing or weak assertions
3. Hardcoded values that should be configurable
4. Race conditions or timing issues
5. Missing edge case coverage
6. Best practice violations`,
        },
        { role: 'user', content: `Review these test files:\n\n${filesContent.substring(0, 6000)}` },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      max_tokens: 2000,
    });

    const content = response.choices[0]?.message?.content || '{}';
    const parsed = JSON.parse(content);

    return {
      issues: (parsed.issues || []).map((i: any) => ({
        file: i.file || 'unknown',
        severity: i.severity || 'info',
        category: i.category || 'best_practice',
        message: i.message || '',
        suggestion: i.suggestion || '',
        autoFixable: false,
      })),
      tokensUsed: response.usage?.total_tokens || 0,
    };
  }

  private deduplicateIssues(issues: ReviewIssue[]): ReviewIssue[] {
    const seen = new Set<string>();
    return issues.filter(i => {
      const key = `${i.file}:${i.line || ''}:${i.message.substring(0, 50)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

function inferCategory(message: string): IssueCategory {
  if (message.includes('wait')) return 'unstable_wait';
  if (message.includes('selector') || message.includes('fragile')) return 'flaky_selector';
  if (message.includes('assertion') || message.includes('validation')) return 'weak_assertion';
  if (message.includes('hardcoded') || message.includes('credential')) return 'hardcoded_value';
  return 'best_practice';
}
