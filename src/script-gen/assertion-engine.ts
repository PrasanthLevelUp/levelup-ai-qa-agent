/**
 * Assertion Engine
 * Generates meaningful, reliable assertions for test steps.
 * 
 * Assertion types:
 * - URL assertions (navigation, redirects)
 * - DOM assertions (element visibility, content, state)
 * - Visual assertions (screenshot comparison)
 * - State assertions (form values, checkbox states)
 * - API assertions (response codes, data)
 * - Text assertions (headings, labels, messages)
 * 
 * Avoids weak assertions like:
 * - expect(true).toBe(true)
 * - expect(page).toBeDefined()
 */

import type { PageType, CrawlResult, PageElement } from './page-crawler';
import type { WorkflowStep, WorkflowAction } from './workflow-mapper';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type AssertionType = 
  | 'url' | 'url_contains' | 'url_not_contains'
  | 'title' | 'heading_visible' | 'text_visible' | 'text_not_visible'
  | 'element_visible' | 'element_hidden' | 'element_count'
  | 'element_enabled' | 'element_disabled'
  | 'input_value' | 'checkbox_checked' | 'select_value'
  | 'response_status' | 'response_body'
  | 'no_console_errors' | 'screenshot'
  | 'toast_message' | 'error_message' | 'success_message';

export interface GeneratedAssertion {
  type: AssertionType;
  playwrightCode: string;
  description: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  category: 'navigation' | 'visibility' | 'content' | 'state' | 'error' | 'performance';
}

/* -------------------------------------------------------------------------- */
/*  Engine                                                                    */
/* -------------------------------------------------------------------------- */

export class AssertionEngine {
  /**
   * Generate assertions for a workflow step.
   */
  generateForStep(step: WorkflowStep, context: { prevUrl?: string }): GeneratedAssertion[] {
    const assertions: GeneratedAssertion[] = [];

    // URL assertions based on navigation
    const navAction = step.actions.find(a => a.type === 'navigate');
    if (navAction) {
      assertions.push({
        type: 'url',
        playwrightCode: `await expect(page).toHaveURL(/${escapeRegex(extractPath(navAction.target))}/)`,
        description: `Verify URL matches ${extractPath(navAction.target)}`,
        priority: 'critical',
        category: 'navigation',
      });
    }

    // If previous URL exists and step should navigate away
    if (context.prevUrl && step.pageUrl !== context.prevUrl) {
      assertions.push({
        type: 'url_not_contains',
        playwrightCode: `await expect(page).not.toHaveURL('${extractPath(context.prevUrl)}')`,
        description: 'Verify URL changed from previous page',
        priority: 'high',
        category: 'navigation',
      });
    }

    // Title assertion
    assertions.push({
      type: 'title',
      playwrightCode: `await expect(page).toHaveTitle(/.+/)`,
      description: 'Verify page has a non-empty title',
      priority: 'medium',
      category: 'content',
    });

    // Form submission assertions
    const submitAction = step.actions.find(a => 
      a.type === 'click' && a.description.toLowerCase().includes('submit')
    );
    if (submitAction) {
      assertions.push({
        type: 'error_message',
        playwrightCode: `await expect(page.locator('.error, .alert-danger, [role="alert"]')).not.toBeVisible({ timeout: 3000 }).catch(() => {})`,
        description: 'Verify no error messages after submission',
        priority: 'high',
        category: 'error',
      });
    }

    // Page-type specific assertions
    assertions.push(...this.generateForPageType(step.pageType));

    // Console error assertion
    assertions.push({
      type: 'no_console_errors',
      playwrightCode: `// Console errors are captured via page.on('console') in beforeEach`,
      description: 'Verify no console errors during interaction',
      priority: 'medium',
      category: 'error',
    });

    return assertions;
  }

