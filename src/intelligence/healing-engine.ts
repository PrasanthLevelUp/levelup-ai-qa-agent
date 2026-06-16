/**
 * Self-Healing Selector Engine (Phase 2 Foundation)
 *
 * Detects broken selectors and finds alternative selectors using
 * cached application profiles and DOM intelligence.
 *
 * Strategies (ordered by reliability):
 * 1. data-testid match
 * 2. Same text content
 * 3. Similar position in DOM
 * 4. Parent-child relationship match
 * 5. Semantic role match (aria-label, role attributes)
 *
 * Phase 2 will add: live page crawling, ML-based scoring, auto-apply
 */

import { logger } from '../utils/logger';
import { ProfileService } from './profile-service';
import { findMatchingPatterns, incrementPatternUsage, getProfileChanges } from '../db/postgres';
import { findMaintenancePattern, PATTERN_APPLY_THRESHOLD } from '../services/maintenance-pattern-service';
import { findLocatorReplacement, canonicalizeLocator } from '../services/profile-diff-engine';
import {
  healingOutcomeService,
  HealingOutcomeInput,
  CaptureResult,
} from '../services/healing-outcome-service';

const MOD = 'HealingEngine';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface BrokenSelectorResult {
  selector: string;
  isBroken: boolean;
  /** Reason the selector is considered broken */
  reason?: string;
  /** Confidence that the selector is actually broken (0-1) */
  confidence: number;
}

export interface SelectorAlternative {
  selector: string;
  strategy: SelectorStrategy;
  confidence: number;
  reasoning: string;
  /** Pattern ID if matched from pattern database */
  patternId?: string;
  /** Loop 3: id of the learned maintenance_patterns row this came from, so the
   *  caller can report the heal outcome back into the feedback loop. */
  maintenancePatternId?: number;
}

export type SelectorStrategy =
  | 'data-testid'
  | 'text-content'
  | 'aria-label'
  | 'role-match'
  | 'dom-position'
  | 'parent-child'
  | 'css-fallback'
  | 'pattern-match'
  // Loop 3: instant, zero-AI-cost fix from the learned maintenance pattern library.
  | 'maintenance-pattern'
  // App Profile change engine: a versioned crawl diff recorded this exact
  // old→new locator change. Highest-trust, zero-AI fix ("System of Record").
  | 'profile-diff';

export interface HealingAnalysis {
  originalSelector: string;
  broken: boolean;
  alternatives: SelectorAlternative[];
  /** Best alternative (highest confidence) */
  bestAlternative: SelectorAlternative | null;
  analysisTimeMs: number;
}

export interface HealingSuggestion {
  testFile: string;
  lineNumber: number;
  originalSelector: string;
  suggestedSelector: string;
  strategy: SelectorStrategy;
  confidence: number;
  reasoning: string;
}

/* -------------------------------------------------------------------------- */
/*  Engine                                                                    */
/* -------------------------------------------------------------------------- */

export class SelectorHealingEngine {
  private readonly profileService: ProfileService;

  constructor(profileService?: ProfileService) {
    this.profileService = profileService || new ProfileService();
  }

