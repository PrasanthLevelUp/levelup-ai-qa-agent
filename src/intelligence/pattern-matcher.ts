/**
 * Pattern Recognition Engine (Phase 3 Foundation)
 *
 * Extracts and learns common UI patterns from crawled applications.
 * Builds a knowledge graph that improves selector generation over time.
 *
 * Supported Patterns:
 * - Login forms (username/password combinations)
 * - Navigation menus (sidebar, topbar, breadcrumb)
 * - Data tables (with pagination, sorting)
 * - Search forms
 * - Modal dialogs
 * - Form submissions
 *
 * Phase 3 will add: ML-based pattern scoring, cross-app learning,
 * predictive selector generation.
 */

import { logger } from '../utils/logger';
import { upsertSelectorPattern, findMatchingPatterns, incrementPatternUsage } from '../db/postgres';

const MOD = 'PatternMatcher';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type PatternType =
  | 'login_form'
  | 'navigation'
  | 'data_table'
  | 'search_form'
  | 'modal_dialog'
  | 'dropdown_menu'
  | 'pagination'
  | 'file_upload'
  | 'date_picker'
  | 'accordion'
  | 'tabs'
  | 'toast_notification'
  | 'card_layout'
  | 'sidebar'
  | 'breadcrumb';

export interface DetectedPattern {
  type: PatternType;
  confidence: number;
  selectors: string[];
  elementSignatures: Record<string, any>;
  context: string;
}

export interface PatternMatch {
  patternId: string;
  patternType: PatternType;
  selectors: string[];
  confidence: number;
  usageCount: number;
  successRate: number;
}

/* -------------------------------------------------------------------------- */
/*  Pattern Detection Rules                                                   */
/* -------------------------------------------------------------------------- */

interface PatternRule {
  type: PatternType;
  /** Minimum number of matching signals to trigger */
  minSignals: number;
  detect: (elements: any[], forms: any[], navLinks: any[]) => {
    matched: boolean;
    confidence: number;
    selectors: string[];
    signatures: Record<string, any>;
  };
}

const PATTERN_RULES: PatternRule[] = [
  {
    type: 'login_form',
    minSignals: 2,
    detect: (elements, forms) => {
      const passwordInputs = elements.filter((el: any) =>
        el.attributes?.type === 'password' || el.inputType === 'password',
      );
      const usernameInputs = elements.filter((el: any) =>
        (el.attributes?.type === 'email' || el.attributes?.type === 'text') &&
        /user|email|login|account/i.test(
          `${el.attributes?.name || ''} ${el.attributes?.placeholder || ''} ${el.attributes?.id || ''}`,
        ),
      );
      const submitButtons = elements.filter((el: any) =>
        (el.tagName === 'button' || el.attributes?.type === 'submit') &&
        /log.?in|sign.?in|submit|enter/i.test(el.textContent || ''),
      );

      const matched = passwordInputs.length > 0 && (usernameInputs.length > 0 || submitButtons.length > 0);
      const selectors: string[] = [];

      for (const el of usernameInputs) {
        if (el.attributes?.['data-testid']) selectors.push(`[data-testid="${el.attributes['data-testid']}"]`);
        else if (el.id) selectors.push(`#${el.id}`);
        else if (el.attributes?.name) selectors.push(`input[name="${el.attributes.name}"]`);
      }
      for (const el of passwordInputs) {
        if (el.attributes?.['data-testid']) selectors.push(`[data-testid="${el.attributes['data-testid']}"]`);
        else if (el.id) selectors.push(`#${el.id}`);
        else selectors.push(`input[type="password"]`);
      }
      for (const el of submitButtons) {
        if (el.attributes?.['data-testid']) selectors.push(`[data-testid="${el.attributes['data-testid']}"]`);
        else selectors.push(`button:has-text("${el.textContent?.trim().slice(0, 30)}")`);
      }

      return {
        matched,
        confidence: matched ? 0.90 : 0,
        selectors,
        signatures: {
          hasPassword: passwordInputs.length > 0,
          hasUsername: usernameInputs.length > 0,
          hasSubmit: submitButtons.length > 0,
        },
      };
    },
  },
  {
    type: 'navigation',
    minSignals: 3,
    detect: (elements, _forms, navLinks) => {
      const navElements = elements.filter((el: any) =>
        el.tagName === 'nav' || el.attributes?.role === 'navigation',
      );
      const matched = navLinks.length >= 3 || navElements.length > 0;
      const selectors = navLinks.slice(0, 10).map((link: any) => {
        if (link.selector) return link.selector;
        return `a[href="${link.href}"]`;
      });

      return {
        matched,
        confidence: matched ? Math.min(0.85, 0.5 + navLinks.length * 0.05) : 0,
        selectors,
        signatures: {
          navElementCount: navElements.length,
          linkCount: navLinks.length,
        },
      };
    },
  },
  {
    type: 'data_table',
    minSignals: 1,
    detect: (elements) => {
      const tables = elements.filter((el: any) =>
        el.tagName === 'table' || el.attributes?.role === 'table' || el.attributes?.role === 'grid',
      );
      const matched = tables.length > 0;
      const selectors = tables.map((el: any) => {
        if (el.attributes?.['data-testid']) return `[data-testid="${el.attributes['data-testid']}"]`;
        if (el.id) return `#${el.id}`;
        return 'table';
      });

      return {
        matched,
        confidence: matched ? 0.85 : 0,
        selectors,
        signatures: { tableCount: tables.length },
      };
    },
  },
  {
    type: 'search_form',
    minSignals: 1,
    detect: (elements) => {
      const searchInputs = elements.filter((el: any) =>
        el.attributes?.type === 'search' ||
        /search|query|filter/i.test(
          `${el.attributes?.name || ''} ${el.attributes?.placeholder || ''} ${el.attributes?.['aria-label'] || ''}`,
        ),
      );
      const matched = searchInputs.length > 0;
      const selectors = searchInputs.map((el: any) => {
        if (el.attributes?.['data-testid']) return `[data-testid="${el.attributes['data-testid']}"]`;
        if (el.id) return `#${el.id}`;
        return `input[type="search"]`;
      });

      return {
        matched,
        confidence: matched ? 0.80 : 0,
        selectors,
        signatures: { searchInputCount: searchInputs.length },
      };
    },
  },
  {
    type: 'modal_dialog',
    minSignals: 1,
    detect: (elements) => {
      const dialogs = elements.filter((el: any) =>
        el.tagName === 'dialog' || el.attributes?.role === 'dialog' || el.attributes?.role === 'alertdialog',
      );
      const matched = dialogs.length > 0;
      const selectors = dialogs.map((el: any) => {
        if (el.attributes?.['data-testid']) return `[data-testid="${el.attributes['data-testid']}"]`;
        if (el.id) return `#${el.id}`;
        return `[role="dialog"]`;
      });

      return {
        matched,
        confidence: matched ? 0.80 : 0,
        selectors,
        signatures: { dialogCount: dialogs.length },
      };
    },
  },
];

