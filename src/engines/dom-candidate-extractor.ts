/**
 * DOM Candidate Extractor
 * Captures live DOM during failure and extracts ranked candidate selectors.
 * This is the KEY missing piece — instead of guessing semantic locators,
 * we scan the actual DOM to find elements that closely match the failed selector.
 *
 * Flow:
 * 1. Capture page DOM (page.content())
 * 2. Parse failed locator to understand what element type + attribute was targeted
 * 3. Scan DOM for all elements of the same type
 * 4. Extract attributes (name, id, class, placeholder, aria-label, data-*, role)
 * 5. Score each candidate against the failed locator using similarity
 * 6. Return ranked candidates
 */

import { logger } from '../utils/logger';

const MOD = 'dom-candidate-extractor';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface DOMCandidate {
  selector: string;
  score: number;
  reasoning: string;
  matchType: 'exact_attribute' | 'fuzzy_attribute' | 'semantic' | 'structural';
  element: {
    tag: string;
    attributes: Record<string, string>;
    textContent: string;
    nearbyLabel: string;
  };
}

export interface DOMExtractionResult {
  candidates: DOMCandidate[];
  domCaptured: boolean;
  elementsScanned: number;
  failedLocatorParsed: ParsedLocator;
}

export interface ParsedLocator {
  tag: string;
  attribute: string;
  value: string;
  action: string; // fill, click, etc.
}

/* -------------------------------------------------------------------------- */
/*  String Similarity                                                         */
/* -------------------------------------------------------------------------- */

/** Levenshtein distance between two strings */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Normalized similarity score 0..1 (1 = identical) */
function stringSimilarity(a: string, b: string): number {
  if (a === b) return 1.0;
  if (!a || !b) return 0;
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (al === bl) return 0.99;
  // Substring containment bonus
  if (bl.includes(al) || al.includes(bl)) {
    const longer = Math.max(al.length, bl.length);
    const shorter = Math.min(al.length, bl.length);
    return 0.7 + (shorter / longer) * 0.25;
  }
  const maxLen = Math.max(al.length, bl.length);
  const dist = levenshtein(al, bl);
  return Math.max(0, 1 - dist / maxLen);
}

/* -------------------------------------------------------------------------- */
/*  Locator Parser                                                            */
/* -------------------------------------------------------------------------- */

