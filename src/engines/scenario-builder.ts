/**
 * Deterministic Scenario Builder — the "assemble, don't invent" stage.
 * ============================================================================
 *
 * This is Phase 2 of the QA-first architecture. The pipeline is:
 *
 *     Requirement → Planner → (Scenario plan) → Retriever → (scoped context)
 *                 → Deterministic Scenario Builder → DRAFT test cases
 *                 → LLM (wording only) → Output
 *
 * The platform ALREADY knows, deterministically, most of what a login test
 * needs: the login page + URL, the email/password fields and their REAL
 * selectors, the submit button, the auth module, the business rule, and the
 * valid-user dataset. Asking the LLM to re-discover all of that from scratch is
 * wasteful AND non-deterministic (it under-generates — 5 weak scenarios — and
 * varies run to run). So instead of inventing, this builder ASSEMBLES a concrete
 * draft test case for every planned scenario, grounded in the retrieved App
 * Profile (real selectors) and Test Data (real datasets). The LLM then only
 * REFINES the wording.
 *
 * ARCHITECTURAL BOUNDARY — the builder is a PURE TRANSFORM, never a decider.
 * The Scenario Planner is the SINGLE SOURCE OF TRUTH for whether a business
 * scenario exists; every scenario it emits already carries a justification
 * (`provenance: { whyExists, source, derivedFrom, evidence[] }`). The builder
 * treats that plan as IMMUTABLE: it emits exactly one draft per planned
 * scenario, enriching it with real selectors/URLs/datasets, and NEVER creates,
 * drops, gates, or second-guesses a scenario. The old keyword-gated
 * "conditional" emission lived here; it has been removed — existence is now
 * decided (and provenance-justified) upstream in the planner.
 *
 * Design guarantees (same discipline as the planner/optimizer):
 *   • Pure & synchronous — no I/O, no LLM, no randomness. Deterministic output.
 *   • Fail-open — if no App Profile/Test Data is available a draft is still
 *     produced from the scenario objective; the builder NEVER throws and always
 *     emits exactly one draft per planned scenario.
 *   • Grounded — steps reference REAL selectors/URLs/datasets when present. The
 *     `grounded` flag records WHETHER a real selector was used; this is a
 *     SEPARATE axis from `source`, which relays the planner's evidence source.
 *   • Provenance-preserving — each draft carries the planner's provenance
 *     verbatim; `source` is the slug of `provenance.source`, not a grounding
 *     echo.
 */

import type { QACategory } from './qa-knowledge-engine';
import type {
  PlannedScenarioWithProvenance,
  ProvenanceSource,
  ScenarioPlan,
  ScenarioProvenance,
} from './scenario-planner';

/**
 * Slug map: planner evidence source → the draft's `source` tag. This keeps the
 * draft `source` a faithful relay of WHY the planner justified the scenario
 * (its evidence source), rather than the old grounding echo ('app_profile' when
 * a selector happened to be found). Grounding is tracked separately.
 */
const PROVENANCE_SOURCE_SLUG: Record<ProvenanceSource, DraftTestCase['source']> = {
  Requirement: 'requirement',
  'Acceptance Criteria': 'acceptance_criteria',
  'App Knowledge': 'app_knowledge',
  'Test Data': 'test_data',
};

/* ------------------------------------------------------------------ */
/*  Loose structural shapes (decoupled from the engine types)          */
/* ------------------------------------------------------------------ */

interface FieldLike { name?: string; type?: string; required?: boolean; selector?: string; label?: string }
interface FormLike { page?: string; action?: string; method?: string; fields?: FieldLike[]; submitSelector?: string; submitLabel?: string }
interface ElementLike { label?: string; tag?: string; selector?: string; role?: string }
interface PageLike { url?: string; title?: string; pageType?: string }
interface ProfileLike {
  baseUrl?: string; name?: string; loginUrl?: string; username?: string;
  pages?: PageLike[]; forms?: FormLike[]; keyElements?: ElementLike[];
}
interface DatasetLike { name?: string; environment?: string; recordCount?: number; sampleKeys?: string[] }
interface KnowledgeLike { applicationProfile?: ProfileLike; testData?: DatasetLike[]; [k: string]: any }
interface RequirementLike { title?: string; description?: string; acceptanceCriteria?: string; businessFlow?: string }

