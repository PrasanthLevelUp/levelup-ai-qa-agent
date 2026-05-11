/**
 * Rule Engine (Level 1)
 * Pure deterministic, zero-AI healing logic.
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

export class RuleEngine {
  generate(failure: FailureDetails): RuleEngineResult {
    const failedLocator = failure.failedLocator || '';
    const locator = failedLocator.trim();
    const suggestions: RuleSuggestion[] = [];

    if (locator.startsWith('#')) {
      const semantic = locator.slice(1).replace(/[-_]+/g, ' ').trim();
      const normalized = semantic.toLowerCase();
      const roleName = normalized.includes('login') || normalized.includes('signin')
        ? 'login|sign in|submit'
        : (normalized.includes('save') ? 'save|submit|update' : 'submit|continue|next');

      suggestions.push(
        {
          newLocator: `page.getByRole('button', { name: /${roleName}/i })`,
          confidence: 0.92,
          reasoning: 'ID selector replaced with semantic button role locator.',
        },
        {
          newLocator: `page.getByText(/${roleName}/i)`,
          confidence: 0.85,
          reasoning: 'ID selector replaced with text locator.',
        },
        {
          newLocator: `page.getByLabel(/${semantic || 'username|password|login'}/i)`,
          confidence: 0.82,
          reasoning: 'ID selector replaced with accessible label locator.',
        },
      );
    }

    if (/input\s*\[\s*name\s*=/.test(locator)) {
      const nameValueMatch = /name\s*=\s*['\"]?([^'\"\]]+)['\"]?/.exec(locator);
      const fieldName = (nameValueMatch?.[1] ?? 'input').replace(/[-_]+/g, ' ');
      suggestions.push(
        {
          newLocator: `page.getByLabel(/${fieldName}/i)`,
          confidence: 0.91,
          reasoning: 'Input[name] migrated to label-first locator.',
        },
        {
          newLocator: `page.getByPlaceholder(/${fieldName}/i)`,
          confidence: 0.86,
          reasoning: 'Input[name] migrated to placeholder locator.',
        },
      );
    }

    if (locator.includes('button') || /click\(/i.test(failure.failedLineCode)) {
      suggestions.push(
        {
          newLocator: `page.getByRole('button', { name: /login|submit|save|continue/i })`,
          confidence: 0.87,
          reasoning: 'Button locator switched to role-based semantic lookup.',
        },
        {
          newLocator: `page.getByText(/login|submit|save|continue/i)`,
          confidence: 0.83,
          reasoning: 'Button locator switched to text lookup.',
        },
      );
    }

    const addExplicitWait = /timeout|timed out|waiting for/i.test(failure.errorMessage);

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