/** Parse a failed locator/code line to extract tag, attribute, value, action */
export function parseFailedLocator(locator: string, codeLine: string = ''): ParsedLocator {
  const combined = locator + ' ' + codeLine;

  // Detect action from code line
  let action = 'unknown';
  if (/\.fill\(/i.test(combined)) action = 'fill';
  else if (/\.click\(/i.test(combined)) action = 'click';
  else if (/\.type\(/i.test(combined)) action = 'fill';
  else if (/\.check\(/i.test(combined)) action = 'check';
  else if (/\.selectOption\(/i.test(combined)) action = 'select';

  // Parse CSS selectors: input[name="user"], #username, .login-btn, etc.
  // Pattern: tag[attr="value"]
  let tag = '*';
  let attribute = '';
  let value = '';

  // Match: input[name="user"] or input[name='user']
  const attrSelectorMatch = /^(\w+)?\[([\w-]+)\s*=\s*["']([^"']+)["']\]/.exec(locator);
  if (attrSelectorMatch) {
    tag = attrSelectorMatch[1] || '*';
    attribute = attrSelectorMatch[2];
    value = attrSelectorMatch[3];
    return { tag, attribute, value, action };
  }

  // Match: #someId
  const idMatch = /^#([\w-]+)/.exec(locator);
  if (idMatch) {
    tag = '*';
    attribute = 'id';
    value = idMatch[1];
    return { tag, attribute, value, action };
  }

  // Match: .someClass
  const classMatch = /^\.([\w-]+)/.exec(locator);
  if (classMatch) {
    tag = '*';
    attribute = 'class';
    value = classMatch[1];
    return { tag, attribute, value, action };
  }

  // Match Playwright semantic: page.getByLabel(/user/i)
  const labelMatch = /getByLabel\(\/?([^/)'"]+)/.exec(locator);
  if (labelMatch) {
    attribute = 'label';
    value = labelMatch[1].replace(/\/i$/, '').trim();
    return { tag: 'input', attribute, value, action };
  }

  // Match: page.fill('selector', 'value') — extract the selector part
  const fillMatch = /(?:fill|click|type)\(['"]([^'"]+)['"]/.exec(combined);
  if (fillMatch) {
    return parseFailedLocator(fillMatch[1], '');
  }

  return { tag, attribute, value, action };
}

/* -------------------------------------------------------------------------- */
/*  DOM Candidate Extractor                                                   */
/* -------------------------------------------------------------------------- */

export class DOMCandidateExtractor {
  /**
   * Extract candidates from raw DOM HTML.
   * Called with the HTML string from page.content().
   */
  extractFromHTML(
    domHtml: string,
    failedLocator: string,
    codeLine: string = '',
  ): DOMExtractionResult {
    const parsed = parseFailedLocator(failedLocator, codeLine);
    const candidates: DOMCandidate[] = [];
    let elementsScanned = 0;

    logger.info(MOD, 'Extracting DOM candidates', {
      failedLocator,
      parsedTag: parsed.tag,
      parsedAttr: parsed.attribute,
      parsedValue: parsed.value,
      parsedAction: parsed.action,
    });

    // Determine which tags to scan
    const targetTags = this.getTargetTags(parsed);

    for (const tag of targetTags) {
      // Extract all elements of this tag type from DOM HTML using regex
      // (We avoid a full DOM parser dependency — regex is sufficient for attribute extraction)
      const tagRegex = new RegExp(
        `<${tag}\\b([^>]*)(?:>([^<]*)<\\/${tag}>|\\/>)`,
        'gi',
      );

      let match: RegExpExecArray | null;
      while ((match = tagRegex.exec(domHtml)) !== null) {
        elementsScanned++;
        const attrString = match[1] || '';
        const textContent = (match[2] || '').trim();
        const attributes = this.parseAttributes(attrString);

        // Find nearby label (look backwards in DOM for <label> before this element)
        const nearbyLabel = this.findNearbyLabel(domHtml, match.index);

        const element = { tag, attributes, textContent, nearbyLabel };

        // Score this candidate against the failed locator
        const scored = this.scoreCandidate(element, parsed);
        if (scored) {
          candidates.push(scored);
        }
      }
    }

    // Sort by score descending
    candidates.sort((a, b) => b.score - a.score);

    // Keep top 10
    const topCandidates = candidates.slice(0, 10);

    logger.info(MOD, 'DOM extraction complete', {
      elementsScanned,
      candidatesFound: candidates.length,
      topScore: topCandidates[0]?.score ?? 0,
      topSelector: topCandidates[0]?.selector ?? 'none',
    });

    return {
      candidates: topCandidates,
      domCaptured: true,
      elementsScanned,
      failedLocatorParsed: parsed,
    };
  }

  /**
   * Live DOM extraction using Playwright page object.
   * Call this during the healing process when the page is still open.
   */
  async extractFromPage(
    page: any, // Playwright Page
    failedLocator: string,
    codeLine: string = '',
  ): Promise<DOMExtractionResult> {
    try {
      const domHtml = await page.content();
      return this.extractFromHTML(domHtml, failedLocator, codeLine);
    } catch (err: any) {
      logger.warn(MOD, 'Failed to capture DOM from page', { error: err.message });
      return {
        candidates: [],
        domCaptured: false,
        elementsScanned: 0,
        failedLocatorParsed: parseFailedLocator(failedLocator, codeLine),
      };
    }
  }

  /* ---- Private methods ---- */

  private getTargetTags(parsed: ParsedLocator): string[] {
    // Determine which element types to scan based on context
    if (parsed.tag !== '*') return [parsed.tag];

    // Infer from action
    switch (parsed.action) {
      case 'fill': return ['input', 'textarea'];
      case 'click': return ['button', 'a', 'input', 'div', 'span'];
      case 'check': return ['input'];
      case 'select': return ['select'];
      default: return ['input', 'button', 'a', 'select', 'textarea'];
    }
  }

  private parseAttributes(attrString: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    // Match: name="value" or name='value' or name=value or standalone-attr
    const attrRegex = /([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+)))?/g;
    let m: RegExpExecArray | null;
    while ((m = attrRegex.exec(attrString)) !== null) {
      const name = m[1].toLowerCase();
      const value = m[2] ?? m[3] ?? m[4] ?? '';
      attrs[name] = value;
    }
    return attrs;
  }

  private findNearbyLabel(domHtml: string, elementIndex: number): string {
    // Look backwards up to 500 chars for a <label> element
    const lookback = domHtml.substring(Math.max(0, elementIndex - 500), elementIndex);
    const labelMatch = /<label[^>]*>([^<]+)<\/label>/gi;
    let lastLabel = '';
    let m: RegExpExecArray | null;
    while ((m = labelMatch.exec(lookback)) !== null) {
      lastLabel = m[1].trim();
    }
    return lastLabel;
  }

  private scoreCandidate(
    element: { tag: string; attributes: Record<string, string>; textContent: string; nearbyLabel: string },
    parsed: ParsedLocator,
  ): DOMCandidate | null {
    const { attributes, tag } = element;
    let bestScore = 0;
    let bestSelector = '';
    let bestReasoning = '';
    let bestMatchType: DOMCandidate['matchType'] = 'structural';

    const failedValue = parsed.value.toLowerCase();
    if (!failedValue) return null;

    // Strategy 1: Same attribute type, similar value (HIGHEST PRIORITY)
    if (parsed.attribute && parsed.attribute !== 'class' && parsed.attribute !== 'label') {
      const attrValue = attributes[parsed.attribute];
      if (attrValue) {
        const sim = stringSimilarity(failedValue, attrValue);
        if (sim > 0.4 && sim < 1.0) { // Skip exact match (that's the broken one)
          const score = 0.50 + sim * 0.48; // Range: 0.50 - 0.98
          if (score > bestScore) {
            bestScore = score;
            bestSelector = `${tag}[${parsed.attribute}="${attrValue}"]`;
            bestReasoning = `Same attribute "${parsed.attribute}": "${failedValue}" → "${attrValue}" (similarity: ${sim.toFixed(2)})`;
            bestMatchType = sim > 0.7 ? 'exact_attribute' : 'fuzzy_attribute';
          }
        }
      }
    }

    // Strategy 2: Cross-attribute matching (name vs id vs placeholder)
    const crossAttrs = ['name', 'id', 'placeholder', 'aria-label', 'data-testid', 'title'];
    for (const attr of crossAttrs) {
      if (attr === parsed.attribute) continue; // Already checked above
      const val = attributes[attr];
      if (!val) continue;
      const sim = stringSimilarity(failedValue, val);
      if (sim > 0.5) {
        const score = 0.40 + sim * 0.40; // Range: 0.40 - 0.80
        if (score > bestScore) {
          bestScore = score;
          bestSelector = attr === 'id' ? `#${val}` : `${tag}[${attr}="${val}"]`;
          bestReasoning = `Cross-attribute match: [${parsed.attribute}="${failedValue}"] → [${attr}="${val}"] (similarity: ${sim.toFixed(2)})`;
          bestMatchType = 'fuzzy_attribute';
        }
      }
    }

    // Strategy 3: Nearby label matching
    if (element.nearbyLabel) {
      const labelSim = stringSimilarity(failedValue, element.nearbyLabel);
      if (labelSim > 0.5) {
        const score = 0.35 + labelSim * 0.35;
        if (score > bestScore) {
          bestScore = score;
          bestSelector = `page.getByLabel(/${element.nearbyLabel}/i)`;
          bestReasoning = `Nearby label "${element.nearbyLabel}" matches "${failedValue}" (similarity: ${labelSim.toFixed(2)})`;
          bestMatchType = 'semantic';
        }
      }
    }

    // Strategy 4: Text content matching (for buttons, links)
    if (element.textContent) {
      const textSim = stringSimilarity(failedValue, element.textContent);
      if (textSim > 0.5) {
        const score = 0.30 + textSim * 0.35;
        if (score > bestScore) {
          bestScore = score;
          const role = tag === 'button' ? 'button' : tag === 'a' ? 'link' : 'generic';
          bestSelector = `page.getByRole('${role}', { name: /${element.textContent}/i })`;
          bestReasoning = `Text content "${element.textContent}" matches "${failedValue}" (similarity: ${textSim.toFixed(2)})`;
          bestMatchType = 'semantic';
        }
      }
    }

    if (bestScore < 0.45) return null;

    return {
      selector: bestSelector,
      score: Math.round(bestScore * 100) / 100,
      reasoning: bestReasoning,
      matchType: bestMatchType,
      element,
    };
  }
}