  /**
   * Analyze a selector against the cached DOM to determine if it's broken.
   * Returns alternative selectors ranked by confidence.
   *
   * Phase 2: Will add live page validation via Playwright.
   */
  async analyzeSelector(
    selector: string,
    baseUrl: string,
    companyId?: number,
    projectId?: number,
  ): Promise<HealingAnalysis> {
    const start = Date.now();

    // ── App Profile Change Engine: consult versioned crawl diffs FIRST. ──
    // If a recent crawl recorded that THIS exact locator changed (old→new), we
    // can auto-heal instantly with ZERO AI cost and the highest possible trust,
    // because the App Profile is the platform's System of Record for the DOM.
    // User-requested flow: Broken Locator → Profile Diff → changed? → Auto-Heal.
    const diffAlt = await this.tryProfileDiff(selector, baseUrl, companyId, projectId);
    if (diffAlt) {
      logger.info(MOD, 'Healed from App Profile change engine (no AI cost)', {
        selector, replacement: diffAlt.selector, confidence: diffAlt.confidence,
      });
      return {
        originalSelector: selector,
        broken: true,
        alternatives: [diffAlt],
        bestAlternative: diffAlt,
        analysisTimeMs: Date.now() - start,
      };
    }

    // ── Loop 3: consult the learned maintenance pattern library FIRST. ──
    // If a previous Script Sync / Migration confidently rewrote this exact
    // selector and we trust that pattern (> threshold), we can heal instantly
    // with ZERO AI / DOM-search cost. This is the maintenance → healing loop.
    const patternAlt = await this.tryMaintenancePattern(selector, companyId, projectId);
    if (patternAlt) {
      logger.info(MOD, 'Healed from learned maintenance pattern (no AI cost)', {
        selector, replacement: patternAlt.selector, confidence: patternAlt.confidence,
      });
      return {
        originalSelector: selector,
        broken: true,
        alternatives: [patternAlt],
        bestAlternative: patternAlt,
        analysisTimeMs: Date.now() - start,
      };
    }

    const status = await this.profileService.getProfileStatus(baseUrl, companyId);
    if (!status.profile || status.status === 'not_exists') {
      return {
        originalSelector: selector,
        broken: false,
        alternatives: [],
        bestAlternative: null,
        analysisTimeMs: Date.now() - start,
      };
    }

    const crawlData = typeof status.profile.crawl_data === 'string'
      ? JSON.parse(status.profile.crawl_data)
      : status.profile.crawl_data;

    // Check if selector exists in cached DOM
    const selectorExists = this.selectorExistsInCrawl(selector, crawlData);
    if (selectorExists) {
      return {
        originalSelector: selector,
        broken: false,
        alternatives: [],
        bestAlternative: null,
        analysisTimeMs: Date.now() - start,
      };
    }

    // Selector not found — find alternatives
    logger.info(MOD, 'Selector not found in cached DOM, finding alternatives', {
      selector,
      url: baseUrl,
    });

    const alternatives = await this.findAlternatives(selector, crawlData, companyId);

    return {
      originalSelector: selector,
      broken: true,
      alternatives,
      bestAlternative: alternatives.length > 0 ? alternatives[0] : null,
      analysisTimeMs: Date.now() - start,
    };
  }

  /**
   * Parse a test file and identify potentially broken selectors.
   *
   * Phase 2: Will add full test file parsing with AST analysis.
   */
  async analyzeTestFile(
    testContent: string,
    baseUrl: string,
    companyId?: number,
    projectId?: number,
  ): Promise<HealingSuggestion[]> {
    const selectors = this.extractSelectors(testContent);
    const suggestions: HealingSuggestion[] = [];

    for (const { selector, lineNumber } of selectors) {
      const analysis = await this.analyzeSelector(selector, baseUrl, companyId, projectId);
      if (analysis.broken && analysis.bestAlternative) {
        suggestions.push({
          testFile: '',
          lineNumber,
          originalSelector: selector,
          suggestedSelector: analysis.bestAlternative.selector,
          strategy: analysis.bestAlternative.strategy,
          confidence: analysis.bestAlternative.confidence,
          reasoning: analysis.bestAlternative.reasoning,
        });
      }
    }

    return suggestions;
  }

  /* ── Private Helpers ──────────────────────────────────────────── */

  /**
   * Loop 3: look up a trusted learned replacement for a broken selector in the
   * maintenance pattern library. Returns a ready-to-apply alternative ONLY when
   * a pattern matches with confidence ≥ PATTERN_APPLY_THRESHOLD (> 80%), so we
   * never blindly trust a weak/penalised pattern. Fail-safe: any error → null,
   * and healing falls through to the normal DOM/AI strategies.
   */
  private async tryMaintenancePattern(
    selector: string,
    companyId?: number,
    projectId?: number,
  ): Promise<SelectorAlternative | null> {
    try {
      const pattern = await findMaintenancePattern(selector, { companyId, projectId });
      if (!pattern || pattern.confidence_score < PATTERN_APPLY_THRESHOLD) return null;
      if (!pattern.new_selector || pattern.new_selector === selector) return null;
      return {
        selector: pattern.new_selector,
        strategy: 'maintenance-pattern',
        confidence: Math.min(0.99, pattern.confidence_score),
        reasoning:
          `Learned maintenance pattern (${pattern.source}, seen ${pattern.frequency}×, ` +
          `${pattern.success_count} prior successful heal(s)) — instant fix, no AI cost.`,
        maintenancePatternId: pattern.id,
      };
    } catch (err: any) {
      logger.warn(MOD, `maintenance pattern lookup failed: ${err?.message || err}`);
      return null;
    }
  }

