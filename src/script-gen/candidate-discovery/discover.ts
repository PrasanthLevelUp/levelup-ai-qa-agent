/**
 * Candidate Discovery — pure discovery functions (Sprint 2 · PR 1)
 * =================================================================
 * All functions here are PURE: same inputs → same outputs, no I/O, no mutation
 * of their arguments, no throwing. They discover options only — no ranking, no
 * selection. Deterministic keyword matching (no LLM, no tokens).
 */

import type {
  CandidateType,
  DiscoveryContext,
  ImplementationCandidate,
  StepIntent,
} from './types';
import { REUSE_TYPES } from './types';

/** Lowercase + collapse whitespace. Never mutates the input. */
function norm(s: string): string {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Word-boundary keyword test (avoids "valid" matching "invalid"). */
function hasWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text);
}

/** True if any keyword appears as a whole word. */
function hasAny(text: string, words: string[]): boolean {
  return words.some((w) => hasWord(text, w));
}

/**
 * The engineering rationale for each candidate family — WHY this option exists.
 * Set at discovery time so the report reads candidate → reason → score and
 * Ranking (PR 2B) can explain its decisions without re-deriving intent.
 */
const REASON: Record<CandidateType, string> = {
  'existing-fixture': 'Existing reusable fixture — preferred setup abstraction',
  'existing-page-object': 'Existing Page Object method — reuse over new code',
  'existing-helper': 'Existing helper function — reuse over new code',
  'existing-component': 'Existing component abstraction — reuse over new code',
  'app-profile-locator': 'Grounded in the crawled Application Profile',
  'accessibility-locator': 'User-facing accessible locator (role / label)',
  'dom-locator': 'DOM fallback locator (css / text)',
};

/** Build a candidate, deriving the `reuse` flag and `reason` from the type. */
function candidate(type: CandidateType, source: string, detail?: string): ImplementationCandidate {
  return { type, source, detail, reuse: REUSE_TYPES.has(type), reason: REASON[type] };
}

/**
 * Deterministic action intent from a business step. Verify is checked FIRST so
 * "verify the username is displayed" is never mis-read as a fill on "username".
 */
export function classifyIntent(step: string): StepIntent {
  const t = norm(step);
  if (!t) return 'unknown';
  if (hasAny(t, ['verify', 'assert', 'confirm', 'ensure', 'should', 'expect', 'validate', 'check', 'see', 'displayed', 'visible'])) {
    return 'verify';
  }
  if (hasAny(t, ['navigate', 'go to', 'open', 'visit', 'load', 'browse to'])) return 'navigate';
  if (hasAny(t, ['enter', 'type', 'fill', 'input', 'provide', 'set'])) return 'fill';
  if (hasAny(t, ['click', 'press', 'tap', 'select', 'submit', 'choose', 'toggle'])) return 'click';
  return 'unknown';
}

/**
 * Extract a short target noun-phrase from a step for locator sketches, e.g.
 * "Click the Login button" → "login". Best-effort and deterministic; returns
 * '' when nothing meaningful can be pulled (discovery stays honest).
 */
export function extractTarget(step: string): string {
  const t = norm(step)
    // drop leading action verbs
    .replace(/^(navigate to|go to|browse to|click on|click|press|tap|select|submit|choose|toggle|enter|type|fill in|fill|input|provide|set|verify|assert|confirm|ensure|expect|validate|check|see|open|visit|load)\b/g, '')
    // drop common structural words
    .replace(/\b(the|a|an|into|in|on|to|field|button|link|page|element|value|valid|invalid|with|and|is|are|of)\b/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Keep it short — first two tokens are plenty for a locator sketch.
  return t.split(' ').filter(Boolean).slice(0, 2).join(' ');
}

/**
 * Reuse candidates: existing fixtures, page-object methods, helpers and
 * components whose name/method matches the step's target words. Name-intent
 * matching only — no code is generated. Returns [] when the repo offers none.
 */
export function discoverReuseCandidates(
  step: string,
  ctx: DiscoveryContext,
): ImplementationCandidate[] {
  const out: ImplementationCandidate[] = [];
  const t = norm(step);
  if (!t) return out;
  const target = extractTarget(step);
  const targetWords = target.split(' ').filter(Boolean);

  const matchesName = (name: string): boolean => {
    const n = norm(name);
    if (!n) return false;
    // Match if the step mentions the asset's name, or the asset name contains
    // one of the step's target words (e.g. "login" ⊂ "LoginPage").
    if (hasWord(t, n)) return true;
    return targetWords.some((w) => w.length > 2 && n.includes(w));
  };

  // Page-object methods (e.g. LoginPage.login()).
  for (const po of ctx.pageObjects ?? []) {
    const poMatches = matchesName(po.name);
    for (const m of po.methods ?? []) {
      const methodMatches = targetWords.some((w) => w.length > 2 && norm(m).includes(w)) || hasWord(t, norm(m));
      if (poMatches || methodMatches) {
        out.push(candidate('existing-page-object', `${po.name}.${m}()`, po.path));
      }
    }
    // A matched PO with no matching method is still a reuse lead worth surfacing.
    if (poMatches && !(po.methods ?? []).length) {
      out.push(candidate('existing-page-object', `${po.name}`, po.path));
    }
  }

  // Helper functions (e.g. loginAs()).
  for (const h of ctx.helpers ?? []) {
    for (const fn of h.functions ?? []) {
      const fnMatches = targetWords.some((w) => w.length > 2 && norm(fn).includes(w)) || hasWord(t, norm(fn));
      if (fnMatches) out.push(candidate('existing-helper', `${fn}()`, h.path ?? h.name));
    }
  }

  // Fixtures (e.g. authenticatedFixture).
  for (const f of ctx.fixtures ?? []) {
    if (matchesName(f.name)) out.push(candidate('existing-fixture', f.name, f.path));
  }

  // Components.
  for (const c of ctx.components ?? []) {
    if (matchesName(c.name)) out.push(candidate('existing-component', c.name, c.path));
  }

  return out;
}

/**
 * Locator candidates for a step, by family. Discovery enumerates the strategies
 * that *could* implement the interaction; it does not resolve or verify them
 * (that is grounding/selection later). Skipped for navigate/verify-only steps
 * where an interaction locator is not the right representation.
 */
export function discoverLocatorCandidates(
  step: string,
  intent: StepIntent,
): ImplementationCandidate[] {
  const out: ImplementationCandidate[] = [];
  // Only interaction steps (click/fill) have a control locator to represent.
  if (intent !== 'click' && intent !== 'fill') return out;

  const target = extractTarget(step) || 'element';
  const rolePattern = `/${target.replace(/\s+/g, '.*') || '.*'}/i`;

  // App Profile locator — the grounded selector from the crawled Application
  // Profile (highest-fidelity when present at generation time).
  out.push(candidate(
    'app-profile-locator',
    `App Profile selector for "${target}"`,
    'resolved against crawled DOM at generation time',
  ));

  // Accessibility locator — user-facing role/label.
  if (intent === 'click') {
    out.push(candidate('accessibility-locator', `getByRole('button', { name: ${rolePattern} })`, 'role+name'));
  } else {
    out.push(candidate('accessibility-locator', `getByLabel(${rolePattern})`, 'label'));
  }

  // DOM locator — raw fallback.
  out.push(candidate('dom-locator', `getByText(${rolePattern})`, 'text/css fallback'));

  return out;
}
