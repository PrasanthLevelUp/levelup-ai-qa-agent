import type { ScenarioCaseInput, ScenarioClassification } from './types';

/**
 * Classifies the input-mutation intent of a login test case.
 *
 * Precedence is chosen so the most specific, testable mutation wins:
 *   empty → whitespace → special-char → max-length → invalid → normal
 *
 * This is the single source of truth for "what scenario is this?" — both the
 * credential transformers and the assertion layer consume its output, so a case
 * can never be transformed as one scenario but asserted as another.
 */
export class ScenarioClassifier {
  classify(tc: ScenarioCaseInput | undefined, steps: string[]): ScenarioClassification {
    const hay = [tc?.title, tc?.scenario, tc?.coverage_type, (steps || []).join(' ')]
      .map((s) => `${s ?? ''}`)
      .join(' ')
      .toLowerCase();

    if (/\bempty\b|\bblank\b|leave.*(empty|blank)|without\s+(a\s+)?(username|password|credential)/.test(hay)) {
      return { kind: 'empty' };
    }
    if (/leading|trailing|whitespace|\bspaces?\b/.test(hay)) {
      return { kind: 'whitespace' };
    }
    if (/special[\s-]*char/.test(hay)) {
      return { kind: 'special', literal: this.extractSpecialCharLiteral(steps) || undefined };
    }
    if (/max(?:imum)?[\s-]*length|too\s+long|very\s+long|exceed\w*\s+length|\blong\b.*(user|name)/.test(hay)) {
      const num = hay.match(/\b(\d{2,4})\b/);
      const length = num ? Math.min(parseInt(num[1]!, 10), 4096) : 256;
      return { kind: 'maxlength', length };
    }
    if (/\b(invalid|incorrect|wrong|unregistered|nonexistent|non-existent)\b|do not match/.test(hay)) {
      return { kind: 'invalid' };
    }
    return { kind: 'normal' };
  }

  /**
   * Pull an explicit special-character username authored in a username step,
   * e.g. "Enter '@locked_user' in [data-testid='username']" → "@locked_user".
   * Bracketed selectors are stripped first so an attribute value is never mined.
   * Returns '' when no special-character literal is present.
   */
  private extractSpecialCharLiteral(steps: string[]): string {
    for (const s of steps || []) {
      if (!/user|email|login\s*id/i.test(s)) continue;
      const cleaned = String(s).replace(/\[[^\]]*\]/g, ' '); // drop [data-testid='…']
      const m = cleaned.match(/'([^']+)'|"([^"]+)"/);
      const v = m ? (m[1] ?? m[2] ?? '').trim() : '';
      if (v && /[^a-zA-Z0-9_]/.test(v)) return v; // contains a genuine special char
    }
    return '';
  }
}
