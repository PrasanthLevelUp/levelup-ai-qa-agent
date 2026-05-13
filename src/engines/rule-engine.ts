/**
 * Rule Engine v2 (Level 1)
 * Pure deterministic, zero-AI healing with 30+ strategies.
 * Covers: IDs, classes, inputs, buttons, links, headings, data attributes,
 * ARIA attributes, forms, XPath, dynamic IDs, shadow DOM, iframes, SVG, etc.
 */

import { logger } from '../utils/logger';
import type { FailureDetails } from '../core/failure-analyzer';

const MOD = 'rule-engine';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface RuleSuggestion {
  newLocator: string;
  confidence: number;
  reasoning: string;
  ruleId: string;
}

export interface RuleEngineResult {
  suggestions: RuleSuggestion[];
  addExplicitWait: boolean;
  rulesApplied: string[];
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

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
  const textMatches = [
    /has-text\(["']([^"']+)["']\)/,
    /text=["']([^"']+)["']/,
    /contains\(\s*(?:text\(\)|\.)\s*,\s*["']([^"']+)["']\)/,
    /["']([^"']{2,30})["']/,
  ];
  for (const p of textMatches) {
    const m = p.exec(locator);
    if (m?.[1]) return m[1];
  }
  return '';
}

function extractValue(attrStr: string): string {
  const m = /=\s*["']?([^"'\]]+)["']?/.exec(attrStr);
  return m?.[1] ?? '';
}

function extractDataAttribute(locator: string): { name: string; value: string } {
  const m = /\[data-([a-zA-Z0-9-]+)\s*=\s*["']?([^"'\]]+)["']?\]/.exec(locator);
  return m ? { name: `data-${m[1]}`, value: m[2] } : { name: '', value: '' };
}

function isDynamicId(id: string): boolean {
  // IDs ending with digits, GUIDs, or containing timestamps
  return /[-_]\d{2,}$/.test(id) ||
    /[0-9a-f]{8}-[0-9a-f]{4}-/.test(id) ||
    /\d{10,}/.test(id);
}

function humanize(str: string): string {
  return str.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
}

/* -------------------------------------------------------------------------- */
/*  Rule Engine                                                               */
/* -------------------------------------------------------------------------- */

