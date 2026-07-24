/**
 * CANONICAL → MANUAL RENDERER  (Canonical Rendering sprint, Phase 1)
 * ===========================================================================
 * The MANUAL projection of the one canonical business journey. Its sibling is
 * Script Gen's emitter: both read the SAME `ScenarioAction[]` / `ScenarioAssertion[]`
 * the graph carries and render two faces of it —
 *
 *      ScenarioAction[]  ──▶  emitGraphActionLines()    ──▶  Playwright code
 *                        └─▶  renderManualSteps()       ──▶  human Steps
 *      ScenarioAssertion[] ▶  emitGraphAssertionLines() ──▶  expect(...)
 *                        └─▶  renderManualExpected()     ──▶  human Expected Result
 *
 * This module NEVER guesses. It only renders what the KB authored: it does not
 * pick a form, fire a CRUD template, or infer intent from the title. When a node
 * carries no authored actions the caller does not invoke this renderer at all
 * (it keeps the legacy prose) — so this file changes NOTHING for any capability
 * that has not yet been authored.
 *
 * GROUNDING: canonical targets (`sort_dropdown`, `product_list`) are humanized
 * app-neutrally (underscores → spaces). This renderer deliberately does NOT
 * fabricate selectors or app-specific labels — a manual tester reads the
 * business element name, and Script Gen (not this file) grounds the same target
 * to a real locator. `@dataset.*` values resolve against the node's resolved
 * dataset when present, else degrade to a readable field name — never invented.
 *
 * Pure and deterministic: identical inputs ⇒ identical output.
 */

import type { ScenarioAction, ScenarioAssertion } from './scenario-graph';

/** Masked/real resolved dataset values a node may carry, keyed by field. */
export type ResolvedValues = Record<string, string | number | boolean> | undefined;

/* ------------------------------------------------------------------ */
/*  Humanization helpers (app-neutral, deterministic)                  */
/* ------------------------------------------------------------------ */

