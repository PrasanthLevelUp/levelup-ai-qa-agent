/**
 * Sprint 2D.4 — Assertion-template coverage RATCHET (the drift guard)
 *
 * The mirror of the 2D.3 action ratchet, one concern over: the Knowledge Base —
 * NOT a prose `expectedResult` parser — is the authority on what a valid login,
 * a rejected login, or a logout PROVES. This suite makes that authority
 * enforceable and keeps it from drifting.
 *
 * Assertions are EASIER to author than actions (they carry no ordering coupling
 * to the DOM), so the sprint authored them to 100% for authentication up front —
 * there is deliberately NO pending list here (unlike 2D.3's actions). The
 * invariants pinned:
 *
 *   (A) FULL coverage — EVERY authentication scenario has a non-empty authored
 *       assertion template. No scenario may prove "nothing"; a template-less auth
 *       scenario is a regression that fails here loudly.
 *
 *   (B) FROZEN grammar — every authored `type` is one of the 11 frozen
 *       AssertionType values. New types are a contract change, not a quiet edit.
 *
 *   (C) CANONICAL targets — every authored target is an app-neutral semantic key
 *       (`login_error`, `authenticated_landing`), never app vocabulary or a raw
 *       locator (no CSS/XPath chars). The graph stays application-neutral.
 *
 *   (D) SYMBOLIC references stay symbolic — every `@page.*` / `@messages.*`
 *       reference is well-formed (`@page.<word>` / `@messages.<word>`) and no
 *       authored `expected` leaks a concrete URL, `expect(...)`, or app copy. The
 *       Execution Resolver grounds these downstream; the KB never does.
 *
 *   (E) EXPANSION BLOCK — no OTHER module may author assertion templates until
 *       the authentication catalog is authored (mirrors the action ratchet).
 */

import {
  getBaselineScenarios,
  QA_KNOWLEDGE_BASE,
  getScenarioAssertionTemplate,
  getScenarioActionTemplate,
} from '../../src/engines/qa-knowledge-engine';
import {
  materializeAssertionTemplate,
  materializeActionTemplate,
} from '../../src/graph/scenario-graph-builder';

// The FROZEN assertion grammar (Sprint 2D.4). Adding a type here is a deliberate
// contract change — mirror it in `AssertionType` (graph + KB) and the renderer.
const FROZEN_TYPES = new Set([
  'url', 'visible', 'hidden', 'enabled', 'disabled',
  'checked', 'unchecked', 'text', 'value', 'count', 'attribute',
]);