export class RuleEngine {
  generate(failure: FailureDetails): RuleEngineResult {
    const failedLocator = failure.failedLocator || '';
    const locator = failedLocator.trim();
    const suggestions: RuleSuggestion[] = [];
    const rulesApplied: string[] = [];
    const errorMsg = failure.errorMessage?.toLowerCase() ?? '';
    const failedLine = failure.failedLineCode?.toLowerCase() ?? '';
    const surrounding = failure.surroundingCode?.toLowerCase() ?? '';

    /* ================================================================== */
    /*  RULE 1-5: ID Selectors (#id)                                      */
    /* ================================================================== */
    if (locator.startsWith('#')) {
      const id = locator.slice(1);
      const semantic = humanize(id);
      const normalized = semantic.toLowerCase();

      // Rule 1: Dynamic ID detection
      if (isDynamicId(id)) {
        rulesApplied.push('R01_dynamic_id');
        suggestions.push({
          newLocator: `page.getByTestId('${id.replace(/[-_]?\d+$/, '')}')`,
          confidence: 0.80,
          reasoning: 'Dynamic ID detected — using testId without numeric suffix.',
          ruleId: 'R01',
        });
      }

      // Rule 2: Login/submit button by ID
      if (/login|signin|sign-in|submit/.test(normalized)) {
        rulesApplied.push('R02_id_login_button');
        suggestions.push({
          newLocator: `page.getByRole('button', { name: /login|sign in|submit/i })`,
          confidence: 0.93,
          reasoning: 'ID selector → semantic button role for login/submit.',
          ruleId: 'R02',
        });
      }

      // Rule 3: Save/update button by ID
      if (/save|update|edit|apply/.test(normalized)) {
        rulesApplied.push('R03_id_save_button');
        suggestions.push({
          newLocator: `page.getByRole('button', { name: /save|update|edit|apply/i })`,
          confidence: 0.92,
          reasoning: 'ID selector → semantic button role for save/update.',
          ruleId: 'R03',
        });
      }

      // Rule 4: Cancel/close by ID
      if (/cancel|close|dismiss|back/.test(normalized)) {
        rulesApplied.push('R04_id_cancel_button');
        suggestions.push({
          newLocator: `page.getByRole('button', { name: /cancel|close|dismiss|back/i })`,
          confidence: 0.91,
          reasoning: 'ID selector → semantic button role for cancel/close.',
          ruleId: 'R04',
        });
      }

      // Rule 5: Generic ID fallbacks
      rulesApplied.push('R05_id_generic');
      suggestions.push({
        newLocator: `page.getByText(/${semantic || id}/i)`,
        confidence: 0.85,
        reasoning: 'ID selector → text-based locator.',
        ruleId: 'R05a',
      });
      suggestions.push({
        newLocator: `page.getByLabel(/${semantic || id}/i)`,
        confidence: 0.83,
        reasoning: 'ID selector → accessible label locator.',
        ruleId: 'R05b',
      });
      suggestions.push({
        newLocator: `page.getByTestId('${id}')`,
        confidence: 0.81,
        reasoning: 'ID selector → test ID locator (data-testid).',
        ruleId: 'R05c',
      });
    }

    /* ================================================================== */
    /*  RULE 6-8: Class Selectors (.class)                                */
    /* ================================================================== */
    if (locator.startsWith('.') || /^\.[a-zA-Z]/.test(locator)) {
      const className = locator.replace(/^\./, '').replace(/[-_]+/g, ' ').trim();
      const textHint = extractTextHint(locator) || className;
      rulesApplied.push('R06_class_selector');

      // Rule 6: Class → role button
      suggestions.push({
        newLocator: `page.getByRole('button', { name: /${textHint}/i })`,
        confidence: 0.88,
        reasoning: 'Class selector → semantic role locator.',
        ruleId: 'R06',
      });

      // Rule 7: Class → text
      suggestions.push({
        newLocator: `page.getByText(/${textHint}/i)`,
        confidence: 0.84,
        reasoning: 'Class selector → text content locator.',
        ruleId: 'R07',
      });

      // Rule 8: Class → label
      suggestions.push({
        newLocator: `page.getByLabel(/${textHint}/i)`,
        confidence: 0.82,
        reasoning: 'Class selector → label locator.',
        ruleId: 'R08',
      });
    }

    /* ================================================================== */
    /*  RULE 9-12: Data Attributes                                        */
    /* ================================================================== */

    // Rule 9: data-testid
    if (/\[data-testid\s*=/.test(locator)) {
      const val = extractValue(locator);
      rulesApplied.push('R09_data_testid');
      suggestions.push({
        newLocator: `page.getByTestId('${val}')`,
        confidence: 0.90,
        reasoning: 'data-testid attribute → getByTestId (most stable).',
        ruleId: 'R09',
      });
    }

    // Rule 10: data-cy / data-test
    if (/\[data-(?:cy|test|qa)\s*=/.test(locator)) {
      const attr = extractDataAttribute(locator);
      rulesApplied.push('R10_data_custom');
      suggestions.push({
        newLocator: `page.locator('[${attr.name}="${attr.value}"]')`,
        confidence: 0.85,
        reasoning: `Custom data attribute (${attr.name}) → direct attribute selector.`,
        ruleId: 'R10',
      });
      suggestions.push({
        newLocator: `page.getByTestId('${attr.value}')`,
        confidence: 0.80,
        reasoning: `Custom data attribute → getByTestId.`,
        ruleId: 'R10b',
      });
    }

    // Rule 11: Generic data-* attribute
    if (/\[data-/.test(locator) && !rulesApplied.includes('R09_data_testid') && !rulesApplied.includes('R10_data_custom')) {
      const attr = extractDataAttribute(locator);
      if (attr.name) {
        rulesApplied.push('R11_data_generic');
        suggestions.push({
          newLocator: `page.locator('[${attr.name}="${attr.value}"]')`,
          confidence: 0.78,
          reasoning: 'Generic data attribute → attribute selector.',
          ruleId: 'R11',
        });
      }
    }

    /* ================================================================== */
    /*  RULE 12-14: ARIA Attributes                                       */
    /* ================================================================== */

    // Rule 12: aria-label
    if (/aria-label/i.test(locator)) {
      const m = /aria-label\s*=\s*["']([^"']+)["']/.exec(locator);
      const label = m?.[1] || extractTextHint(locator);
      rulesApplied.push('R12_aria_label');
      suggestions.push({
        newLocator: `page.getByLabel('${label}')`,
        confidence: 0.92,
        reasoning: 'aria-label → getByLabel (best practice).',
        ruleId: 'R12',
      });
    }

    // Rule 13: role attribute
    if (/role\s*=/.test(locator)) {
      const rm = /role\s*=\s*["']([^"']+)["']/.exec(locator);
      const role = rm?.[1] || 'button';
      const textHint = extractTextHint(locator);
      rulesApplied.push('R13_aria_role');
      suggestions.push({
        newLocator: textHint
          ? `page.getByRole('${role}', { name: /${textHint}/i })`
          : `page.getByRole('${role}')`,
        confidence: 0.88,
        reasoning: 'role attribute → getByRole.',
        ruleId: 'R13',
      });
    }

    // Rule 14: aria-describedby / aria-labelledby
    if (/aria-(?:describedby|labelledby)\s*=/.test(locator)) {
      const m = /aria-(?:describedby|labelledby)\s*=\s*["']([^"']+)["']/.exec(locator);
      if (m?.[1]) {
        rulesApplied.push('R14_aria_described');
        suggestions.push({
          newLocator: `page.locator('[aria-describedby="${m[1]}"]')`,
          confidence: 0.75,
          reasoning: 'ARIA describedby/labelledby → attribute selector.',
          ruleId: 'R14',
        });
      }
    }

    /* ================================================================== */
    /*  RULE 15-18: Form Elements                                         */
    /* ================================================================== */

    // Rule 15: Input by name attribute
    if (/input\s*\[\s*name\s*=/.test(locator)) {
      const nameValueMatch = /name\s*=\s*['"]?([^'")\]]+)['"]?/.exec(locator);
      const nameValue = nameValueMatch?.[1] ?? '';
      const fieldName = humanize(nameValue);
      rulesApplied.push('R15_input_name');

      // R15_attr: Attribute-based fuzzy candidates (HIGHEST PRIORITY)
      // When input[name="user"] fails, try common extensions like "username"
      const commonMappings: Array<{ suffix: string; confidence: number }> = [
        { suffix: 'name', confidence: 0.95 },      // user → username
        { suffix: '_name', confidence: 0.94 },      // user → user_name
        { suffix: 'Name', confidence: 0.94 },       // user → userName
        { suffix: '_id', confidence: 0.90 },         // user → user_id
        { suffix: 'Id', confidence: 0.90 },          // user → userId
        { suffix: '_input', confidence: 0.88 },      // user → user_input
        { suffix: 'Input', confidence: 0.88 },       // user → userInput
        { suffix: '_field', confidence: 0.86 },      // user → user_field
      ];

      // Also try known semantic equivalences
      const semanticMappings: Record<string, string[]> = {
        'user': ['username', 'userName', 'user_name', 'login', 'loginName', 'uname'],
        'pass': ['password', 'passwd', 'passWord', 'pass_word', 'pwd'],
        'pwd': ['password', 'passwd'],
        'email': ['emailAddress', 'email_address', 'mail', 'userEmail'],
        'mail': ['email', 'emailAddress'],
        'phone': ['phoneNumber', 'phone_number', 'tel', 'telephone', 'mobile'],
        'tel': ['phone', 'phoneNumber', 'telephone'],
        'addr': ['address', 'streetAddress', 'street_address'],
        'fname': ['firstName', 'first_name', 'givenName'],
        'lname': ['lastName', 'last_name', 'surname'],
        'first': ['firstName', 'first_name'],
        'last': ['lastName', 'last_name'],
        'name': ['fullName', 'full_name', 'displayName'],
        'msg': ['message', 'comment', 'body'],
        'search': ['query', 'searchQuery', 'keyword', 'q'],
        'zip': ['zipcode', 'zipCode', 'postalCode', 'postal_code'],
      };

      // Add semantic mappings first (highest confidence for known equivalences)
      const knownAlternatives = semanticMappings[nameValue.toLowerCase()] || [];
      for (const alt of knownAlternatives) {
        suggestions.push({
          newLocator: `input[name="${alt}"]`,
          confidence: 0.96,
          reasoning: `Semantic mapping: input[name="${nameValue}"] → input[name="${alt}"] (known equivalent).`,
          ruleId: 'R15_semantic',
        });
      }

      // Add suffix-based candidates
      for (const { suffix, confidence } of commonMappings) {
        const candidate = nameValue + suffix;
        // Skip if already covered by semantic mappings
        if (knownAlternatives.some(a => a.toLowerCase() === candidate.toLowerCase())) continue;
        suggestions.push({
          newLocator: `input[name="${candidate}"]`,
          confidence,
          reasoning: `Attribute fuzzy: input[name="${nameValue}"] → input[name="${candidate}"] (common naming pattern).`,
          ruleId: 'R15_attr',
        });
      }

      // Then add semantic locator fallbacks (lower priority than attribute fixes)
      suggestions.push({
        newLocator: `page.getByLabel(/${fieldName}/i)`,
        confidence: 0.82,
        reasoning: 'Input[name] → label-first locator (fallback if no label exists, will fail).',
        ruleId: 'R15',
      });
      suggestions.push({
        newLocator: `page.getByPlaceholder(/${fieldName}/i)`,
        confidence: 0.78,
        reasoning: 'Input[name] → placeholder locator (fallback).',
        ruleId: 'R15b',
      });
      suggestions.push({
        newLocator: `page.getByRole('textbox', { name: /${fieldName}/i })`,
        confidence: 0.76,
        reasoning: 'Input[name] → textbox role locator (fallback).',
        ruleId: 'R15c',
      });
    }

    // Rule 16: Input by type
    if (/input\[type\s*=\s*["']?(\w+)/.test(locator)) {
      const typeMatch = /input\[type\s*=\s*["']?(\w+)/.exec(locator);
      const inputType = typeMatch?.[1] || 'text';
      rulesApplied.push('R16_input_type');

      if (inputType === 'checkbox') {
        suggestions.push({
          newLocator: `page.getByRole('checkbox')`,
          confidence: 0.88,
          reasoning: 'Input[type=checkbox] → checkbox role.',
          ruleId: 'R16a',
        });
      } else if (inputType === 'radio') {
        suggestions.push({
          newLocator: `page.getByRole('radio')`,
          confidence: 0.88,
          reasoning: 'Input[type=radio] → radio role.',
          ruleId: 'R16b',
        });
      } else if (inputType === 'password') {
        suggestions.push({
          newLocator: `page.getByLabel(/password/i)`,
          confidence: 0.90,
          reasoning: 'Input[type=password] → password label.',
          ruleId: 'R16c',
        });
      } else if (inputType === 'email') {
        suggestions.push({
          newLocator: `page.getByLabel(/email/i)`,
          confidence: 0.90,
          reasoning: 'Input[type=email] → email label.',
          ruleId: 'R16d',
        });
      }
    }

    // Rule 17: Placeholder attribute
    if (/placeholder\s*=\s*["']([^"']+)["']/.test(locator)) {
      const pm = /placeholder\s*=\s*["']([^"']+)["']/.exec(locator);
      if (pm?.[1]) {
        rulesApplied.push('R17_placeholder');
        suggestions.push({
          newLocator: `page.getByPlaceholder('${pm[1]}')`,
          confidence: 0.88,
          reasoning: 'Placeholder attribute → getByPlaceholder.',
          ruleId: 'R17',
        });
      }
    }

    // Rule 18: Select / dropdown
    if (/select|dropdown|combobox/i.test(locator + ' ' + failedLine)) {
      const textHint = extractTextHint(locator) || 'select';
      rulesApplied.push('R18_select');
      suggestions.push({
        newLocator: `page.getByRole('combobox', { name: /${textHint}/i })`,
        confidence: 0.86,
        reasoning: 'Select/dropdown → combobox role.',
        ruleId: 'R18',
      });
    }

    /* ================================================================== */
    /*  RULE 19-21: Button Elements                                       */
    /* ================================================================== */

    // Rule 19: Explicit button
    if (locator.includes('button') || /type=['"]submit['"]/.test(locator)) {
      const textHint = extractTextHint(locator);
      const buttonText = textHint || 'login|submit|save|continue';
      rulesApplied.push('R19_button');

      suggestions.push({
        newLocator: `page.getByRole('button', { name: /${buttonText}/i })`,
        confidence: 0.92,
        reasoning: 'Button element → role-based semantic lookup.',
        ruleId: 'R19',
      });
      suggestions.push({
        newLocator: `page.getByText(/${buttonText}/i)`,
        confidence: 0.85,
        reasoning: 'Button element → text-based lookup.',
        ruleId: 'R19b',
      });
      suggestions.push({
        newLocator: `page.locator('button[type="submit"]')`,
        confidence: 0.82,
        reasoning: 'Button element → type=submit attribute selector.',
        ruleId: 'R19c',
      });
    }

    // Rule 20: Click action implies button
    if (/click\(/i.test(failedLine) && !rulesApplied.includes('R19_button') && suggestions.length === 0) {
      const textHint = extractTextHint(locator) || extractTextHint(failure.failedLineCode || '');
      if (textHint) {
        rulesApplied.push('R20_click_button');
        suggestions.push({
          newLocator: `page.getByRole('button', { name: /${textHint}/i })`,
          confidence: 0.87,
          reasoning: 'Click action context → button role.',
          ruleId: 'R20',
        });
      }
    }

    // Rule 21: Icon buttons (common in Material UI, etc.)
    if (/icon|svg|mat-icon|fa-|bi-/.test(locator)) {
      rulesApplied.push('R21_icon_button');
      const ariaLabel = extractTextHint(locator) || 'icon';
      suggestions.push({
        newLocator: `page.getByRole('button', { name: /${ariaLabel}/i })`,
        confidence: 0.80,
        reasoning: 'Icon element → button role with aria-label.',
        ruleId: 'R21',
      });
    }

    /* ================================================================== */
    /*  RULE 22-23: Link Elements                                         */
    /* ================================================================== */

    // Rule 22: Links
    if (/link|anchor|<a[\s>]|href/.test(locator + ' ' + failedLine)) {
      const linkText = extractTextHint(locator) || 'link';
      rulesApplied.push('R22_link');

      suggestions.push({
        newLocator: `page.getByRole('link', { name: /${linkText}/i })`,
        confidence: 0.90,
        reasoning: 'Link element → role-based locator.',
        ruleId: 'R22',
      });
      suggestions.push({
        newLocator: `page.getByText(/${linkText}/i)`,
        confidence: 0.84,
        reasoning: 'Link element → text-based locator.',
        ruleId: 'R22b',
      });
    }

    // Rule 23: Navigation links
    if (/nav|menu|sidebar|tab/i.test(locator + ' ' + surrounding)) {
      const text = extractTextHint(locator) || 'menu';
      rulesApplied.push('R23_nav');
      suggestions.push({
        newLocator: `page.getByRole('navigation').getByText(/${text}/i)`,
        confidence: 0.82,
        reasoning: 'Navigation context → nav role + text.',
        ruleId: 'R23',
      });
    }

    /* ================================================================== */
    /*  RULE 24-25: Heading Elements                                      */
    /* ================================================================== */

    // Rule 24: Headings
    if (/h[1-6]|heading/.test(locator + ' ' + failedLine)) {
      const headingText = extractTextHint(locator) || 'heading';
      rulesApplied.push('R24_heading');

      suggestions.push({
        newLocator: `page.getByRole('heading', { name: /${headingText}/i })`,
        confidence: 0.91,
        reasoning: 'Heading element → role-based locator.',
        ruleId: 'R24',
      });
    }

    // Rule 25: Heading with specific level
    const levelMatch = /h([1-6])/.exec(locator);
    if (levelMatch) {
      const headingText = extractTextHint(locator) || 'heading';
      rulesApplied.push('R25_heading_level');
      suggestions.push({
        newLocator: `page.getByRole('heading', { name: /${headingText}/i, level: ${levelMatch[1]} })`,
        confidence: 0.89,
        reasoning: `h${levelMatch[1]} → heading role with level.`,
        ruleId: 'R25',
      });
    }

    /* ================================================================== */
    /*  RULE 26-28: XPath Selectors                                       */
    /* ================================================================== */

    // Rule 26: XPath → modern selectors
    if (locator.startsWith('//') || locator.startsWith('xpath=') || locator.startsWith('/')) {
      const textHint = extractTextHint(locator) || 'element';
      rulesApplied.push('R26_xpath');

      // Check XPath for element type hints
      const xpathTagMatch = /\/\/(\w+)/.exec(locator);
      const tag = xpathTagMatch?.[1]?.toLowerCase() || '';

      if (tag === 'button' || /button/.test(locator)) {
        suggestions.push({
          newLocator: `page.getByRole('button', { name: /${textHint}/i })`,
          confidence: 0.88,
          reasoning: 'XPath with button → semantic role locator.',
          ruleId: 'R26a',
        });
      } else if (tag === 'input') {
        suggestions.push({
          newLocator: `page.getByLabel(/${textHint}/i)`,
          confidence: 0.86,
          reasoning: 'XPath with input → label locator.',
          ruleId: 'R26b',
        });
      } else if (tag === 'a') {
        suggestions.push({
          newLocator: `page.getByRole('link', { name: /${textHint}/i })`,
          confidence: 0.87,
          reasoning: 'XPath with link → role locator.',
          ruleId: 'R26c',
        });
      }

      // Rule 27: Generic XPath fallbacks
      rulesApplied.push('R27_xpath_generic');
      suggestions.push({
        newLocator: `page.getByText(/${textHint}/i)`,
        confidence: 0.83,
        reasoning: 'XPath → text-based locator.',
        ruleId: 'R27',
      });
    }

    // Rule 28: XPath with contains(text())
    if (/contains\(\s*text\(\)\s*,/.test(locator)) {
      const textMatch = /contains\(\s*text\(\)\s*,\s*["']([^"']+)["']/.exec(locator);
      if (textMatch?.[1]) {
        rulesApplied.push('R28_xpath_contains');
        suggestions.push({
          newLocator: `page.getByText('${textMatch[1]}')`,
          confidence: 0.90,
          reasoning: 'XPath contains(text()) → getByText.',
          ruleId: 'R28',
        });
      }
    }

    /* ================================================================== */
    /*  RULE 29: Input context from error/failed line                     */
    /* ================================================================== */
    if (/fill|type|input|textbox|field/.test(failedLine) && suggestions.length === 0) {
      const fieldHints = /username|password|email|search|name|phone|address|first.?name|last.?name/i.exec(
        failedLocator + ' ' + failure.errorMessage,
      );
      const hint = fieldHints?.[0] || 'input';
      rulesApplied.push('R29_input_context');

      suggestions.push({
        newLocator: `page.getByLabel(/${hint}/i)`,
        confidence: 0.90,
        reasoning: 'Input element → label locator based on context.',
        ruleId: 'R29a',
      });
      suggestions.push({
        newLocator: `page.getByPlaceholder(/${hint}/i)`,
        confidence: 0.86,
        reasoning: 'Input element → placeholder locator.',
        ruleId: 'R29b',
      });
      suggestions.push({
        newLocator: `page.getByRole('textbox', { name: /${hint}/i })`,
        confidence: 0.84,
        reasoning: 'Input element → textbox role locator.',
        ruleId: 'R29c',
      });
    }

    /* ================================================================== */
    /*  RULE 30-31: Table / List elements                                  */
    /* ================================================================== */

    // Rule 30: Table cells
    if (/table|tbody|thead|tr|td|th/.test(locator)) {
      const text = extractTextHint(locator) || 'cell';
      rulesApplied.push('R30_table');
      suggestions.push({
        newLocator: `page.getByRole('cell', { name: /${text}/i })`,
        confidence: 0.82,
        reasoning: 'Table element → cell role.',
        ruleId: 'R30',
      });
      suggestions.push({
        newLocator: `page.getByRole('row').filter({ hasText: /${text}/i })`,
        confidence: 0.78,
        reasoning: 'Table element → row with text filter.',
        ruleId: 'R30b',
      });
    }

    // Rule 31: List items
    if (/li|ul|ol|listitem|list/.test(locator)) {
      const text = extractTextHint(locator) || 'item';
      rulesApplied.push('R31_list');
      suggestions.push({
        newLocator: `page.getByRole('listitem').filter({ hasText: /${text}/i })`,
        confidence: 0.80,
        reasoning: 'List item → listitem role.',
        ruleId: 'R31',
      });
    }

    /* ================================================================== */
    /*  RULE 32-33: Image / Media                                         */
    /* ================================================================== */

    // Rule 32: Images
    if (/img|image|picture/.test(locator + ' ' + failedLine)) {
      const altText = extractTextHint(locator) || 'image';
      rulesApplied.push('R32_image');
      suggestions.push({
        newLocator: `page.getByAltText(/${altText}/i)`,
        confidence: 0.88,
        reasoning: 'Image element → getByAltText.',
        ruleId: 'R32',
      });
      suggestions.push({
        newLocator: `page.getByRole('img', { name: /${altText}/i })`,
        confidence: 0.85,
        reasoning: 'Image element → img role.',
        ruleId: 'R32b',
      });
    }

    /* ================================================================== */
    /*  RULE 33: Dialog / Modal                                           */
    /* ================================================================== */
    if (/dialog|modal|popup|overlay/.test(locator + ' ' + failedLine + ' ' + surrounding)) {
      const text = extractTextHint(locator) || 'dialog';
      rulesApplied.push('R33_dialog');
      suggestions.push({
        newLocator: `page.getByRole('dialog').getByText(/${text}/i)`,
        confidence: 0.82,
        reasoning: 'Dialog/modal context → dialog role.',
        ruleId: 'R33',
      });
    }

    /* ================================================================== */
    /*  RULE 34: CSS nth-child / nth-of-type                              */
    /* ================================================================== */
    if (/:nth-child\(|:nth-of-type\(/.test(locator)) {
      const text = extractTextHint(locator) || 'element';
      rulesApplied.push('R34_nth_child');
      suggestions.push({
        newLocator: `page.getByText(/${text}/i).first()`,
        confidence: 0.75,
        reasoning: 'nth-child selector → text locator with first().',
        ruleId: 'R34',
      });
    }

    /* ================================================================== */
    /*  RULE 35: Title attribute                                          */
    /* ================================================================== */
    if (/title\s*=\s*["']([^"']+)["']/.test(locator)) {
      const titleMatch = /title\s*=\s*["']([^"']+)["']/.exec(locator);
      if (titleMatch?.[1]) {
        rulesApplied.push('R35_title');
        suggestions.push({
          newLocator: `page.getByTitle('${titleMatch[1]}')`,
          confidence: 0.86,
          reasoning: 'Title attribute → getByTitle.',
          ruleId: 'R35',
        });
      }
    }

    /* ================================================================== */
    /*  RULE 36: Timeout / Wait                                           */
    /* ================================================================== */
    const addExplicitWait = /timeout|timed out|waiting for/i.test(failure.errorMessage);

    if (addExplicitWait) {
      rulesApplied.push('R36_timeout');
      if (suggestions.length === 0 && failedLocator) {
        suggestions.push({
          newLocator: failedLocator,
          confidence: 0.85,
          reasoning: 'Timeout error → keeping same locator with explicit wait added.',
          ruleId: 'R36',
        });
      }
    }

    /* ================================================================== */
    /*  RULE 37: Shadow DOM                                               */
    /* ================================================================== */
    if (/shadow-root|shadowdom|::shadow|>>>/.test(locator + ' ' + failedLine)) {
      const text = extractTextHint(locator) || 'element';
      rulesApplied.push('R37_shadow_dom');
      suggestions.push({
        newLocator: `page.locator('${text}').first()`,
        confidence: 0.70,
        reasoning: 'Shadow DOM element → simplified locator.',
        ruleId: 'R37',
      });
    }

    /* ================================================================== */
    /*  Finalize                                                          */
    /* ================================================================== */

    logger.info(MOD, 'Generated deterministic suggestions', {
      testName: failure.testName,
      failedLocator,
      count: suggestions.length,
      rulesApplied: rulesApplied.length,
      addExplicitWait,
    });

    return {
      suggestions: dedupeSuggestions(suggestions),
      addExplicitWait,
      rulesApplied,
    };
  }
}
