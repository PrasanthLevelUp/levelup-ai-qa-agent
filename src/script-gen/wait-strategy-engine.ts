/**
 * Wait Strategy Engine
 * Generates intelligent wait strategies — NEVER uses waitForTimeout.
 * 
 * Supported strategies:
 * - networkidle — Wait for network to be idle
 * - locator_visible — Wait for element to be visible
 * - locator_hidden — Wait for element to disappear (loading spinners)
 * - response_wait — Wait for specific API response
 * - state_based — Wait for page state (load, domcontentloaded)
 * - url_change — Wait for URL to change
 * - navigation — Wait for navigation to complete
 */

import type { WorkflowAction } from './workflow-mapper';
import type { PageType } from './page-crawler';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type WaitType = 
  | 'networkidle' | 'locator_visible' | 'locator_hidden'
  | 'response_wait' | 'state_based' | 'url_change' | 'navigation'
  | 'animation_done' | 'load_state';

export interface WaitStrategy {
  type: WaitType;
  playwrightCode: string;
  description: string;
  timeout: number;              // ms
  isRequired: boolean;          // critical waits vs optional
  insertAfter: 'action' | 'navigation' | 'assertion';
}

/* -------------------------------------------------------------------------- */
/*  Engine                                                                    */
/* -------------------------------------------------------------------------- */

export class WaitStrategyEngine {
  /**
   * Generate appropriate wait strategy for an action.
   */
  getWaitForAction(action: WorkflowAction, pageType: PageType): WaitStrategy[] {
    const waits: WaitStrategy[] = [];

    switch (action.type) {
      case 'navigate':
        waits.push({
          type: 'load_state',
          playwrightCode: `await page.waitForLoadState('domcontentloaded')`,
          description: 'Wait for DOM content to load after navigation',
          timeout: 15000,
          isRequired: true,
          insertAfter: 'navigation',
        });
        // For SPAs, also wait for network idle
        waits.push({
          type: 'networkidle',
          playwrightCode: `await page.waitForLoadState('networkidle').catch(() => {})`,
          description: 'Wait for network to settle (SPA hydration)',
          timeout: 10000,
          isRequired: false,
          insertAfter: 'navigation',
        });
        break;

      case 'click':
        // After clicking submit/login, wait for navigation or response
        if (isSubmitAction(action)) {
          waits.push({
            type: 'navigation',
            playwrightCode: `await Promise.race([\n      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }),\n      page.waitForResponse(resp => resp.status() < 400, { timeout: 10000 }),\n    ]).catch(() => {})`,
            description: 'Wait for navigation or API response after form submission',
            timeout: 10000,
            isRequired: true,
            insertAfter: 'action',
          });
        }
        // After clicking navigation links
        else if (isNavigationAction(action)) {
          waits.push({
            type: 'url_change',
            playwrightCode: `await page.waitForURL(/.*/, { timeout: 10000 })`,
            description: 'Wait for URL to change after clicking link',
            timeout: 10000,
            isRequired: true,
            insertAfter: 'action',
          });
        }
        // General click — wait for any loading indicators to disappear
        else {
          waits.push({
            type: 'locator_hidden',
            playwrightCode: `await page.locator('.loading, .spinner, [class*="loading"], [class*="spinner"]').waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})`,
            description: 'Wait for loading indicators to disappear',
            timeout: 5000,
            isRequired: false,
            insertAfter: 'action',
          });
        }
        break;

      case 'fill':
        // After filling, usually no wait needed unless it triggers auto-search
        if (action.description.toLowerCase().includes('search')) {
          waits.push({
            type: 'networkidle',
            playwrightCode: `await page.waitForLoadState('networkidle').catch(() => {})`,
            description: 'Wait for search results to load',
            timeout: 5000,
            isRequired: false,
            insertAfter: 'action',
          });
        }
        break;

      case 'submit':
        waits.push({
          type: 'navigation',
          playwrightCode: `await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {})`,
          description: 'Wait for page to load after form submission',
          timeout: 10000,
          isRequired: true,
          insertAfter: 'action',
        });
        break;
    }

    // Add page-type specific waits
    waits.push(...this.getPageTypeWaits(pageType));

    return waits;
  }

  /**
   * Generate wait strategy for page-specific loading patterns.
   */
  private getPageTypeWaits(pageType: PageType): WaitStrategy[] {
    switch (pageType) {
      case 'dashboard':
        return [{
          type: 'locator_visible',
          playwrightCode: `await page.locator('h1, h2, .dashboard-title, [class*="dashboard"]').first().waitFor({ state: 'visible', timeout: 10000 })`,
          description: 'Wait for dashboard content to render',
          timeout: 10000,
          isRequired: true,
          insertAfter: 'navigation',
        }];

      case 'listing':
        return [{
          type: 'locator_visible',
          playwrightCode: `await page.locator('table, .list-container, [role="table"], [role="list"]').first().waitFor({ state: 'visible', timeout: 10000 })`,
          description: 'Wait for list/table content to render',
          timeout: 10000,
          isRequired: true,
          insertAfter: 'navigation',
        }];

      default:
        return [];
    }
  }

  /**
   * Generate a wait-for-element strategy.
   */
  waitForElement(selector: string, state: 'visible' | 'hidden' = 'visible', timeout = 10000): WaitStrategy {
    return {
      type: state === 'visible' ? 'locator_visible' : 'locator_hidden',
      playwrightCode: `await page.locator('${selector}').waitFor({ state: '${state}', timeout: ${timeout} })`,
      description: `Wait for element ${selector} to be ${state}`,
      timeout,
      isRequired: true,
      insertAfter: 'action',
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function isSubmitAction(action: WorkflowAction): boolean {
  const desc = action.description.toLowerCase();
  return desc.includes('submit') || desc.includes('login') || desc.includes('sign in') ||
    desc.includes('save') || desc.includes('create') || desc.includes('register');
}

function isNavigationAction(action: WorkflowAction): boolean {
  const desc = action.description.toLowerCase();
  return desc.includes('navigate') || desc.includes('link') || desc.includes('menu');
}