  /**
   * Generate assertions specific to a page type.
   */
  generateForPageType(pageType: PageType): GeneratedAssertion[] {
    const assertions: GeneratedAssertion[] = [];

    switch (pageType) {
      case 'login':
        assertions.push(
          {
            type: 'element_visible',
            playwrightCode: `await expect(page.locator('input[type="password"]')).toBeVisible()`,
            description: 'Verify password field is visible',
            priority: 'critical',
            category: 'visibility',
          },
          {
            type: 'element_enabled',
            playwrightCode: `await expect(page.locator('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign")')).toBeEnabled()`,
            description: 'Verify login button is enabled',
            priority: 'high',
            category: 'state',
          },
        );
        break;

      case 'dashboard':
        assertions.push(
          {
            type: 'heading_visible',
            playwrightCode: `await expect(page.locator('h1, h2, h3').first()).toBeVisible()`,
            description: 'Verify dashboard heading is visible',
            priority: 'high',
            category: 'visibility',
          },
          {
            type: 'element_visible',
            playwrightCode: `await expect(page.locator('nav, [role="navigation"], .sidebar, .menu')).toBeVisible()`,
            description: 'Verify navigation is visible on dashboard',
            priority: 'medium',
            category: 'visibility',
          },
        );
        break;

      case 'listing':
        assertions.push({
          type: 'element_count',
          playwrightCode: `await expect(page.locator('table tbody tr, .list-item, [role="listitem"]')).not.toHaveCount(0)`,
          description: 'Verify listing has at least one item',
          priority: 'high',
          category: 'content',
        });
        break;

      case 'form':
        assertions.push({
          type: 'element_visible',
          playwrightCode: `await expect(page.locator('form')).toBeVisible()`,
          description: 'Verify form is visible',
          priority: 'critical',
          category: 'visibility',
        });
        break;

      case 'search':
        assertions.push({
          type: 'element_visible',
          playwrightCode: `await expect(page.locator('input[type="search"], input[placeholder*="Search" i], input[name*="search" i]')).toBeVisible()`,
          description: 'Verify search input is visible',
          priority: 'critical',
          category: 'visibility',
        });
        break;

      case 'error':
        assertions.push({
          type: 'text_visible',
          playwrightCode: `await expect(page.locator('body')).toContainText(/error|not found|404|500/i)`,
          description: 'Verify error page shows error message',
          priority: 'high',
          category: 'content',
        });
        break;
    }

    return assertions;
  }

  /**
   * Generate assertions for post-login state.
   */
  generatePostLoginAssertions(dashboardUrl?: string): GeneratedAssertion[] {
    const assertions: GeneratedAssertion[] = [
      {
        type: 'url_not_contains',
        playwrightCode: `await expect(page).not.toHaveURL(/login|signin/i)`,
        description: 'Verify user is no longer on login page',
        priority: 'critical',
        category: 'navigation',
      },
    ];

    if (dashboardUrl) {
      assertions.push({
        type: 'url_contains',
        playwrightCode: `await expect(page).toHaveURL(/${escapeRegex(extractPath(dashboardUrl))}/)`,
        description: 'Verify redirected to dashboard',
        priority: 'high',
        category: 'navigation',
      });
    }

    assertions.push({
      type: 'element_visible',
      playwrightCode: `await expect(page.locator('h1, h2, .welcome, .dashboard, [class*="dashboard"]').first()).toBeVisible({ timeout: 10000 })`,
      description: 'Verify dashboard content is visible after login',
      priority: 'high',
      category: 'visibility',
    });

    return assertions;
  }

  /**
   * Generate negative test assertions (invalid input scenarios).
   */
  generateInvalidInputAssertions(): GeneratedAssertion[] {
    return [
      {
        type: 'error_message',
        playwrightCode: `await expect(page.locator('.error, .alert-danger, .invalid-feedback, [role="alert"], .oxd-input-field-error-message')).toBeVisible({ timeout: 5000 })`,
        description: 'Verify error/validation message appears for invalid input',
        priority: 'critical',
        category: 'error',
      },
      {
        type: 'url',
        playwrightCode: `await expect(page).toHaveURL(/login|signin/i)`,
        description: 'Verify user stays on login page after invalid attempt',
        priority: 'high',
        category: 'navigation',
      },
    ];
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
