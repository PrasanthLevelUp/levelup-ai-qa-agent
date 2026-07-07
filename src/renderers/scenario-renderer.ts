/**
 * PHASE B — Renderer Abstraction
 *
 * The architectural shift from Phase A: one canonical Scenario Graph, projected
 * into different formats. No duplicate pipelines, no duplicate intelligence —
 * just pure data transformation.
 *
 * Before (duplicated pipelines):
 *   Requirement → Manual Writer → Manual Cases
 *   Requirement → Script Writer → Script Cases
 *   Requirement → BDD Writer   → BDD Cases
 *
 * After (one canonical source, multiple projections):
 *   Requirement → Scenario Graph → Canonical Scenario
 *                                        ↓
 *                    ┌──────────────────┼──────────────────┐
 *                    ↓                  ↓                  ↓
 *              ManualRenderer     ScriptRenderer     BDDRenderer
 *
 * Each renderer answers ONE question:
 *   "How should this same scenario appear for this consumer?"
 *
 * Nothing more. No intelligence. No LLM. No orchestration. Just projection.
 */

import type { FormatterTestCase } from '../engines/scenario-builder';

/**
 * Canonical scenario = the single source of truth. This is the output of the
 * Scenario Builder (Phase A): one object carrying business (steps) and technical
 * (grounding) projections. All renderers consume this.
 */
export type CanonicalScenario = FormatterTestCase;

/**
 * Renderer interface — pure projection of a canonical scenario into a
 * format-specific representation. Enforces the "Separate DATA, not PIPELINES"
 * principle: the same scenario is rendered differently per consumer.
 *
 * Contract:
 *   • Input: one CanonicalScenario (the builder's deterministic output)
 *   • Output: format-specific projection (ManualTestCase | ScriptTestCase | ...)
 *   • NO intelligence: renderers do NOT interpret, reason, or orchestrate
 *   • NO LLM calls: renderers do NOT call AI models
 *   • NO side effects: renderers do NOT persist, validate, or mutate state
 *
 * Renderers are PURE functions. They project data. That's all.
 */