/* -------------------------------------------------------------------------- */
/*  Engine                                                                    */
/* -------------------------------------------------------------------------- */

export class PatternMatcher {

  /**
   * Detect UI patterns from crawl data.
   */
  detectPatterns(crawlData: any): DetectedPattern[] {
    if (!crawlData) return [];

    const elements: any[] = crawlData.elements || [];
    const forms: any[] = crawlData.forms || [];
    const navLinks: any[] = crawlData.navigationLinks || [];

    const detected: DetectedPattern[] = [];

    for (const rule of PATTERN_RULES) {
      try {
        const result = rule.detect(elements, forms, navLinks);
        if (result.matched && result.confidence > 0.5) {
          detected.push({
            type: rule.type,
            confidence: result.confidence,
            selectors: result.selectors,
            elementSignatures: result.signatures,
            context: `Detected ${rule.type} pattern with ${result.confidence.toFixed(2)} confidence`,
          });
        }
      } catch (err) {
        logger.warn(MOD, `Pattern rule ${rule.type} failed`, { error: (err as Error).message });
      }
    }

    logger.info(MOD, 'Pattern detection complete', {
      elementsAnalyzed: elements.length,
      patternsDetected: detected.length,
      types: detected.map(d => d.type),
    });

    return detected;
  }

  /**
   * Store detected patterns in the database for future use.
   */
  async learnPatterns(crawlData: any, companyId?: number): Promise<number> {
    const detected = this.detectPatterns(crawlData);
    let stored = 0;

    for (const pattern of detected) {
      try {
        await upsertSelectorPattern({
          patternType: pattern.type,
          patternName: `${pattern.type}_auto_${Date.now()}`,
          selectors: pattern.selectors,
          elementSignatures: pattern.elementSignatures,
          confidenceScore: pattern.confidence,
        }, companyId);
        stored++;
      } catch (err) {
        logger.warn(MOD, `Failed to store pattern ${pattern.type}`, { error: (err as Error).message });
      }
    }

    logger.info(MOD, `Learned ${stored}/${detected.length} patterns`);
    return stored;
  }

  /**
   * Find patterns matching a given type from the knowledge database.
   */
  async findPatterns(patternType: PatternType, companyId?: number): Promise<PatternMatch[]> {
    const rows = await findMatchingPatterns(patternType, companyId);
    return rows.map(row => ({
      patternId: row.id,
      patternType: row.pattern_type,
      selectors: typeof row.selectors === 'string' ? JSON.parse(row.selectors) : row.selectors,
      confidence: row.confidence_score,
      usageCount: row.usage_count,
      successRate: row.success_rate,
    }));
  }

  /**
   * Record pattern usage outcome (for learning).
   */
  async recordPatternUsage(patternId: string, success: boolean): Promise<void> {
    await incrementPatternUsage(patternId, success);
  }
}