/**
 * Per-step GROUNDING — the technical anchor for ONE step, kept OUT of the visible
 * step text. This is the heart of the "Separate DATA, not PIPELINES" model: the
 * step string stays business-readable ("Enter the registered email address")
 * while the implementation metadata lives here, hidden from the Manual Test
 * Case UI and consumed only by the Script/Automation renderer.
 *
 * Same scenario → different fields → different renderers. No duplicate pipeline,
 * no duplicate intelligence, no selector clutter in manual output.
 *
 * **EXTENSIBILITY**: Grounding is not just selectors. This structure is designed
 * to evolve as Healing and Script Generation mature. Future fields:
 *   • `role` / `ariaLabel` — accessibility anchors (WAI-ARIA)
 *   • `locator` — Playwright locator string
 *   • `domFingerprint` — structural DOM signature for healing resilience
 *   • `visualAnchor` — coordinate/image hash for visual regression
 *   • `repoIntelligence` — component/file location from repository analysis
 * The name "grounding" (not "selectors") future-proofs this for all forms of
 * technical anchoring. Renderers consume only the fields they need; the rest
 * pass through as opaque metadata.
 */
export interface StepGrounding {
  /** 1-based index of the step this grounding anchors (aligns with steps[]). */
  stepIndex: number;
  /** Real selector from the App Profile (e.g. "#email"), when one applies. */
  selector?: string;
  /** Page/URL the step acts on, when known. */
  page?: string;
  /** Human control label the step refers to (e.g. "Email"), for renderers. */
  control?: string;
  // Future: role, locator, domFingerprint, visualAnchor, repoIntelligence
}

/**
 * A STRUCTURED expected result — one datum with three projections so each
 * renderer shows the right thing (the audit's "generic expected result" fix,
 * done via data shape, not a new interpretation engine):
 *   • observable — what a manual tester SEES (Manual UI shows this).
 *   • business   — the business meaning/state it proves.
 *   • technical  — the automation anchor (selector/page to assert). Hidden from manual.
 *
 * `expectedResult: string` (below) is kept as a mirror of `observable` for
 * backward compatibility with every existing consumer/DB column.
 */
export interface StructuredExpected {
  observable: string;
  business?: string;
  technical?: { selector?: string; page?: string };
}

/**
 * A deterministically-assembled draft test case. Mirrors the engine's TestCase
 * shape closely so the LLM's job is to REFINE fields, not restructure. Kept as
 * its own type so the builder stays decoupled and unit-testable in isolation.
 *
 * **SCHEMA VERSION 2**: Canonical representation — one scenario carries business
 * (steps) and technical (grounding) projections; renderers project it per surface.
 * Future schema evolution (v3, v4, …) will use this field for safe migrations.
 */
export interface DraftTestCase {
  /**
   * Schema version of the canonical scenario representation. Increment when the
   * shape of steps/grounding/expected evolves. Renderers check this to apply
   * migrations or format-specific logic.
   */
  schemaVersion: 2;
  /** 0-based index of the planned scenario this draft expands. */
  scenarioIndex: number;
  /**
   * Stable canonical id, inherited from the KB PlannedScenario.id (e.g.
   * "auth-sec-injection"). Unlike scenarioIndex (a positional pointer), this is
   * a durable identity for the scenario — it survives reordering, lets the
   * validator assert uniqueness, and is what the formatter round-trips so the
   * LLM can never silently re-map a case onto the wrong logic.
   */
  scenarioId: string;
  title: string;
  objective: string;
  coverageType: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  riskArea: string;
  preconditions: string;
  /** Business-readable action steps — NO selectors/DOM tokens (Manual UI shows these). */
  steps: string[];
  /**
   * Per-step technical grounding (selector/page), aligned to `steps` by
   * `stepIndex`. Hidden from manual output; consumed by the Script renderer.
   * This is where selectors live now — never inside the step text.
   */
  grounding: StepGrounding[];
  /** Backward-compatible observable expected result (mirrors `expected.observable`). */
  expectedResult: string;
  /** Structured expected result (observable / business / technical projections). */
  expected: StructuredExpected;
  testData: string;
  tags: string[];
  automationReady: boolean;
  selectorAvailability: 'high' | 'medium' | 'low' | 'unknown';
  /**
   * Provenance slug, derived from the PLANNER's authoritative provenance (see
   * `provenance` below). 'knowledge' / 'app_profile' are retained only for
   * backward compatibility with cases reconstructed from older DB rows.
   */
  source: 'requirement' | 'acceptance_criteria' | 'app_knowledge' | 'test_data' | 'knowledge' | 'app_profile';
  sourceEvidence: string;
  /**
   * The planner's authoritative provenance for this scenario ({ whyExists,
   * source, derivedFrom, evidence[] }). The builder does NOT compute this — it
   * carries through whatever the Scenario Planner decided. The builder never
   * decides whether a scenario exists.
   */
  provenance: ScenarioProvenance;
  /** True when the draft used at least one REAL selector from the App Profile. */
  grounded: boolean;
}

export interface BuildDraftsResult {
  drafts: DraftTestCase[];
  /** How many drafts were grounded in real selectors (analytics). */
  groundedCount: number;
}

/**
 * A finished scenario summary, structurally identical to the engine's
 * TestScenario. Derived DETERMINISTICALLY from the drafts — the LLM never has to
 * produce the scenarios array.
 */
