/**
 * Workflow Mapper Engine
 * Builds navigation graphs and multi-page workflow understanding.
 * 
 * Capabilities:
 * - Detect user flows: login → dashboard → create → search → delete
 * - Build navigation graph from crawl results
 * - Identify critical paths (happy path, error paths)
 * - Detect CRUD operations
 * - Map page transitions and form submissions
 */

import type { CrawlResult, NavigationLink, FormInfo, PageType } from './page-crawler';
import { logger } from '../utils/logger';

const MOD = 'workflow-mapper';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface WorkflowNode {
  id: string;
  url: string;
  pageType: PageType;
  title: string;
  actions: WorkflowAction[];
  transitions: WorkflowTransition[];
}

export interface WorkflowAction {
  type: 'fill' | 'click' | 'select' | 'upload' | 'navigate' | 'submit' | 'assert' | 'hover';
  target: string;         // best selector or description
  value?: string;          // for fill actions
  description: string;
  elementTag?: string;
  elementType?: string;
}

export interface WorkflowTransition {
  fromPage: string;
  toPage: string;
  trigger: string;        // what causes the transition
  linkText?: string;
  method?: string;        // GET, POST
}

export interface WorkflowFlow {
  name: string;           // e.g., "Login Flow", "Create Employee"
  description: string;
  flowType: FlowType;
  steps: WorkflowStep[];
  priority: number;       // 1 = highest
}

export interface WorkflowStep {
  pageUrl: string;
  pageType: PageType;
  actions: WorkflowAction[];
  expectedOutcome: string;
  assertions: string[];
}

export type FlowType = 
  | 'authentication' | 'crud_create' | 'crud_read' | 'crud_update' | 'crud_delete'
  | 'search' | 'navigation' | 'form_submission' | 'checkout'
  | 'profile_management' | 'smoke' | 'error_handling';

export interface WorkflowMap {
  nodes: WorkflowNode[];
  flows: WorkflowFlow[];
  entryPoint: string;
  criticalPaths: WorkflowFlow[];
  totalFlows: number;
}

/* -------------------------------------------------------------------------- */
/*  Flow Detection Patterns                                                   */
/* -------------------------------------------------------------------------- */

interface FlowPattern {
  name: string;
  flowType: FlowType;
  priority: number;
  detect: (pages: CrawlResult[]) => WorkflowFlow | null;
}