  /**
   * App Profile Change Engine fast-path (Sprint A → Sprint B bridge).
   *
   * The App Profile is the platform's System of Record for the DOM. Whenever a
   * crawl is captured, the orchestrator diffs the new snapshot against the
   * previous one and persists every structured change — including, crucially,
   * `LOCATOR_CHANGED` rows that record the exact `old → new` locator for an
   * element whose identity (tag/type/role/label) stayed the same but whose
   * recommended selector moved.
   *
   * Here we consult those persisted diffs BEFORE any DOM search or AI call: if a
   * recent crawl already proved that this broken locator was replaced by a new
   * one, we can heal instantly with zero AI cost and near-certain confidence.
   * This is the cheap, read-only realisation of the user's requested healing
   * flow — `Broken Locator → Profile Diff → Locator Changed? → YES → Auto-Heal`
   * — and is what lets the platform "reduce AI calls significantly".
   *
   * Fail-safe by construction: any error, or no scope, or no matching change →
   * returns null and healing falls through to the maintenance-pattern / DOM / AI
   * strategies exactly as before. When no diffs are stored yet (e.g. a fresh
   * deployment with only one crawl version) this path is simply inert.
   */
  private async tryProfileDiff(
    selector: string,
    baseUrl: string,
    companyId?: number,
    projectId?: number,
  ): Promise<SelectorAlternative | null> {
    try {
      if (!selector || !baseUrl) return null;
      // Only LOCATOR_CHANGED rows carry an old→new locator mapping that we can
      // safely auto-apply. We scope strictly by company + project so we never
      // leak a replacement learned in another tenant's application.
      const rows = await getProfileChanges({
        baseUrl,
        companyId,
        projectId,
        changeType: 'LOCATOR_CHANGED',
        limit: 500,
      });
      if (!rows || rows.length === 0) return null;

      const changes = rows.map((r) => ({
        type: r.change_type as any,
        old: r.old_value ?? undefined,
        new: r.new_value ?? undefined,
      }));

      const replacement = findLocatorReplacement(changes, selector);
      if (!replacement || replacement === selector) return null;

      return {
        selector: replacement,
        strategy: 'profile-diff',
        confidence: 0.95,
        reasoning:
          'App Profile change engine recorded this exact locator changing in a ' +
          'recent crawl (System of Record). Auto-healed from the persisted ' +
          'old→new diff — instant fix, no AI cost.',
      };
    } catch (err: any) {
      logger.warn(MOD, `profile-diff lookup failed: ${err?.message || err}`);
      return null;
    }
  }

