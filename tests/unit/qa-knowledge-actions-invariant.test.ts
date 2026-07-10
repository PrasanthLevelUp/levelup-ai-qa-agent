/**
 * Sprint 2D.3 — Action-template coverage RATCHET (the drift guard)
 *
 * The user's review flagged a "semantics for 14, actions for 3" drift risk:
 * scenarios accreting authored semantics while their executable action templates
 * lag behind, silently and forever. This suite makes that impossible to do
 * quietly. It pins four invariants:
 *
 *   (A) EXACT ratchet — the set of authentication scenarios WITHOUT an action
 *       template equals `AUTH_SCENARIOS_PENDING_ACTION_TEMPLATE` exactly. The
 *       list can only SHRINK: author a pending scenario and you MUST remove it
 *       here; add a new template-less auth scenario and you MUST document it
 *       here with a reason. No silent gaps, no silent regressions.
 *
 *   (B) LEGAL verbs only — every authored action uses a state-changing verb
 *       (navigate/fill/click/check/uncheck/select/upload). There is NO `verify`
 *       action; assertions are a separate concern (Sprint 2D.4).
 *
 *   (C) CANONICAL targets — every authored target is an app-neutral semantic key
 *       (`username`), never app vocabulary or a raw locator (no CSS chars).
 *
 *   (D) EXPANSION BLOCK — no OTHER module may author action templates until the
 *       authentication catalog reaches 100% (the pending list is empty).
 */

import {
  getBaselineScenarios,
  QA_KNOWLEDGE_BASE,
  AUTH_SCENARIOS_PENDING_ACTION_TEMPLATE,
  getScenarioActionTemplate,
} from '../../src/engines/qa-knowledge-engine';

const LEGAL_ACTIONS = new Set([
  'navigate', 'fill', 'click', 'check', 'uncheck', 'select', 'upload',
]);

// A canonical target is a lowercase snake/word key — never a CSS/XPath locator.
// These characters only appear in raw selectors, so their presence is a leak.
const LOCATOR_CHARS = /[.#\[\]>:()/\s]/;

describe('Sprint 2D.3 — action-template coverage ratchet', () => {
  const auth = getBaselineScenarios('authentication');

  // (A) EXACT ratchet
  it('(A) the template-less auth scenarios equal the documented pending list EXACTLY', () => {
    const missing = auth
      .filter((s) => !s.actionTemplate || s.actionTemplate.length === 0)
      .map((s) => s.id)
      .sort();
    const documented = Object.keys(AUTH_SCENARIOS_PENDING_ACTION_TEMPLATE).sort();
    expect(missing).toEqual(documented);
  });

  it('(A2) every documented pending id is a real authentication scenario (no stale entries)', () => {
    const ids = new Set(auth.map((s) => s.id));
    for (const id of Object.keys(AUTH_SCENARIOS_PENDING_ACTION_TEMPLATE)) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it('(A3) every pending entry carries a non-empty reason', () => {
    for (const [, reason] of Object.entries(AUTH_SCENARIOS_PENDING_ACTION_TEMPLATE)) {
      expect(typeof reason).toBe('string');
      expect(reason.trim().length).toBeGreaterThan(10);
    }
  });

  // (B) LEGAL verbs only + (C) CANONICAL targets
  it('(B/C) every authored auth template uses legal verbs and canonical targets', () => {
    const authored = auth.filter((s) => s.actionTemplate && s.actionTemplate.length > 0);
    // Sanity: we DO have authored templates (the ratchet is not vacuously green).
    expect(authored.length).toBeGreaterThan(0);
    for (const s of authored) {
      for (const a of s.actionTemplate!) {
        expect(LEGAL_ACTIONS.has(a.action)).toBe(true);      // (B) no `verify`
        expect(a.target).toBeTruthy();
        expect(LOCATOR_CHARS.test(a.target)).toBe(false);    // (C) canonical, app-neutral
      }
    }
  });

  it('(B2) getScenarioActionTemplate never returns a `verify` action', () => {
    for (const s of auth) {
      const tmpl = getScenarioActionTemplate(s);
      if (!tmpl) continue;
      expect(tmpl.every((a) => (a.action as string) !== 'verify')).toBe(true);
    }
  });

  // (D) EXPANSION BLOCK
  it('(D) no NON-authentication module authors action templates until auth is 100%', () => {
    const authComplete = Object.keys(AUTH_SCENARIOS_PENDING_ACTION_TEMPLATE).length === 0;
    if (authComplete) return; // once auth reaches 100%, other modules may begin.
    for (const [category, scenarios] of Object.entries(QA_KNOWLEDGE_BASE)) {
      if (category === 'authentication') continue;
      const leaked = scenarios
        .filter((s) => s.actionTemplate && s.actionTemplate.length > 0)
        .map((s) => `${category}/${s.id}`);
      expect(leaked).toEqual([]);
    }
  });
});