const FLOW_PATTERNS: FlowPattern[] = [
  {
    name: 'Authentication Flow',
    flowType: 'authentication',
    priority: 1,
    detect: (pages) => {
      const loginPage = pages.find(p => p.pageType === 'login');
      if (!loginPage) return null;

      const passwordInput = loginPage.inputs.find(i => i.type === 'password');
      const usernameInput = loginPage.inputs.find(i => 
        ['text', 'email', undefined].includes(i.type) && 
        !['search', 'q'].some(k => (i.name || '').toLowerCase().includes(k))
      );
      const submitBtn = loginPage.buttons.find(b => 
        b.textContent.toLowerCase().includes('login') ||
        b.textContent.toLowerCase().includes('sign in') ||
        b.type === 'submit'
      );

      if (!passwordInput || !usernameInput) return null;

      const dashboardPage = pages.find(p => p.pageType === 'dashboard');
      const steps: WorkflowStep[] = [];

      // Step 1: Navigate to login
      steps.push({
        pageUrl: loginPage.url,
        pageType: 'login',
        actions: [
          { type: 'navigate', target: loginPage.url, description: 'Navigate to login page' },
        ],
        expectedOutcome: 'Login page loads with username and password fields',
        assertions: ['URL contains login path', 'Username field is visible', 'Password field is visible'],
      });

      // Step 2: Fill credentials and submit
      steps.push({
        pageUrl: loginPage.url,
        pageType: 'login',
        actions: [
          {
            type: 'fill',
            target: buildSelectorDescription(usernameInput),
            value: '{{USERNAME}}',
            description: 'Enter username',
            elementTag: usernameInput.tag,
            elementType: usernameInput.type,
          },
          {
            type: 'fill',
            target: buildSelectorDescription(passwordInput),
            value: '{{PASSWORD}}',
            description: 'Enter password',
            elementTag: passwordInput.tag,
            elementType: passwordInput.type,
          },
          {
            type: 'click',
            target: submitBtn ? buildSelectorDescription(submitBtn) : 'Submit button',
            description: 'Click login/submit button',
            elementTag: submitBtn?.tag,
          },
        ],
        expectedOutcome: 'User is redirected to dashboard/home page',
        assertions: ['URL changes from login', 'Dashboard elements are visible', 'No error messages shown'],
      });

      // Step 3: Verify dashboard (if found)
      if (dashboardPage) {
        steps.push({
          pageUrl: dashboardPage.url,
          pageType: 'dashboard',
          actions: [
            { type: 'assert', target: 'Dashboard page', description: 'Verify dashboard loaded' },
          ],
          expectedOutcome: 'Dashboard is displayed with expected content',
          assertions: ['Dashboard heading is visible', 'Navigation menu is present'],
        });
      }

      return {
        name: 'Login Authentication',
        description: 'Test user login with valid credentials and verify dashboard access',
        flowType: 'authentication',
        steps,
        priority: 1,
      };
    },
  },
  {
    name: 'Search Flow',
    flowType: 'search',
    priority: 3,
    detect: (pages) => {
      const searchPage = pages.find(p => {
        return p.inputs.some(i => 
          i.type === 'search' || 
          (i.placeholder || '').toLowerCase().includes('search') ||
          (i.name || '').toLowerCase().includes('search') ||
          (i.ariaLabel || '').toLowerCase().includes('search')
        );
      });
      if (!searchPage) return null;

      const searchInput = searchPage.inputs.find(i => 
        i.type === 'search' || 
        (i.placeholder || '').toLowerCase().includes('search') ||
        (i.name || '').toLowerCase().includes('search')
      );
      if (!searchInput) return null;

      const searchButton = searchPage.buttons.find(b =>
        b.textContent.toLowerCase().includes('search') ||
        b.ariaLabel?.toLowerCase().includes('search')
      );

      return {
        name: 'Search Functionality',
        description: 'Test search feature with various queries',
        flowType: 'search',
        steps: [
          {
            pageUrl: searchPage.url,
            pageType: searchPage.pageType,
            actions: [
              { type: 'navigate', target: searchPage.url, description: 'Navigate to page with search' },
              {
                type: 'fill',
                target: buildSelectorDescription(searchInput),
                value: '{{SEARCH_QUERY}}',
                description: 'Enter search query',
              },
              ...(searchButton ? [{
                type: 'click' as const,
                target: buildSelectorDescription(searchButton),
                description: 'Click search button',
              }] : [{
                type: 'click' as const,
                target: 'Enter key',
                description: 'Press Enter to search',
              }]),
            ],
            expectedOutcome: 'Search results are displayed',
            assertions: ['Results container is visible', 'At least one result appears or no-results message shown'],
          },
        ],
        priority: 3,
      };
    },
  },
  {
    name: 'Form Submission Flow',
    flowType: 'form_submission',
    priority: 4,
    detect: (pages) => {
      const formPage = pages.find(p => 
        p.forms.length > 0 && p.pageType !== 'login' && p.pageType !== 'signup' &&
        p.forms.some(f => f.fields.length >= 2)
      );
      if (!formPage) return null;

      const form = formPage.forms.find(f => f.fields.length >= 2)!;
      const actions: WorkflowAction[] = [
        { type: 'navigate', target: formPage.url, description: 'Navigate to form page' },
      ];

      for (const field of form.fields) {
        if (field.tag === 'input' || field.tag === 'textarea') {
          actions.push({
            type: 'fill',
            target: buildSelectorDescription(field),
            value: `{{${(field.name || field.id || 'FIELD').toUpperCase()}}}`,
            description: `Fill ${field.nearbyLabel || field.placeholder || field.name || 'field'}`,
            elementTag: field.tag,
            elementType: field.type,
          });
        } else if (field.tag === 'select') {
          actions.push({
            type: 'select',
            target: buildSelectorDescription(field),
            value: '{{OPTION}}',
            description: `Select ${field.nearbyLabel || field.name || 'option'}`,
          });
        }
      }

      if (form.submitButton) {
        actions.push({
          type: 'click',
          target: buildSelectorDescription(form.submitButton),
          description: 'Submit form',
        });
      }

      return {
        name: `Form: ${formPage.title || 'Form Submission'}`,
        description: `Test form submission on ${formPage.url}`,
        flowType: 'form_submission',
        steps: [{
          pageUrl: formPage.url,
          pageType: formPage.pageType,
          actions,
          expectedOutcome: 'Form is submitted successfully',
          assertions: ['Success message or redirect', 'No validation errors', 'Form data saved'],
        }],
        priority: 4,
      };
    },
  },
  {
    name: 'Smoke Test',
    flowType: 'smoke',
    priority: 2,
    detect: (pages) => {
      if (pages.length === 0) return null;
      const mainPage = pages[0]!;

      return {
        name: 'Smoke Test',
        description: 'Verify page loads, key elements are visible, no console errors',
        flowType: 'smoke',
        steps: [{
          pageUrl: mainPage.url,
          pageType: mainPage.pageType,
          actions: [
            { type: 'navigate', target: mainPage.url, description: 'Navigate to main page' },
            { type: 'assert', target: 'Page title', description: 'Verify page title is present' },
          ],
          expectedOutcome: 'Page loads successfully with expected content',
          assertions: [
            'Page title is not empty',
            'No console errors',
            'Main heading is visible',
            `Page type detected: ${mainPage.pageType}`,
            ...(mainPage.headings.length > 0 ? [`Heading: "${mainPage.headings[0]!.text}"`] : []),
          ],
        }],
        priority: 2,
      };
    },
  },
  {
    name: 'Navigation Flow',
    flowType: 'navigation',
    priority: 5,
    detect: (pages) => {
      if (pages.length === 0) return null;
      const mainPage = pages[0]!;
      const internalLinks = mainPage.navigationLinks.filter(l => l.isInternal).slice(0, 5);

      if (internalLinks.length < 2) return null;

      const steps: WorkflowStep[] = [{
        pageUrl: mainPage.url,
        pageType: mainPage.pageType,
        actions: [
          { type: 'navigate', target: mainPage.url, description: 'Navigate to main page' },
        ],
        expectedOutcome: 'Main page loads',
        assertions: ['Page loads successfully'],
      }];

      for (const link of internalLinks) {
        steps.push({
          pageUrl: link.href,
          pageType: 'unknown',
          actions: [
            {
              type: 'click',
              target: `link: "${link.text}"`,
              description: `Click navigation link: ${link.text}`,
            },
            { type: 'assert', target: link.href, description: `Verify navigated to ${link.href}` },
          ],
          expectedOutcome: `Page ${link.text} loads correctly`,
          assertions: [`URL matches ${link.href}`, 'Page content loads', 'No 404 error'],
        });
      }

      return {
        name: 'Navigation Links',
        description: 'Verify all main navigation links work correctly',
        flowType: 'navigation',
        steps,
        priority: 5,
      };
    },
  },
];

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