  private selectorExistsInCrawl(selector: string, crawlData: any): boolean {
    if (!crawlData?.elements) return false;

    const elements: any[] = crawlData.elements;
    const sel = selector.toLowerCase();

    // Check for data-testid match
    if (sel.includes('[data-testid=')) {
      const match = sel.match(/\[data-testid=["']?([^"'\]]+)/);
      if (match) {
        return elements.some((el: any) =>
          el.attributes?.['data-testid'] === match[1],
        );
      }
    }

    // Check for #id match
    if (sel.startsWith('#')) {
      const id = sel.slice(1).split(/[\s\[.>+~]/)[0];
      return elements.some((el: any) => el.id === id);
    }

    // Check for text-based Playwright selectors
    if (sel.includes('getbyrole') || sel.includes('getbytext') || sel.includes('getbylabel')) {
      // These are dynamic — can't validate from cached DOM without live page
      // Phase 2 will handle this
      return true; // Assume valid for now
    }

    // Check for class-based selectors
    if (sel.startsWith('.')) {
      const className = sel.slice(1).split(/[\s\[.>+~:#]/)[0];
      return elements.some((el: any) =>
        el.className?.includes(className) || el.attributes?.class?.includes(className),
      );
    }

    // For complex selectors, we can't determine from cached data alone
    return true;
  }

  private async findAlternatives(
    selector: string,
    crawlData: any,
    companyId?: number,
  ): Promise<SelectorAlternative[]> {
    const alternatives: SelectorAlternative[] = [];

    if (!crawlData?.elements) return alternatives;

    const elements: any[] = crawlData.elements;
    const context = this.inferSelectorContext(selector);

    // Strategy 1: data-testid elements
    const testIdElements = elements.filter((el: any) => el.attributes?.['data-testid']);
    for (const el of testIdElements) {
      if (this.elementMatchesContext(el, context)) {
        alternatives.push({
          selector: `[data-testid="${el.attributes['data-testid']}"]`,
          strategy: 'data-testid',
          confidence: 0.95,
          reasoning: `data-testid attribute found for similar element: ${el.attributes['data-testid']}`,
        });
      }
    }

    // Strategy 2: aria-label match
    const ariaElements = elements.filter((el: any) => el.attributes?.['aria-label']);
    for (const el of ariaElements) {
      if (this.elementMatchesContext(el, context)) {
        alternatives.push({
          selector: `getByLabel('${el.attributes['aria-label']}')`,
          strategy: 'aria-label',
          confidence: 0.90,
          reasoning: `aria-label attribute matches context: ${el.attributes['aria-label']}`,
        });
      }
    }

    // Strategy 3: Text content match
    const textElements = elements.filter((el: any) => el.textContent?.trim());
    for (const el of textElements) {
      if (this.elementMatchesContext(el, context) && el.textContent.length < 100) {
        alternatives.push({
          selector: `getByText('${el.textContent.trim().slice(0, 50)}')`,
          strategy: 'text-content',
          confidence: 0.80,
          reasoning: `Text content match: "${el.textContent.trim().slice(0, 30)}"`,
        });
      }
    }

    // Strategy 4: Role match
    const roleElements = elements.filter((el: any) => el.attributes?.role || el.tagName);
    for (const el of roleElements) {
      if (this.elementMatchesContext(el, context)) {
        const role = el.attributes?.role || this.inferRoleFromTag(el.tagName);
        if (role) {
          const name = el.attributes?.['aria-label'] || el.textContent?.trim().slice(0, 30);
          alternatives.push({
            selector: name ? `getByRole('${role}', { name: '${name}' })` : `getByRole('${role}')`,
            strategy: 'role-match',
            confidence: 0.75,
            reasoning: `Role-based selector using ${role}`,
          });
        }
      }
    }

    // Strategy 5: Check pattern database
    if (context.elementType) {
      const patterns = await findMatchingPatterns(context.elementType, companyId);
      for (const pattern of patterns.slice(0, 3)) {
        const patternSelectors = typeof pattern.selectors === 'string'
          ? JSON.parse(pattern.selectors) : pattern.selectors;
        if (Array.isArray(patternSelectors) && patternSelectors.length > 0) {
          alternatives.push({
            selector: patternSelectors[0],
            strategy: 'pattern-match',
            confidence: Math.min(pattern.confidence_score * 0.9, 0.85),
            reasoning: `Matched pattern: ${pattern.pattern_name || pattern.pattern_type} (${pattern.usage_count} uses, ${Math.round(pattern.success_rate * 100)}% success)`,
            patternId: pattern.id,
          });
        }
      }
    }

    // Sort by confidence and deduplicate
    return alternatives
      .sort((a, b) => b.confidence - a.confidence)
      .filter((alt, i, arr) =>
        arr.findIndex(a => a.selector === alt.selector) === i,
      )
      .slice(0, 10);
  }

  private inferSelectorContext(selector: string): { elementType?: string; text?: string; id?: string } {
    const context: any = {};

    if (selector.includes('button') || selector.includes('btn') || selector.includes('submit')) {
      context.elementType = 'login_form';
    }
    if (selector.includes('input') || selector.includes('field') || selector.includes('form')) {
      context.elementType = 'login_form';
    }
    if (selector.includes('nav') || selector.includes('menu') || selector.includes('sidebar')) {
      context.elementType = 'navigation';
    }
    if (selector.includes('table') || selector.includes('grid') || selector.includes('row')) {
      context.elementType = 'data_table';
    }

    const textMatch = selector.match(/text=["']([^"']+)/i);
    if (textMatch) context.text = textMatch[1];

    const idMatch = selector.match(/#([\w-]+)/);
    if (idMatch) context.id = idMatch[1];

    return context;
  }

  private elementMatchesContext(element: any, context: any): boolean {
    if (!context.elementType && !context.text && !context.id) return true;

    if (context.id && element.id === context.id) return true;
    if (context.text && element.textContent?.includes(context.text)) return true;

    return true; // Broad match for now — Phase 2 will add ML scoring
  }

  private inferRoleFromTag(tagName: string): string | null {
    const map: Record<string, string> = {
      button: 'button',
      a: 'link',
      input: 'textbox',
      select: 'combobox',
      textarea: 'textbox',
      table: 'table',
      nav: 'navigation',
      dialog: 'dialog',
      img: 'img',
      h1: 'heading', h2: 'heading', h3: 'heading',
    };
    return map[tagName?.toLowerCase()] || null;
  }

  private extractSelectors(testContent: string): Array<{ selector: string; lineNumber: number }> {
    const selectors: Array<{ selector: string; lineNumber: number }> = [];
    const lines = testContent.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Match page.locator('...'), page.click('...'), etc.
      const matches = line.matchAll(/(?:locator|click|fill|type|check|selectOption|waitForSelector)\s*\(\s*['"]([^'"]+)['"]/g);
      for (const match of matches) {
        selectors.push({ selector: match[1], lineNumber: i + 1 });
      }
      // Match getByRole, getByText, getByLabel patterns
      const pwMatches = line.matchAll(/(?:getByRole|getByText|getByLabel|getByPlaceholder|getByTestId)\s*\(\s*['"]([^'"]+)['"]/g);
      for (const match of pwMatches) {
        selectors.push({ selector: `${match[0].split('(')[0]}('${match[1]}')`, lineNumber: i + 1 });
      }
    }

    return selectors;
  }

  /* ── Sprint B: Healing Outcomes Learning Loop ──────────────────────────── */

  /**
   * Record the outcome of an applied heal so the engine LEARNS from it.
   *
   * This is the write-back half of the user-requested loop:
   *
   *   Heal Applied → Run Result → Pass/Fail → Store Outcome → Update Confidence
   *
   * It is intended to be called by the test runner / orchestrator (or the
   * `POST /healing/outcomes` API) once an applied selector fix has been re-run
   * and we know whether the test passed. It delegates entirely to the
   * {@link HealingOutcomeService}, which appends an immutable outcome row and
   * folds the result into the element's smoothed confidence score.
   *
   * Best-effort and non-blocking by construction: the service never throws, so
   * recording an outcome can never break a heal or a test run. The element
   * identity defaults to the canonicalised original selector when not supplied.
   */
  async recordHealingOutcome(input: HealingOutcomeInput): Promise<CaptureResult> {
    return healingOutcomeService.captureHealingOutcome(input);
  }

  /**
   * Look up the learned confidence (0–100) for a selector's element, so callers
   * can rank or gate fix suggestions by how well past heals of this element have
   * actually held up. Returns the neutral default (50) when nothing is learned
   * yet. Strictly tenant-scoped; never throws.
   */
  async getLearnedConfidence(
    selector: string,
    companyId?: number,
    projectId?: number,
    locatorType?: string,
  ): Promise<number> {
    const elementId = canonicalizeLocator(selector) || selector;
    return healingOutcomeService.getConfidenceScore(elementId, companyId, projectId, locatorType ?? '');
  }

  /**
   * Re-rank a list of candidate alternatives using the per-element confidence
   * the platform has LEARNED from prior heal outcomes. Each alternative's static
   * confidence is blended with the learned success score for its target element
   * (70% static / 30% learned) so strategies that have repeatedly healed this
   * element successfully float to the top, while ones that historically broke
   * sink. When nothing has been learned yet (neutral 50), ordering is unchanged.
   *
   * Pure-ish and best-effort: a lookup failure leaves the original order intact.
   */
  async rankAlternativesByLearnedConfidence(
    alternatives: SelectorAlternative[],
    companyId?: number,
    projectId?: number,
  ): Promise<SelectorAlternative[]> {
    if (!alternatives || alternatives.length <= 1) return alternatives;
    try {
      const scored = await Promise.all(
        alternatives.map(async (alt) => {
          const learned = await this.getLearnedConfidence(alt.selector, companyId, projectId);
          // learned is 0–100; static confidence is 0–1. Blend on the 0–1 scale.
          const blended = 0.7 * alt.confidence + 0.3 * (learned / 100);
          return { alt, blended };
        }),
      );
      scored.sort((a, b) => b.blended - a.blended);
      return scored.map((s) => s.alt);
    } catch (err: any) {
      logger.warn(MOD, `rankAlternativesByLearnedConfidence failed: ${err?.message || err}`);
      return alternatives;
    }
  }
}
