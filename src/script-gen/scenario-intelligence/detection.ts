/**
 * Shared detection helpers for self-describing transformers.
 *
 * Every transformer's `matches` classifies against the same normalised text of
 * the case (title + scenario + coverage type + steps). Centralising just the
 * text-building and the special-character mining keeps detection consistent
 * across transformers while leaving each transformer's *rule* (which regex it
 * cares about) fully local to that transformer.
 */
import type { ScenarioCaseInput } from './types';

/**
 * Build the lowercased haystack a transformer matches against — the union of the
 * case's title, free-text scenario, coverage type, and the joined step text.
 */
export function buildHaystack(
  input: ScenarioCaseInput | undefined,
  steps: string[],
): string {
  return [input?.title, input?.scenario, input?.coverage_type, (steps || []).join(' ')]
    .map((s) => `${s ?? ''}`)
    .join(' ')
    .toLowerCase();
}

/**
 * Pull an explicit special-character username authored in a username step,
 * e.g. "Enter '@locked_user' in [data-testid='username']" → "@locked_user".
 * Bracketed selectors are stripped first so an attribute value is never mined.
 * Returns '' when no special-character literal is present.
 */
export function extractSpecialCharLiteral(steps: string[]): string {
  for (const s of steps || []) {
    if (!/user|email|login\s*id/i.test(s)) continue;
    const cleaned = String(s).replace(/\[[^\]]*\]/g, ' '); // drop [data-testid='…']
    const m = cleaned.match(/'([^']+)'|"([^"]+)"/);
    const v = m ? (m[1] ?? m[2] ?? '').trim() : '';
    if (v && /[^a-zA-Z0-9_]/.test(v)) return v; // contains a genuine special char
  }
  return '';
}