export interface ScenarioRenderer<TOutput> {
  /**
   * Project the canonical scenario into the format this consumer expects.
   *
   * @param scenario - The canonical scenario from the builder (schemaVersion: 2)
   * @returns The projected representation for this consumer (e.g. manual QA,
   *          automation script, BDD feature, API sequence)
   */
  render(scenario: CanonicalScenario): TOutput;
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Output Shapes — what each renderer produces                              */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * Manual Test Case — what a human QA reads in the Test Case Lab UI.
 * Business-readable ONLY: no selectors, no DOM tokens, no automation anchors.
 */
export interface ManualTestCase {
  title: string;
  objective?: string;
  preconditions: string;
  /**
   * Business action steps — clean prose like "Enter the registered email address"
   * and "Click the Submit button". NO selectors, NO raw URLs (those live in
   * grounding, which is hidden from manual output).
   */
  steps: string[];
  /**
   * Observable expected result — a specific, checkable outcome the tester can
   * see (e.g. "The action succeeds and the user reaches the expected next state").
   * NOT "Observe and verify the outcome" (the generic filler from before Phase A).
   */
  expected: string;
  testData: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  severity: 'critical' | 'major' | 'minor' | 'trivial';
  tags: string[];
  riskArea?: string;
}

/**
 * Script Test Case — what the Script Generator consumes to produce Playwright code.
 * Technical grounding ONLY: selectors, pages, automation post-conditions.
 */
export interface ScriptTestCase {
  title: string;
  objective?: string;
  preconditions: string;
  /**
   * Per-step grounding: the technical anchors (selector / page / control) aligned
   * to the business steps by stepIndex. This is what Script-Gen reads to emit
   * Playwright locators and actions.
   */
  grounding: Array<{
    stepIndex: number;
    selector?: string;
    page?: string;
    control?: string;
  }>;
  /**
   * Business steps are kept as context (so Script-Gen can produce readable comments
   * in the emitted code), but the PRIMARY input is grounding.
   */
  steps: string[];
  /**
   * Technical expected result — the automation post-condition (selector/page to
   * assert), not the human-readable observable. Script-Gen emits a Playwright
   * `expect(page.locator(technical.selector)).toBeVisible()` from this.
   */
  expectedTechnical?: { selector?: string; page?: string };
  testData: string;
  tags: string[];
}

/**
 * BDD Feature — what the BDD export produces (Gherkin-style).
 * Business steps projected as Given/When/Then.
 */
export interface BDDTestCase {
  scenario: string;
  /**
   * Business steps projected as Gherkin statements. Renderers can infer
   * Given/When/Then from step semantics (navigation → Given, action → When,
   * expected → Then), or just emit all as "When" (simplest projection).
   */
  steps: Array<{ type: 'Given' | 'When' | 'Then'; text: string }>;
  /**
   * Expected outcome as a "Then" clause.
   */
  expected: string;
  tags: string[];
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Renderer Implementations — projection logic                              */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * Manual Renderer — projects the canonical scenario into the format the Test
 * Case Lab UI shows to human QA. Business projection ONLY: steps + observable
 * expected. Grounding is hidden.
 */
export class ManualRenderer implements ScenarioRenderer<ManualTestCase> {
  render(scenario: CanonicalScenario): ManualTestCase {
    // Schema migration: if a v1 scenario (no schemaVersion) arrives, treat it
    // as-is (legacy format, likely has selectors in steps). v2+ scenarios have
    // clean business steps.
    const isV2 = scenario.schemaVersion === 2;

    return {
      title: scenario.title,
      objective: scenario.objective,
      preconditions: scenario.preconditions,
      // Business steps — no selectors, no URLs (v2 guarantees this).
      steps: scenario.steps,
      // Observable expected result — what the tester SEES. This is the structured
      // `expected.observable` from Phase A, NOT the old generic "Observe and verify".
      expected: scenario.expected?.observable || scenario.expectedResult,
      testData: scenario.testData,
      priority: scenario.priority,
      severity: scenario.severity,
      tags: scenario.tags,
      riskArea: scenario.riskArea,
    };
  }
}

/**
 * Script Renderer — projects the canonical scenario into the format Script-Gen
 * consumes. Technical projection: grounding + technical expected. Business steps
 * are kept as context (for readable code comments).
 */
export class ScriptRenderer implements ScenarioRenderer<ScriptTestCase> {
  render(scenario: CanonicalScenario): ScriptTestCase {
    return {
      title: scenario.title,
      objective: scenario.objective,
      preconditions: scenario.preconditions,
      // Technical grounding: selectors, pages, controls. This is what Script-Gen
      // reads to emit Playwright `page.locator(selector)` calls.
      grounding: (scenario.grounding || []).map(g => ({
        stepIndex: g.stepIndex,
        selector: g.selector,
        page: g.page,
        control: g.control,
      })),
      // Business steps kept as context (Script-Gen emits them as comments in the
      // generated Playwright code for readability).
      steps: scenario.steps,
      // Technical expected: the automation anchor (selector/page to assert). Script-Gen
      // emits `expect(page.locator(technical.selector)).toBeVisible()` from this.
      expectedTechnical: scenario.expected?.technical,
      testData: scenario.testData,
      tags: scenario.tags,
    };
  }
}

/**
 * BDD Renderer — projects the canonical scenario into Gherkin-style format.
 * Business steps → Given/When/Then clauses. Simplest heuristic: navigation/
 * precondition → Given, action → When, expected → Then.
 */
export class BDDRenderer implements ScenarioRenderer<BDDTestCase> {
  render(scenario: CanonicalScenario): BDDTestCase {
    // Heuristic: first step that looks like navigation/setup → Given, rest → When.
    // Expected → Then. A more sophisticated renderer could infer from step semantics.
    const steps = scenario.steps.map((text, i) => {
      const lc = text.toLowerCase();
      if (i === 0 && (lc.includes('navigate') || lc.includes('open'))) {
        return { type: 'Given' as const, text };
      }
      return { type: 'When' as const, text };
    });

    // Expected → Then clause
    const expected = scenario.expected?.observable || scenario.expectedResult;

    return {
      scenario: scenario.title,
      steps,
      expected,
      tags: scenario.tags,
    };
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Renderer Registry — single point of access                               */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * Renderer factory — single point of access for all renderers. Consumers request
 * a renderer by format name; the factory returns the appropriate instance.
 *
 * Example:
 *   const manual = RendererRegistry.get('manual');
 *   const testCase = manual.render(canonicalScenario);
 */
export class RendererRegistry {
  private static readonly renderers = {
    manual: new ManualRenderer(),
    script: new ScriptRenderer(),
    bdd: new BDDRenderer(),
  };

  /**
   * Get a renderer by format name.
   *
   * @param format - 'manual' | 'script' | 'bdd' | (future: 'api', 'postman', ...)
   * @returns The renderer instance, or throws if format is unknown
   */
  static get(format: 'manual' | 'script' | 'bdd'): ScenarioRenderer<any> {
    const renderer = this.renderers[format];
    if (!renderer) {
      throw new Error(`Unknown renderer format: ${format}`);
    }
    return renderer;
  }

  /**
   * Render a canonical scenario into the requested format.
   *
   * @param scenario - The canonical scenario (from the builder)
   * @param format - Target format ('manual' | 'script' | 'bdd')
   * @returns The projected representation
   */
  static render<T>(scenario: CanonicalScenario, format: 'manual' | 'script' | 'bdd'): T {
    return this.get(format).render(scenario);
  }
}