import type { PageElement } from './page-crawler';

function buildSelectorDescription(el: PageElement): string {
  // Priority: data-testid > role > label > placeholder > name > id > CSS
  if (el.dataTestId) return `[data-testid="${el.dataTestId}"]`;
  if (el.role && el.textContent) return `role=${el.role}[name="${el.textContent.slice(0, 50)}"]`;
  if (el.ariaLabel) return `[aria-label="${el.ariaLabel}"]`;
  if (el.nearbyLabel) return `label: "${el.nearbyLabel}"`;
  if (el.placeholder) return `placeholder: "${el.placeholder}"`;
  if (el.name) return `[name="${el.name}"]`;
  if (el.id) return `#${el.id}`;
  if (el.textContent && (el.tag === 'button' || el.tag === 'a')) {
    return `text="${el.textContent.slice(0, 60)}"`;
  }
  return `${el.tag}${el.className ? '.' + el.className.split(' ')[0] : ''}`;
}

/* -------------------------------------------------------------------------- */
/*  Workflow Mapper Class                                                     */
/* -------------------------------------------------------------------------- */

export class WorkflowMapper {
  /**
   * Build a complete workflow map from crawl results.
   */
  buildWorkflowMap(pages: CrawlResult[]): WorkflowMap {
    logger.info(MOD, 'Building workflow map', { pages: pages.length });

    // Build nodes
    const nodes: WorkflowNode[] = pages.map(page => this.buildNode(page));

    // Detect flows
    const flows: WorkflowFlow[] = [];
    for (const pattern of FLOW_PATTERNS) {
      try {
        const flow = pattern.detect(pages);
        if (flow) {
          flows.push(flow);
          logger.info(MOD, 'Flow detected', { name: flow.name, type: flow.flowType });
        }
      } catch (e) {
        logger.warn(MOD, 'Flow detection failed', { pattern: pattern.name, error: (e as Error).message });
      }
    }

    // Sort by priority
    flows.sort((a, b) => a.priority - b.priority);

    // Critical paths = top 3 highest priority flows
    const criticalPaths = flows.slice(0, 3);

    return {
      nodes,
      flows,
      entryPoint: pages[0]?.url || '',
      criticalPaths,
      totalFlows: flows.length,
    };
  }

  private buildNode(page: CrawlResult): WorkflowNode {
    const actions: WorkflowAction[] = [];

    // Generate actions for each interactive element
    for (const input of page.inputs.filter(i => i.visible)) {
      actions.push({
        type: input.tag === 'select' ? 'select' : 'fill',
        target: buildSelectorDescription(input),
        description: `Fill ${input.nearbyLabel || input.placeholder || input.name || 'input'}`,
        elementTag: input.tag,
        elementType: input.type,
      });
    }

    for (const btn of page.buttons.filter(b => b.visible)) {
      actions.push({
        type: 'click',
        target: buildSelectorDescription(btn),
        description: `Click ${btn.textContent || btn.ariaLabel || 'button'}`,
        elementTag: btn.tag,
      });
    }

    // Transitions from navigation links
    const transitions: WorkflowTransition[] = page.navigationLinks
      .filter(l => l.isInternal)
      .slice(0, 20)
      .map(l => ({
        fromPage: page.url,
        toPage: l.href,
        trigger: `Click link: ${l.text}`,
        linkText: l.text,
        method: 'GET',
      }));

    return {
      id: page.url,
      url: page.url,
      pageType: page.pageType,
      title: page.title,
      actions,
      transitions,
    };
  }
}