/** `sort_dropdown` → `sort dropdown`. Canonical target → human element phrase. */
function humanizeTarget(target: string): string {
  return target
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const DATASET_PREFIX = '@dataset.';

/**
 * Render an action's `value` for a HUMAN. A literal is quoted; a `@dataset.*`
 * reference resolves to the concrete record value when available, else degrades
 * to the readable field name (e.g. "the username value") — never invented.
 */
function renderValuePhrase(value: string | undefined, resolved: ResolvedValues): string {
  if (value === undefined || value === '') return '';
  if (value.startsWith(DATASET_PREFIX)) {
    const field = value.slice(DATASET_PREFIX.length).trim();
    const hit = resolved?.[field];
    if (hit !== undefined && hit !== null && String(hit).length > 0) {
      return `"${String(hit)}"`;
    }
    return `the ${humanizeTarget(field)} value`;
  }
  return `"${value}"`;
}

/* ------------------------------------------------------------------ */
/*  Steps  (ScenarioAction[] → string[])                               */
/* ------------------------------------------------------------------ */

/**
 * Derive a manual step sentence from a canonical action. This renderer OWNS the
 * wording — the canonical model carries no prose. Deterministic verb → phrasing
 * map; QA-standard action verbs ("Open …", "Enter …", "Click …", "Select …",
 * "Upload …"). A different renderer (BDD, German, executive) would map the same
 * verbs to its own wording without touching the model.
 */
function deriveStep(action: ScenarioAction, resolved: ResolvedValues): string {
  const el = humanizeTarget(action.target);
  const valuePhrase = renderValuePhrase(action.value, resolved);
  switch (action.action) {
    case 'navigate':
      return `Open the ${/\bpage\b/.test(el) ? el : `${el} page`}`;
    case 'fill':
      return valuePhrase
        ? `Enter ${valuePhrase} in the ${el} field`
        : `Enter a value in the ${el} field`;
    case 'select':
      return valuePhrase
        ? `In the ${el}, select the ${valuePhrase} option`
        : `Select an option in the ${el}`;
    case 'click':
      return `Click the ${el}`;
    case 'check':
      return `Tick the ${el} checkbox`;
    case 'uncheck':
      return `Clear the ${el} checkbox`;
    case 'upload':
      return valuePhrase
        ? `Upload ${valuePhrase} for the ${el}`
        : `Upload a file for the ${el}`;
    default:
      return `Perform "${action.action}" on the ${el}`;
  }
}

/**
 * Render the canonical action list into ordered manual Steps. All wording is
 * derived here from the semantic action (the model stores no prose). Actions are
 * rendered in `order` (defensive sort — identity lives in `id`, sequence in
 * `order`).
 */
export function renderManualSteps(
  actions: readonly ScenarioAction[],
  resolved?: ResolvedValues,
): string[] {
  return [...actions]
    .sort((a, b) => a.order - b.order)
    .map((a) => deriveStep(a, resolved));
}

/* ------------------------------------------------------------------ */
/*  Expected Result  (ScenarioAssertion[] → checklist string)          */
/* ------------------------------------------------------------------ */

/**
 * Derive an Expected-Result sentence from a canonical assertion. This renderer
 * OWNS the wording — the canonical model carries no prose. Covers the full
 * assertion vocabulary INCLUDING the first-class `ordered` primitive, whose
 * semantic fields (`collection`/`direction`/`orderBy`) are turned into a human
 * ordering sentence here (a BDD/automation/RTM renderer turns the SAME fields
 * into its own form).
 */
function deriveAssertion(a: ScenarioAssertion): string {
  const el = a.target ? humanizeTarget(a.target) : 'the page';
  const exp = a.expected;
  switch (a.type) {
    case 'url':
      return exp !== undefined ? `The page navigates to ${String(exp)}.` : 'The page navigates as expected.';
    case 'visible':
      return `The ${el} is displayed.`;
    case 'hidden':
      return `The ${el} is not displayed.`;
    case 'enabled':
      return `The ${el} is enabled.`;
    case 'disabled':
      return `The ${el} is disabled.`;
    case 'checked':
      return `The ${el} is selected.`;
    case 'unchecked':
      return `The ${el} is not selected.`;
    case 'text':
      return exp !== undefined ? `The ${el} shows "${String(exp)}".` : `The ${el} shows the expected message.`;
    case 'value':
      return exp !== undefined ? `The ${el} holds the value "${String(exp)}".` : `The ${el} holds the expected value.`;
    case 'count':
      return exp !== undefined ? `The ${el} count is ${String(exp)}.` : `The ${el} count matches.`;
    case 'attribute':
      return exp !== undefined ? `The ${el} has ${String(exp)}.` : `The ${el} has the expected attribute.`;
    case 'ordered':
      return deriveOrdered(a);
    default:
      return `The ${el} meets the expected condition.`;
  }
}

/**
 * Human ordering sentence from the semantic `ordered` fields. `collection` names
 * what is ordered (falls back to `target`), `direction` gives ascending/
 * descending, and the optional `orderBy` gives the dimension. Nothing here is
 * stored in the model — it is derived, so other renderers phrase it their way.
 */
function deriveOrdered(a: ScenarioAssertion): string {
  const collection = humanizeTarget(a.collection ?? a.target ?? 'items');
  const direction = a.direction === 'descending' ? 'descending' : 'ascending';
  const by = a.orderBy ? ` by ${humanizeTarget(a.orderBy)}` : '';
  return `The ${collection} are displayed in ${direction} order${by}.`;
}

/** One expected-result line per assertion, all wording derived here. */
export function renderManualExpectedLines(assertions: readonly ScenarioAssertion[]): string[] {
  return [...assertions]
    .sort((a, b) => a.order - b.order)
    .map((a) => deriveAssertion(a));
}

/**
 * Render the canonical assertion list into the checklist Expected-Result string,
 * matching the existing `StructuredExpected.observable` convention (each line
 * prefixed with `✓`, newline-joined) so every downstream consumer (formatter,
 * xlsx/CSV render) is unchanged.
 */
export function renderManualExpected(assertions: readonly ScenarioAssertion[]): string {
  return renderManualExpectedLines(assertions).map((l) => `✓ ${l}`).join('\n');
}

/* ------------------------------------------------------------------ */
/*  Test Data  (ScenarioAction[] → readable line)                      */
/* ------------------------------------------------------------------ */

/**
 * Render the visible Test-Data line from the canonical actions' input values.
 * Only value-bearing actions (`fill`/`select`/`upload`) contribute. `@dataset.*`
 * values resolve against the node record when present. Returns a UI-only note
 * when the journey takes no data input, so the column is never misleadingly blank.
 */
export function renderManualTestData(
  actions: readonly ScenarioAction[],
  resolved?: ResolvedValues,
): string {
  const parts: string[] = [];
  for (const a of [...actions].sort((x, y) => x.order - y.order)) {
    if (a.value === undefined || a.value === '') continue;
    const label = humanizeTarget(a.target);
    if (a.value.startsWith(DATASET_PREFIX)) {
      const field = a.value.slice(DATASET_PREFIX.length).trim();
      const hit = resolved?.[field];
      parts.push(hit !== undefined && hit !== null && String(hit).length > 0
        ? `${label}: ${String(hit)}`
        : `${label}: @dataset.${field}`);
    } else {
      parts.push(`${label}: ${a.value}`);
    }
  }
  return parts.length > 0
    ? parts.join(' · ')
    : 'No test data required — UI interaction only.';
}

/* ------------------------------------------------------------------ */
/*  Convenience: full manual projection of one node's canonical body   */
/* ------------------------------------------------------------------ */

export interface ManualRender {
  steps: string[];
  expectedResult: string;
  testData: string;
}

/**
 * Render all three manual columns from a node's canonical actions + assertions.
 * The caller invokes this ONLY when `actions.length > 0` (authored capability);
 * otherwise it keeps the legacy prose, guaranteeing zero regression elsewhere.
 */
export function renderManualFromCanonical(
  actions: readonly ScenarioAction[],
  assertions: readonly ScenarioAssertion[],
  resolved?: ResolvedValues,
): ManualRender {
  return {
    steps: renderManualSteps(actions, resolved),
    expectedResult: renderManualExpected(assertions),
    testData: renderManualTestData(actions, resolved),
  };
}
