/**
 * Rule Engine (Level 1)
 * Pure deterministic, zero-AI healing logic with expanded strategies.
 */

import { logger } from '../utils/logger';
import type { FailureDetails } from '../core/failure-analyzer';

const MOD = 'rule-engine';

export interface RuleSuggestion {
  newLocator: string;
  confidence: number;
  reasoning: string;
}

export interface RuleEngineResult {
  suggestions: RuleSuggestion[];
  addExplicitWait: boolean;
}

function dedupeSuggestions(suggestions: RuleSuggestion[]): RuleSuggestion[] {
  const seen = new Set<string>();
  const unique: RuleSuggestion[] = [];
  for (const item of suggestions) {
    if (seen.has(item.newLocator)) continue;
    seen.add(item.newLocator);
    unique.push(item);
  }
  return unique.sort((a, b) => b.confidence - a.confidence);
}

function extractTextHint(locator: string): string {
  // Try to extract meaningful text from locator
  const textMatches = [
    /has-text\(["']([^"']+)["']\)/,
    /text=["']([^"']+)["']/,
    /["']([^"']+)["']/,
  ];
  for (const p of textMatches) {
    const m = p.exec(locator);
    if (m?.[1]) return m[1];
  }
  return '';
}

export class RuleEngine {
  generate(failure: FailureDetails): RuleEngineResult {
    const failedLocator = failure.failedLocator || '';
    const locator = failedLocator.trim();
    const suggestions: RuleSuggestion[] = [];
    const errorMsg = failure.errorMessage?.toLowerCase() ?? '';
    const failedLine = failure.failedLineCode?.toLowerCase() ?? '';

    // === ID Selectors (#id) ===
    if (locator.startsWith('#')) {
      const id = locator.slice(1);
      const semantic = id.replace(/[-_]+/g, ' ').trim();
      const normalized = semantic.toLowerCase();

      // Try getByRole with common roles
      if (/login|signin|sign-in|submit/.test(normalized)) {
        suggestions.push({
          newLocator: `page.getByRole('button', { name: /login|sign in|submit/i })`,
          confidence: 0.93,
          reasoning: 'ID selector → semantic button role for login/submit action.',
        });
      } else if (/save|update|edit/.test(normalized)) {
        suggestions.push({
          newLocator: `page.getByRole('button', { name: /save|update|edit/i })`,
          confidence: 0.92,
          reasoning: 'ID selector → semantic button role for save/update action.',
        });
      } else if (/cancel|close|dismiss/.test(normalized)) {
        suggestions.push({
          newLocator: `page.getByRole('button', { name: /cancel|close|dismiss/i })`,
          confidence: 0.91,
          reasoning: 'ID selector → semantic button role for cancel/close action.',
        });
      }

      // Try getByText
      suggestions.push({
        newLocator: `page.getByText(/${semantic || id}/i)`,
        confidence: 0.85,
        reasoning: 'ID selector → text-based locator.',
      });

      // Try getByLabel
      suggestions.push({
        newLocator: `page.getByLabel(/${semantic || id}/i)`,
        confidence: 0.83,
        reasoning: 'ID selector → accessible label locator.',
      });

      // Try getByTestId
      suggestions.push({
        newLocator: `page.getByTestId('${id}')`,
        confidence: 0.81,
        reasoning: 'ID selector → test ID locator (data-testid).',
      });

      // Try aria-label
      suggestions.push({
        newLocator: `page.locator('[aria-label="${semantic}"]')`,
        confidence: 0.78,
        reasoning: 'ID selector → aria-label attribute selector.',
      });
    }

    // === Class Selectors (.class) ===
    if (locator.startsWith('.') || /^\.[a-zA-Z]/.test(locator)) {
      const className = locator.replace(/^\./, '').replace(/[-_]+/g, ' ').trim();
      const textHint = extractTextHint(locator) || className;

      // Try semantic alternatives
      suggestions.push({
        newLocator: `page.getByRole('button', { name: /${textHint}/i })`,
        confidence: 0.88,
        reasoning: 'Class selector → semantic role locator.',
      });

      suggestions.push({
        newLocator: `page.getByText(/${textHint}/i)`,
        confidence: 0.84,
        reasoning: 'Class selector → text content locator.',
      });

      suggestions.push({
        newLocator: `page.getByLabel(/${textHint}/i)`,
        confidence: 0.82,
        reasoning: 'Class selector → label locator.',
      });
    }

    // === Input Elements (input[name=...]) ===
    if (/input\s*\[\s*name\s*=/.test(locator)) {
      const nameValueMatch = /name\s*=\s*['\"]?([^'\"\]]+)['\"]?/.exec(locator);
      const fieldName = (nameValueMatch?.[1] ?? 'input').replace(/[-_]+/g, ' ');

      // Best: getByLabel
      suggestions.push({
        newLocator: `page.getByLabel(/${fieldName}/i)`,
        confidence: 0.93,
        reasoning: 'Input[name] → label-first locator (best for inputs).',
      });

      // getByPlaceholder
      suggestions.push({
        newLocator: `page.getByPlaceholder(/${fieldName}/i)`,
        confidence: 0.88,
        reasoning: 'Input[name] → placeholder locator.',
      });

      // getByRole('textbox')
      suggestions.push({
        newLocator: `page.getByRole('textbox', { name: /${fieldName}/i })`,
        confidence: 0.86,
        reasoning: 'Input[name] → textbox role locator.',
      });

      // name attribute selector
      suggestions.push({
        newLocator: `page.locator('[name="${nameValueMatch?.[1] || fieldName}"]')`,
        confidence: 0.82,
        reasoning: 'Input[name] → direct name attribute selector.',
      });
    }

    // === Input-related errors (not caught by above) ===
    if (/fill|type|input|textbox|field/.test(failedLine) && suggestions.length === 0) {
      const fieldHints = /username|password|email|search|name|phone|address/i.exec(
        failedLocator + ' ' + failure.errorMessage,
      );
      const hint = fieldHints?.[0] || 'input';

      suggestions.push({
        newLocator: `page.getByLabel(/${hint}/i)`,
        confidence: 0.90,
        reasoning: 'Input element → label locator based on context.',
      });

      suggestions.push({
        newLocator: `page.getByPlaceholder(/${hint}/i)`,
        confidence: 0.86,
        reasoning: 'Input element → placeholder locator.',
      });

      suggestions.push({
        newLocator: `page.getByRole('textbox', { name: /${hint}/i })`,
        confidence: 0.84,
        reasoning: 'Input element → textbox role locator.',
      });
    }

    // === Button Elements ===
    if (locator.includes('button') || /click\(/i.test(failedLine) || /type=['"]submit['"]/.test(locator)) {
      const textHint = extractTextHint(locator);
      const buttonText = textHint || 'login|submit|save|continue';

      // getByRole('button') — best for buttons
      suggestions.push({
        newLocator: `page.getByRole('button', { name: /${buttonText}/i })`,
        confidence: 0.92,
        reasoning: 'Button element → role-based semantic lookup.',
      });

      // getByText
      suggestions.push({
        newLocator: `page.getByText(/${buttonText}/i)`,
        confidence: 0.85,
        reasoning: 'Button element → text-based lookup.',
      });

      // type=submit selector
      suggestions.push({
        newLocator: `page.locator('button[type="submit"]')`,
        confidence: 0.82,
        reasoning: 'Button element → type=submit attribute selector.',
      });
    }

    // === Link Elements ===
    if (/link|anchor|<a[\s>]/.test(locator + ' ' + failedLine)) {
      const linkText = extractTextHint(locator) || 'link';

      suggestions.push({
        newLocator: `page.getByRole('link', { name: /${linkText}/i })`,
        confidence: 0.90,
        reasoning: 'Link element → role-based locator.',
      });

      suggestions.push({
        newLocator: `page.getByText(/${linkText}/i)`,
        confidence: 0.84,
        reasoning: 'Link element → text-based locator.',
      });
    }

    // === Heading Elements ===
    if (/h[1-6]|heading/.test(locator + ' ' + failedLine)) {
      const headingText = extractTextHint(locator) || 'heading';

      suggestions.push({
        newLocator: `page.getByRole('heading', { name: /${headingText}/i })`,
        confidence: 0.91,
        reasoning: 'Heading element → role-based locator.',
      });
    }

    // === XPath Selectors ===
    if (locator.startsWith('//') || locator.startsWith('xpath=')) {
      const textHint = extractTextHint(locator) || 'element';

      suggestions.push({
        newLocator: `page.getByRole('button', { name: /${textHint}/i })`,
        confidence: 0.86,
        reasoning: 'XPath → semantic role locator (XPath is fragile).',
      });

      suggestions.push({
        newLocator: `page.getByText(/${textHint}/i)`,
        confidence: 0.83,
        reasoning: 'XPath → text-based locator.',
      });
    }

    // === Timeout Errors ===
    const addExplicitWait = /timeout|timed out|waiting for/i.test(failure.errorMessage);

    if (addExplicitWait && suggestions.length === 0) {
      // For timeout-only failures, suggest waitForSelector approach
      if (failedLocator) {
        suggestions.push({
          newLocator: failedLocator,
          confidence: 0.85,
          reasoning: 'Timeout error → keeping same locator with explicit wait added.',
        });
      }
    }

    logger.info(MOD, 'Generated deterministic suggestions', {
      testName: failure.testName,
      failedLocator,
      count: suggestions.length,
      addExplicitWait,
    });

    return {
      suggestions: dedupeSuggestions(suggestions),
      addExplicitWait,
    };
  }
}