export interface FormatterScenario {
  scenario: string;
  objective: string;
  coverageType: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  riskArea: string;
}

/**
 * A finished test case, structurally identical to the engine's TestCase (plus
 * scenarioIndex). This is the DETERMINISTIC output of the builder — it is both
 * (a) the payload the LLM is asked to merely re-word, and (b) the guaranteed
 * fallback if the LLM formatter fails or drops cases. Either way coverage is
 * fixed by the builder, not the model.
 *
 * **SCHEMA VERSION 2**: Canonical representation. Increment for future evolution.
 */
export interface FormatterTestCase {
  /**
   * Schema version of the canonical scenario. Renderers check this for migrations.
   * Optional for backward-compat (legacy/hand-built cases); draftToTestCase always sets it.
   */
  schemaVersion?: 2;
  title: string;
  objective: string;
  scenarioIndex: number;
  /** Stable canonical id (from the KB scenario) — see DraftTestCase.scenarioId. */
  scenarioId: string;
  riskArea: string;
  preconditions: string;
  /** Business-readable action steps — NO selectors/DOM tokens (Manual UI shows these). */
  steps: string[];
  /**
   * Per-step technical grounding (selector/page), aligned to `steps`. Hidden
   * from manual output; consumed by the Script renderer. Selectors live here,
   * never in the step text. Optional so hand-built/legacy cases still typecheck;
   * `draftToTestCase` always populates it.
   */
  grounding?: StepGrounding[];
  /** Backward-compatible observable expected result (mirrors `expected.observable`). */
  expectedResult: string;
  /**
   * Structured expected result (observable / business / technical projections).
   * Optional for the same back-compat reason as `grounding`.
   */
  expected?: StructuredExpected;
  testData: string;
  /**
   * Real selectors this case is grounded in, derived DETERMINISTICALLY from the
   * per-step `grounding` (no longer re-parsed from prose). Surfaced as a typed
   * field so the Validator can assert every selector is real BEFORE the LLM is
   * ever called, and so traceability does not depend on step wording.
   */
  selectors: string[];
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  severity: 'critical' | 'major' | 'minor' | 'trivial';
  tags: string[];
  automationReady: boolean;
  automationComplexity: 'low' | 'medium' | 'high';
  selectorAvailability: 'high' | 'medium' | 'low' | 'unknown';
  source: 'requirement' | 'acceptance_criteria' | 'app_knowledge' | 'test_data' | 'knowledge' | 'app_profile';
  sourceEvidence: string;
  /** Planner provenance carried through for explainability (optional: absent on
   * cases reconstructed from older DB rows). */
  provenance?: ScenarioProvenance;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const lc = (s?: string) => (s || '').toLowerCase();

/**
 * Extract the selector tokens the steps reference — the parenthesised tokens
 * that look like CSS/XPath/attribute selectors (start with # . [ / or contain
 * "="). Pure and deterministic; used to expose a typed `selectors` field so the
 * Validator can check them against the App Profile without re-parsing prose.
 */
function extractSelectors(steps: string[]): string[] {
  const out = new Set<string>();
  const paren = /\(([^)]+)\)/g;
  for (const step of steps) {
    let m: RegExpExecArray | null;
    while ((m = paren.exec(step)) !== null) {
      const tok = m[1].trim();
      if (/^[#.\[/]/.test(tok) || tok.includes('=') || /^[a-z]+\[/.test(tok)) out.add(tok);
    }
  }
  return Array.from(out);
}

/**
 * Score how well a form matches a scenario/category (distinct term hits over the
 * form's page + field names/labels). Used to pick the primary interaction form.
 */
function scoreForm(form: FormLike, terms: string[]): number {
  const text = [
    lc(form.page), lc(form.action),
    ...(form.fields || []).flatMap(f => [lc(f.name), lc(f.label), lc(f.type)]),
  ].join(' ');
  let score = 0;
  for (const t of terms) if (t && text.includes(t)) score += 1;
  return score;
}

/** Tokenise to distinct lowercase terms (>=3 chars). */
function toTerms(s: string): string[] {
  return Array.from(new Set(lc(s).split(/[^a-z0-9]+/).filter(t => t.length >= 3)));
}

/**
 * Pick the primary form for a scenario: the highest-scoring form against the
 * scenario terms; ties and no-match fall back to the first retrieved form
 * (retrieval already scoped forms to the plan, so index 0 is a safe default).
 */
function pickForm(forms: FormLike[] | undefined, terms: string[]): FormLike | undefined {
  if (!forms?.length) return undefined;
  let best = forms[0];
  let bestScore = scoreForm(forms[0], terms);
  for (let i = 1; i < forms.length; i++) {
    const s = scoreForm(forms[i], terms);
    if (s > bestScore) { best = forms[i]; bestScore = s; }
  }
  return best;
}

/** Pick the most relevant dataset for a scenario (term match, else first). */
function pickDataset(datasets: DatasetLike[] | undefined, terms: string[]): DatasetLike | undefined {
  if (!datasets?.length) return undefined;
  let best = datasets[0];
  let bestScore = -1;
  for (const d of datasets) {
    const text = [lc(d.name), ...(d.sampleKeys || []).map(lc)].join(' ');
    let score = 0;
    for (const t of terms) if (t && text.includes(t)) score += 1;
    if (score > bestScore) { best = d; bestScore = score; }
  }
  return best;
}

/**
 * Describe the DATA a step should use for a given coverage type. Deterministic,
 * high-level phrasing — the LLM refines the exact value. The point is to encode
 * the QA INTENT of the coverage type (valid vs invalid vs empty vs malicious) so
 * the model does not collapse every scenario into a happy path.
 */
function dataPhraseFor(coverageType: string, field: FieldLike): string {
  const label = field.label || field.name || 'value';
  switch (coverageType) {
    case 'negative':
      return `an invalid ${label}`;
    case 'edge_cases':
      return `a boundary/edge ${label} (empty, whitespace, or unusual case)`;
    case 'boundary':
      return `a boundary-length ${label} (at, below and above the limit)`;
    case 'security':
      return `a malicious ${label} (e.g. an injection/script string)`;
    case 'role_based':
      return `a ${label} for a user WITHOUT the required role`;
    default: // positive, integration, performance, …
      return `a valid ${label}`;
  }
}

/**
 * Build a STRUCTURED expected result for a scenario. Replaces the old
 * "expectedResult = scenario.objective" (which produced generic, intent-only
 * results). We split ONE outcome into:
 *   • observable — a concrete, user-visible result a manual tester can check,
 *                  shaped by the coverage type (success vs rejection vs error);
 *   • business   — the meaning/state it proves (the scenario objective);
 *   • technical  — the automation anchor (a post-condition selector/page) when
 *                  the App Profile gives us one.
 *
 * Deterministic and fail-open. The LLM later sharpens `observable` wording only.
 * No new interpretation engine — this is a data-shape change, per the plan.
 */
function buildExpected(
  scenario: PlannedScenarioWithProvenance,
  form: FormLike | undefined,
  ap: ProfileLike | undefined,
): StructuredExpected {
  const ct = scenario.coverageType;
  // A post-condition anchor for automation: a "success" landmark (e.g. a logout
  // control) for positive flows, else the form's page. Never shown to manual QA.
  const successEl = (ap?.keyElements || []).find(e =>
    /log ?out|sign ?out|dashboard|account|profile|welcome/i.test(`${e.label || ''} ${e.selector || ''} ${e.role || ''}`),
  );
  const page = form?.page || ap?.loginUrl || ap?.baseUrl;
  const technical =
    ct === 'positive' && successEl?.selector
      ? { selector: successEl.selector, page }
      : page
      ? { page }
      : undefined;

  let observable: string;
  switch (ct) {
    case 'negative':
      observable =
        'The action is rejected, a clear, specific error message is shown, and no state change or navigation occurs.';
      break;
    case 'edge_cases':
      observable =
        'The application handles the edge input gracefully — it either accepts it correctly or shows a clear validation message, without errors or data corruption.';
      break;
    case 'boundary':
      observable =
        'Values at and within the limit are accepted; values beyond the limit are rejected with a clear boundary/validation message.';
      break;
    case 'security':
      observable =
        'The malicious input is safely rejected or neutralised — it is not executed or reflected back, and the user sees a safe, generic error (no sensitive detail).';
      break;
    case 'role_based':
      observable =
        'Access is denied for the unauthorized role and the user is shown an appropriate "not permitted" / access-denied message.';
      break;
    default: // positive, integration, performance, …
      observable = successEl?.label
        ? `The action succeeds and the user reaches the expected next state (e.g. the "${successEl.label}" area is visible).`
        : 'The action succeeds and the user reaches the expected next state, with confirmation shown.';
  }

  return { observable, business: scenario.objective, technical };
}

/* ------------------------------------------------------------------ */
/*  Builder                                                            */
/* ------------------------------------------------------------------ */

/**
 * Assemble deterministic draft test cases from a scenario plan + retrieved
 * context. One draft per planned scenario that is grounded OR whose behaviour is
 * supported by the requirement/App Profile/Test Data. Pure and fail-open.
 */
export function buildDraftTestCases(
  plan: ScenarioPlan | undefined,
  knowledge: KnowledgeLike | undefined,
  input?: RequirementLike,
): BuildDraftsResult {
  if (!plan || plan.isEmpty || !plan.scenarios.length) {
    return { drafts: [], groundedCount: 0 };
  }

  const ap = knowledge?.applicationProfile;
  const category = plan.classification.category;
  const baseUrl = ap?.baseUrl;
  const loginUrl = ap?.loginUrl;

  const drafts: DraftTestCase[] = [];
  let groundedCount = 0;

  // The builder is a PURE TRANSFORM. It emits exactly one draft per planned
  // scenario and NEVER decides whether a scenario should exist — that decision
  // was already made (and justified with provenance) by the Scenario Planner,
  // the single source of truth for scenario existence. The builder only
  // enriches each immutable planned scenario into a concrete, grounded draft.
  plan.scenarios.forEach((scenario, index) => {
    const scenarioTerms = toTerms(`${scenario.title} ${scenario.objective} ${scenario.riskArea}`);
    const form = pickForm(ap?.forms, scenarioTerms);
    const dataset = pickDataset(knowledge?.testData, scenarioTerms);

    // ── Steps ── business-readable action text ONLY. Technical grounding
    // (selectors / page) is captured separately in `grounding[]`, aligned to
    // steps by 1-based index. This is the core of the "separate DATA, not
    // pipelines" model: the same scenario carries a business projection (steps)
    // and a technical projection (grounding) so Manual renderers show clean
    // prose while Script-Gen consumes the selectors — no selector strings ever
    // leak into the text a human QA reads.
    const steps: string[] = [];
    const grounding: StepGrounding[] = [];
    const navTarget = loginUrl || form?.page || baseUrl;
    if (navTarget) {
      steps.push(`Navigate to the ${form?.page ? 'page under test' : 'application'}`);
      grounding.push({ stepIndex: steps.length, page: navTarget });
    }

    let usedRealSelector = false;
    const fields = (form?.fields || []).slice(0, 8);
    for (const f of fields) {
      if (f.selector) usedRealSelector = true;
      const fieldLabel = f.label || f.name || 'field';
      steps.push(`Enter ${dataPhraseFor(scenario.coverageType, f)} in the ${fieldLabel} field`);
      grounding.push({ stepIndex: steps.length, selector: f.selector, page: form?.page, control: fieldLabel });
    }
    if (form?.submitSelector) {
      usedRealSelector = true;
      const submitLabel = form.submitLabel || 'Submit';
      steps.push(`Click the ${submitLabel} button`);
      grounding.push({ stepIndex: steps.length, selector: form.submitSelector, page: form?.page, control: submitLabel });
    } else if (form) {
      steps.push('Submit the form');
      grounding.push({ stepIndex: steps.length, page: form?.page, control: 'Submit' });
    }
    if (!steps.length) {
      // No App Profile at all — still produce a usable skeleton from the objective.
      steps.push(`Exercise the "${scenario.title}" scenario against the application`);
    }
    // NOTE: no generic "Observe and verify the outcome" step. Verification lives
    // in the structured `expected` (observable + business + technical) so manual
    // QA sees a specific, checkable outcome instead of a filler step.

    // ── Preconditions ── grounded in the real app + dataset when present.
    const preParts: string[] = [];
    if (loginUrl || baseUrl) preParts.push(`The application is reachable${loginUrl ? ` at ${loginUrl}` : baseUrl ? ` at ${baseUrl}` : ''}`);
    if (dataset?.name) preParts.push(`the "${dataset.name}" test-data set is available`);
    const preconditions = preParts.length
      ? preParts.join('; ') + '.'
      : `The application and any data required for "${scenario.title}" are available.`;

    // ── Test data reference ── real dataset + sample keys when present.
    const testData = dataset?.name
      ? `${dataset.name}${dataset.sampleKeys?.length ? ` (keys: ${dataset.sampleKeys.slice(0, 5).join(', ')})` : ''}`
      : 'Use data appropriate to the scenario (no dedicated dataset found).';

    // ── Provenance ── carried through VERBATIM from the planner. The builder
    // does not decide (or second-guess) why a scenario exists; it only relays
    // the planner's justification. `source` is the slug of the planner's
    // evidence source — NOT a grounding echo. Whether we found a real selector
    // is a SEPARATE axis captured by `grounded`/`groundedCount` below.
    const source = PROVENANCE_SOURCE_SLUG[scenario.provenance.source];
    const sourceEvidence = scenario.provenance.whyExists;
    if (usedRealSelector) groundedCount += 1;

    const expected = buildExpected(scenario, form, ap);

    drafts.push({
      schemaVersion: 2,
      scenarioIndex: index,
      scenarioId: scenario.id,
      title: scenario.title,
      objective: scenario.objective,
      coverageType: scenario.coverageType,
      priority: scenario.priority,
      riskArea: scenario.riskArea,
      preconditions,
      steps,
      grounding,
      expected,
      // Mirror of the structured `observable` outcome, kept for back-compat with
      // consumers that still read the flat string.
      expectedResult: expected.observable,
      testData,
      tags: Array.from(new Set([category, scenario.coverageType])),
      automationReady: usedRealSelector,
      selectorAvailability: usedRealSelector ? 'high' : 'unknown',
      source,
      sourceEvidence,
      provenance: scenario.provenance,
      grounded: usedRealSelector,
    });
  });

  return { drafts, groundedCount };
}

/* ------------------------------------------------------------------ */
/*  Prompt block                                                       */
/* ------------------------------------------------------------------ */

/**
 * Render the drafts into a compact prompt block. This REPLACES "invent test
 * cases from scratch" with "refine these pre-built, grounded drafts": the LLM
 * keeps the structure/selectors/data and improves the wording, and may split a
 * draft into multiple concrete cases or add cases the requirement clearly
 * implies. Returns '' for no drafts so the caller cleanly falls back.
 */
export function buildDraftBlock(drafts: DraftTestCase[]): string {
  if (!drafts.length) return '';

  const lines: string[] = [];
  drafts.forEach((d, i) => {
    lines.push(`  Draft ${i + 1} — scenarioIndex ${d.scenarioIndex} — [${d.coverageType}] ${d.title}`);
    lines.push(`    objective: ${d.objective}`);
    lines.push(`    preconditions: ${d.preconditions}`);
    lines.push(`    steps: ${d.steps.map((s, n) => `${n + 1}) ${s}`).join('  ')}`);
    lines.push(`    expectedResult: ${d.expectedResult}`);
    lines.push(`    testData: ${d.testData}`);
    lines.push(`    priority: ${d.priority} | riskArea: ${d.riskArea} | source: ${d.source} (${d.sourceEvidence}) | selectorAvailability: ${d.selectorAvailability}`);
  });

  return `
--- PRE-BUILT DRAFT TEST CASES (assembled DETERMINISTICALLY from the scenario plan + REAL app structure) ---
These drafts were derived by the Scenario Planner — the single source of truth for WHICH business scenarios exist — from the explicit Requirement, Acceptance Criteria, App Knowledge and Test Data, then grounded in the crawled App Profile (real selectors) and Test Data sets. Each draft is already justified; each carries the source that justifies it. Your job is to REFINE the wording, NOT to decide coverage.

Rules for using the drafts:
  • Produce EXACTLY one testCase per draft, keeping its "scenarioIndex", the REAL dataset references, priority, riskArea and source. Improve ONLY the wording/specificity (sharper title, concrete values, crisp expected result). Keep steps business-readable — do NOT put selectors, element ids or raw URLs in the step text (technical grounding is tracked separately).
  • DO NOT invent additional test cases or scenarios. These drafts are the COMPLETE set the evidence justifies — if a failure mode or edge case is not represented below, the requirement / acceptance criteria / app knowledge / test data did not justify it, so leave it out.
  • DO NOT drop a draft. Every draft below is justified and must be written up.
  • Do NOT invent selectors, pages or datasets not present in the drafts/context. Keep the deterministic grounding: a grounded draft must stay grounded in its evidence.

DRAFTS (${drafts.length}):
${lines.join('\n')}
--- END DRAFT TEST CASES ---`;
}

/* ------------------------------------------------------------------ */
/*  Formatter mode — the LLM formats, it does not generate             */
/* ------------------------------------------------------------------ */

const SEVERITY_FOR_PRIORITY: Record<DraftTestCase['priority'], FormatterTestCase['severity']> = {
  P0: 'critical', P1: 'major', P2: 'minor', P3: 'trivial',
};

/**
 * Map a deterministic draft to a COMPLETE, final test-case object. This is the
 * heart of the "assemble, don't invent" shift: the object below is already a
 * shippable test case — real steps, real selectors, real dataset, priority,
 * severity, provenance. The LLM's only remaining job is to re-word the English.
 * If the LLM is skipped or fails, THIS is what ships (coverage never depends on
 * the model). `scenarioIndex` is the position in the emitted list so it always
 * lines up with the deterministically-derived scenarios array.
 */
export function draftToTestCase(draft: DraftTestCase, scenarioIndex: number): FormatterTestCase {
  const steps = draft.steps.slice();
  const grounding = (draft.grounding || []).map(g => ({ ...g }));
  // Selectors are now derived from the typed per-step grounding rather than
  // re-parsed from prose (steps no longer contain selector tokens). Fall back to
  // prose extraction only if grounding somehow carries none (e.g. LLM-added
  // steps), so the Validator always has selectors to check.
  const groundedSelectors = grounding.map(g => g.selector).filter((s): s is string => !!s);
  const selectors = groundedSelectors.length ? Array.from(new Set(groundedSelectors)) : extractSelectors(steps);
  return {
    schemaVersion: draft.schemaVersion,
    title: draft.title,
    objective: draft.objective,
    scenarioIndex,
    scenarioId: draft.scenarioId,
    riskArea: draft.riskArea,
    preconditions: draft.preconditions,
    steps,
    grounding,
    expected: { ...draft.expected, technical: draft.expected?.technical ? { ...draft.expected.technical } : undefined },
    expectedResult: draft.expectedResult,
    testData: draft.testData,
    selectors,
    priority: draft.priority,
    severity: SEVERITY_FOR_PRIORITY[draft.priority] || 'major',
    tags: draft.tags.slice(),
    automationReady: draft.automationReady,
    automationComplexity: draft.grounded ? 'low' : 'medium',
    selectorAvailability: draft.selectorAvailability,
    source: draft.source,
    sourceEvidence: draft.sourceEvidence,
    provenance: draft.provenance,
  };
}

/** Derive the scenarios array DETERMINISTICALLY from the drafts (no LLM). */
export function buildScenariosFromDrafts(drafts: DraftTestCase[]): FormatterScenario[] {
  return drafts.map(d => ({
    scenario: d.title,
    objective: d.objective,
    coverageType: d.coverageType,
    priority: d.priority,
    riskArea: d.riskArea,
  }));
}

/** The complete deterministic result — scenarios + test cases, zero LLM. */
export function buildDeterministicOutput(drafts: DraftTestCase[]): {
  scenarios: FormatterScenario[];
  testCases: FormatterTestCase[];
} {
  return {
    scenarios: buildScenariosFromDrafts(drafts),
    testCases: drafts.map((d, i) => draftToTestCase(d, i)),
  };
}

/**
 * The ONLY fields the LLM formatter is allowed to touch — the human-readable
 * English. Everything else (priority, severity, coverage, source, selectors,
 * dataset, automation flags, scenarioIndex) is a deterministic INVARIANT and is
 * never sent to the model, so it can never be changed. `id` is the canonical
 * scenarioId, round-tripped so we can re-attach the polished wording to the
 * right invariant object regardless of order.
 */
export interface EditablePolishFields {
  id: string;
  title: string;
  objective: string;
  preconditions: string;
  steps: string[];
  expected: string;
}

/** Project a canonical test case down to only its editable (wording) fields. */
function toEditable(tc: FormatterTestCase): EditablePolishFields {
  return {
    id: tc.scenarioId,
    title: tc.title,
    objective: tc.objective,
    preconditions: tc.preconditions,
    steps: tc.steps.slice(),
    expected: tc.expectedResult,
  };
}

/**
 * Build the MINIMAL, CANONICAL formatter prompt.
 *
 * This is the next evolution of Formatter Mode: instead of sending the WHOLE
 * test-case object (16 fields) and asking the model to echo it back, we send
 * ONLY the editable wording fields (`id`, title, objective, preconditions,
 * steps, expected). The deterministic invariants are withheld entirely — the
 * model literally cannot change them because it never sees them. This cuts BOTH
 * the input payload AND (crucially) the OUTPUT: the model re-serialises ~6 short
 * fields per case, not ~16. All withheld fields are re-attached deterministically
 * by `id` after the call. The model edits English; it cannot touch logic.
 */
export function buildFormatterPrompt(testCases: FormatterTestCase[]): string {
  // Compact, whitespace-free JSON of the editable fields only.
  const payload = JSON.stringify(testCases.map(toEditable));
  return `You are a senior QA technical editor enforcing the LevelUp AI QA Artifact Standard. Below are ${testCases.length} test cases assembled DETERMINISTICALLY from the real application. Logic, selectors, data and coverage are FINAL — only the English wording needs polishing.

YOUR JOB: Rewrite "title", "objective", "preconditions", "steps", and "expected" to comply with the QA Artifact Standard principles below. The SAME test logic, the SAME selectors, the SAME coverage — only the wording changes.

CONTRACT (violating any is a failure):
  • Return EXACTLY ${testCases.length} objects in the SAME order, each with the SAME "id". Never add, remove, split, merge or reorder.
  • Keep the SAME number of steps per case. If a step combines multiple actions ("Enter username and password"), SPLIT it into separate steps ("Enter registered username" / "Enter valid password"). If the result is MORE steps than the input, that is CORRECT (the input violated the standard).
  • Do NOT add CSS/XPath selectors, element ids, or raw URLs to step text — those are hidden in grounding.
  • Do NOT invent new test logic, selectors, pages or data.

QA ARTIFACT STANDARD (enforce these principles):

CORE PRINCIPLES:
1. ONE OBJECTIVE: Each test verifies exactly ONE thing. Title: "Verify <behavior> when <condition>."
2. ONE ACTION PER STEP: Never combine. Bad: "Enter username and password." Good: "Enter registered username." (step N) + "Enter valid password." (step N+1).
3. USER ACTIONS ONLY: What a human does. Bad: "Ensure button is clickable." Good: "Click Login button."
4. VERIFICATION ≠ ACTION: Separate steps. Bad: "Click Login and verify Home page." Good: "Click Login." + "Verify Home page is displayed."
5. BUSINESS LANGUAGE: Product terms, never automation. Bad: "Fill username field" / "Trigger submit." Good: "Enter registered email address" / "Click Login button."
6. OBSERVABLE EXPECTED RESULTS: Granular, specific. Never "Login successful." Always: "Home page is displayed." + "Logged-in username visible in header." + "Logout button available."
7. TEST DATA ROLES, NOT VALUES: Steps say "registered username" / "valid password" (roles). Never "standard_user" or "secret_sauce" (values).
8. PRECONDITIONS ≠ STEPS: Preconditions = starting state. Steps = user actions.
9. MACHINE-READABLE: Consistent verbs ("Open", "Enter", "Click", "Select", "Verify"). Script Generation parses these deterministically.

STEP WORDING:
• Navigation: "Open <Page> page" (not "Navigate to", "Go to").
• Input: "Enter <role> <field>" (e.g., "Enter registered email address"). Never "Fill", "Type into".
• Click: "Click <Control>" (e.g., "Click Login button"). Never "Press", "Trigger".
• Selection: "Select <Option> from <Dropdown>".
• Verification: "Verify <Observable> is <State>" (e.g., "Verify error message is displayed").
• SPLIT multi-action steps: "Enter email and password and click Login" → 3 steps.
• NO meta-actions: Never "Ensure", "Confirm", "Observe", "Check", "Wait for".

EXPECTED RESULTS:
• NEVER abstract: "Login successful" / "Operation completes" / "System behaves correctly."
• ALWAYS specific observables: "Home page is displayed." + "Logged-in username visible in header." + "Login form no longer displayed."
• Failure scenarios: describe WHAT the user sees ("Error message displayed." + "User remains on Login page." + "No session created.").
• Each assertion is a separate bullet for failure diagnosis.

TITLE FORMULA (no creativity):
"Verify <expected behavior> when <condition>."
Examples: "Verify successful login with valid credentials." / "Verify login fails with an invalid password." / "Verify validation message when password is empty."

Return ONLY valid JSON (no prose, no markdown):
{ "cases": ${'[{ "id": string, "title": string, "objective": string, "preconditions": string, "steps": string[], "expected": string }]'} }

TEST CASES TO POLISH:
${payload}`;
}

/**
 * Re-attach the LLM's polished wording to the deterministic canonical objects.
 *
 * Coverage/logic NEVER depend on the model: we start from the deterministic
 * cases (the source of truth) and overlay ONLY the wording fields, matched by
 * canonical `id` (falling back to positional order when ids are absent).
 *
 * **QA Standard adaptation (Sprint 2B):** The formatter prompt now explicitly
 * instructs the model to SPLIT combined-action steps ("Enter username and password"
 * → 2 steps) to comply with Principle 2 (One Action Per Step). This means the
 * polished step count can LEGITIMATELY exceed the deterministic count. We accept
 * this (splitting is a quality improvement), but still reject count DECREASES
 * (merging/dropping steps is a contract violation). Any field the model omitted
 * or blanked falls back to the deterministic value.
 */
export function applyPolish(
  deterministic: FormatterTestCase[],
  polished: unknown,
): { cases: FormatterTestCase[]; contractOk: boolean } {
  const arr = Array.isArray((polished as any)?.cases)
    ? (polished as any).cases
    : Array.isArray(polished)
    ? (polished as any[])
    : [];
  const contractOk = arr.length === deterministic.length;
  if (!contractOk) return { cases: deterministic.slice(), contractOk: false };

  // Index polished by canonical id; fall back to positional matching.
  const byId = new Map<string, any>();
  for (const p of arr) if (p && typeof p.id === 'string') byId.set(p.id, p);

  const cases = deterministic.map((det, i) => {
    const p: any = byId.get(det.scenarioId) ?? arr[i] ?? {};
    const str = (v: unknown, fallback: string) =>
      typeof v === 'string' && v.trim() ? v : fallback;

    // Step count adaptation (QA Standard Sprint 2B):
    // Accept polished steps if:
    //   (a) same count AND all valid strings (original behavior), OR
    //   (b) MORE steps than deterministic (splitting combined actions is allowed), OR
    //   (c) if count decreased or any step is blank → fall back to deterministic
    const stepsValid =
      Array.isArray(p.steps) &&
      p.steps.length >= det.steps.length &&
      p.steps.every((s: unknown) => typeof s === 'string' && (s as string).trim().length > 0);
    const steps = stepsValid ? (p.steps as string[]) : det.steps;

    return {
      ...det, // all deterministic invariants preserved verbatim
      title: str(p.title, det.title),
      objective: str(p.objective, det.objective),
      preconditions: str(p.preconditions, det.preconditions),
      expectedResult: str(p.expected, det.expectedResult),
      steps,
    };
  });
  return { cases, contractOk: true };
}