// A canonical target is a lowercase snake/word key — never a CSS/XPath locator.
// These characters only appear in raw selectors, so their presence is a leak.
const LOCATOR_CHARS = /[.#\[\]>:()\s]/;

// A well-formed semantic reference: `@page.<word>` or `@messages.<word>`.
const PAGE_REF = /^@page\.[a-z][a-z0-9_]*$/;
const MSG_REF = /^@messages\.[a-z][a-z0-9_]*$/;

describe('Sprint 2D.4 — assertion-template coverage ratchet', () => {
  const auth = getBaselineScenarios('authentication');

  // (A) FULL coverage — every auth scenario proves SOMETHING.
  it('(A) every authentication scenario has a non-empty authored assertion template', () => {
    // Sanity: the catalog is not empty (the ratchet is not vacuously green).
    expect(auth.length).toBeGreaterThan(0);
    const missing = auth
      .filter((s) => !s.assertionTemplate || s.assertionTemplate.length === 0)
      .map((s) => s.id)
      .sort();
    expect(missing).toEqual([]);
  });

  // (B) FROZEN grammar
  it('(B) every authored assertion type is one of the 11 frozen AssertionType values', () => {
    for (const s of auth) {
      for (const a of s.assertionTemplate ?? []) {
        expect(FROZEN_TYPES.has(a.type)).toBe(true);
      }
    }
  });

  // (C) CANONICAL targets — app-neutral, no locator leak.
  it('(C) every authored assertion target is a canonical, app-neutral key (no locator)', () => {
    for (const s of auth) {
      for (const a of s.assertionTemplate ?? []) {
        if (a.target === undefined) continue; // page-level checks (url) carry none
        expect(a.target.length).toBeGreaterThan(0);
        expect(LOCATOR_CHARS.test(a.target)).toBe(false);
      }
    }
  });

  // (D) SYMBOLIC references stay symbolic; no grounded value leaks into the KB.
  it('(D) `@page.*` / `@messages.*` references are well-formed and no expected leaks a grounded value', () => {
    for (const s of auth) {
      for (const a of s.assertionTemplate ?? []) {
        if (a.expected === undefined) continue;
        const raw = String(a.expected);
        if (raw.startsWith('@page.')) {
          expect(PAGE_REF.test(raw)).toBe(true);
        } else if (raw.startsWith('@messages.')) {
          expect(MSG_REF.test(raw)).toBe(true);
        }
        // No authored expected may carry a concrete URL, a Playwright matcher,
        // or a raw regex — grounding is the resolver's job, never the KB's.
        expect(raw).not.toMatch(/^https?:\/\//);
        expect(raw).not.toContain('expect(');
        expect(raw).not.toContain('toHaveURL');
      }
    }
  });

  it('(D2) at least one scenario uses each reference kind (the refs are actually exercised)', () => {
    const all = auth.flatMap((s) => s.assertionTemplate ?? []);
    const expecteds = all.map((a) => String(a.expected ?? ''));
    expect(expecteds.some((e) => e.startsWith('@page.'))).toBe(true);
    expect(expecteds.some((e) => e.startsWith('@messages.'))).toBe(true);
  });

  // getScenarioAssertionTemplate — authored-wins lookup, never invents.
  it('getScenarioAssertionTemplate returns the AUTHORED template for every auth scenario', () => {
    for (const s of auth) {
      const tmpl = getScenarioAssertionTemplate(s);
      expect(tmpl).not.toBeNull();
      expect(tmpl).toBe(s.assertionTemplate); // same reference — a pure lookup, no copy/derive
    }
  });

  // Stable semantic ids — durable references for Coverage / Healing / Replay.
  it('every authored auth scenario materializes to UNIQUE, position-independent ids', () => {
    for (const s of auth) {
      const tmpl = s.assertionTemplate;
      if (!tmpl || tmpl.length === 0) continue;
      const ids = materializeAssertionTemplate(s.id, tmpl).map((a) => a.id);
      // Unique within the scenario (Coverage/Healing key on these).
      expect(new Set(ids).size).toBe(ids.length);
      // Semantic, namespaced by scenario — never a bare array index.
      for (const id of ids) {
        expect(id.startsWith(`${s.id}.`)).toBe(true);
        expect(id).not.toMatch(/:a:\d+$/); // the old position-based scheme is gone
      }
    }
  });

  // (F) afterAction INTEGRITY — every authored reference is the EXACT id of a
  //     REAL action in the SAME scenario (never a dangling ref, never a position).
  //     afterAction IS an action.id, so the join is a plain `a.id === afterAction`
  //     with no slug/derivation. This is the guarantee Replay / Healing / the
  //     timeline rely on: "which step produced this assertion?" always resolves.
  it('(F) every authored assertion.afterAction equals exactly one action id in its scenario', () => {
    const dangling: string[] = [];
    for (const s of auth) {
      const assertions = s.assertionTemplate ?? [];
      const actionTmpl = getScenarioActionTemplate(s);
      const actionIds = actionTmpl
        ? materializeActionTemplate(s.id, actionTmpl).map((act) => act.id)
        : [];
      for (const a of assertions) {
        if (a.afterAction === undefined) continue;
        const hits = actionIds.filter((id) => id === a.afterAction);
        // A reference MUST match exactly one action id. If the scenario has no
        // action template at all, any afterAction is dangling by definition.
        if (hits.length !== 1) dangling.push(`${s.id}: '${a.afterAction}' matched ${hits.length} action(s)`);
      }
    }
    expect(dangling).toEqual([]);
  });

  it('(F2) afterAction is only authored where an actionTemplate exists to reference', () => {
    const orphaned = auth
      .filter((s) => (s.assertionTemplate ?? []).some((a) => a.afterAction !== undefined))
      .filter((s) => !getScenarioActionTemplate(s))
      .map((s) => s.id);
    expect(orphaned).toEqual([]);
  });

  it('(F3) every scenario that authors BOTH actions and assertions links each assertion to a step', () => {
    // Where the KB owns the full flow (actions + assertions), each check should
    // declare the step it follows — otherwise the execution-timeline story has a
    // gap. This ratchets the four fully-authored login scenarios to 100% linkage.
    for (const s of auth) {
      const assertions = s.assertionTemplate ?? [];
      if (assertions.length === 0 || !getScenarioActionTemplate(s)) continue;
      for (const a of assertions) {
        expect(typeof a.afterAction).toBe('string');
      }
    }
  });

  // (E) EXPANSION BLOCK — assertions land module-by-module, authentication first.
  it('(E) no NON-authentication module authors assertion templates yet', () => {
    for (const [category, scenarios] of Object.entries(QA_KNOWLEDGE_BASE)) {
      if (category === 'authentication') continue;
      const leaked = scenarios
        .filter((s) => s.assertionTemplate && s.assertionTemplate.length > 0)
        .map((s) => `${category}/${s.id}`);
      expect(leaked).toEqual([]);
    }
  });
});
