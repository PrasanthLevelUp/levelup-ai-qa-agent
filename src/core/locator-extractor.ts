/**
 * Locator Extractor — parses failed locator from error messages.
 * Identifies locator type, element context, and returns structured info.
 */

import { logger } from '../utils/logger';

const MOD = 'locator-extractor';

export type LocatorType = 'css' | 'xpath' | 'role' | 'text' | 'label' | 'placeholder' | 'testid' | 'unknown';
export type ElementContext = 'button' | 'input' | 'link' | 'select' | 'checkbox' | 'radio' | 'heading' | 'generic';

export interface LocatorInfo {
  rawLocator: string;
  locatorType: LocatorType;
  elementContext: ElementContext;
  selectorValue: string;
  isSemanticLocator: boolean;
}

const LOCATOR_PATTERNS = [
  { pattern: /locator\('([^']+)'\)/, group: 1 },
  { pattern: /waiting for locator\('([^']+)'\)/, group: 1 },
  // With page. prefix (from test code)
  { pattern: /page\.getByRole\(([^)]+)\)/, group: 0 },
  { pattern: /page\.getByText\(([^)]+)\)/, group: 0 },
  { pattern: /page\.getByLabel\(([^)]+)\)/, group: 0 },
  { pattern: /page\.getByPlaceholder\(([^)]+)\)/, group: 0 },
  { pattern: /page\.getByTestId\(([^)]+)\)/, group: 0 },
  // Without page. prefix (Playwright error "waiting for getByRole(...)")
  // Use group:1 to capture just the getByRole(...) part, prefix adds "page."
  { pattern: /(?:waiting for\s+)(getByRole\([^)]+\))/m, group: 1, prefix: 'page.' },
  { pattern: /(?:waiting for\s+)(getByText\([^)]+\))/m, group: 1, prefix: 'page.' },
  { pattern: /(?:waiting for\s+)(getByLabel\([^)]+\))/m, group: 1, prefix: 'page.' },
  { pattern: /(?:waiting for\s+)(getByPlaceholder\([^)]+\))/m, group: 1, prefix: 'page.' },
  { pattern: /(?:waiting for\s+)(getByTestId\([^)]+\))/m, group: 1, prefix: 'page.' },
  { pattern: /page\.(?:click|fill|locator)\(([^)]+)\)/, group: 1 },
  { pattern: /selector[:\s]+['"]([^'"]+)['"]/, group: 1 },
];

function detectLocatorType(locator: string): LocatorType {
  if (/getByRole/.test(locator)) return 'role';
  if (/getByText/.test(locator)) return 'text';
  if (/getByLabel/.test(locator)) return 'label';
  if (/getByPlaceholder/.test(locator)) return 'placeholder';
  if (/getByTestId/.test(locator)) return 'testid';
  if (/^\/\//.test(locator) || /xpath/.test(locator)) return 'xpath';
  return 'css';
}

function detectElementContext(locator: string, errorMessage: string): ElementContext {
  const combined = (locator + ' ' + errorMessage).toLowerCase();
  if (/button|submit|btn/.test(combined)) return 'button';
  if (/input|textbox|field|username|password|email/.test(combined)) return 'input';
  if (/link|anchor|href/.test(combined)) return 'link';
  if (/select|dropdown|combobox/.test(combined)) return 'select';
  if (/checkbox/.test(combined)) return 'checkbox';
  if (/radio/.test(combined)) return 'radio';
  if (/heading|h[1-6]/.test(combined)) return 'heading';
  return 'generic';
}

export function extractLocator(errorMessage: string): LocatorInfo | null {
  for (const entry of LOCATOR_PATTERNS) {
    const { pattern, group } = entry;
    const prefix = (entry as any).prefix || '';
    const match = pattern.exec(errorMessage);
    if (match) {
      const rawMatch = (match[group] || match[1] || '').replace(/^['"]|['"]$/g, '').trim();
      const rawLocator = prefix ? prefix + rawMatch : rawMatch;
      const locatorType = detectLocatorType(rawLocator);

      const info: LocatorInfo = {
        rawLocator,
        locatorType,
        elementContext: detectElementContext(rawLocator, errorMessage),
        selectorValue: rawLocator,
        isSemanticLocator: ['role', 'text', 'label', 'placeholder', 'testid'].includes(locatorType),
      };

      logger.debug(MOD, 'Locator extracted', {
        rawLocator: info.rawLocator,
        locatorType: info.locatorType,
        elementContext: info.elementContext,
      });

      return info;
    }
  }

  logger.debug(MOD, 'No locator found in error message');
  return null;
}
