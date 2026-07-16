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

import type { QACategory, ScenarioSemantics } from './qa-knowledge-engine';
// Resolution no longer happens here — it runs ONCE at Scenario Graph build time
// and the record is carried down onto the case. We only need the record TYPE and
// the shared masking primitive (single source of truth) for the prompt boundary.
import {
  maskResolvedDataset as maskResolvedRecord,
  type ResolvedDatasetRecord,
} from './dataset-resolver';
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
  // Deep Coverage scenarios are domain best-practice, grounded in the QA
  // knowledge base obligations (never hallucinated). They relay as 'knowledge'.
  'Deep Coverage': 'knowledge',
  // Standard Coverage scenarios (Sprint 6.x) are the same KB-obligation best-
  // practice, authorised by an explicit coverage-family selection rather than
  // the Deep toggle. Same provenance bucket — 'knowledge'.
  'Standard Coverage': 'knowledge',
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
  /**
   * Deterministic review flag (Scenario ↔ Automation Ready). True when the draft
   * could NOT be safely grounded to the FEATURE's real fields — i.e. no form in
   * the App Profile matched this feature's vocabulary, so the steps are an
   * honest skeleton rather than concrete field interactions. When true,
   * `automationReady` is forced false and `reviewReasons` explains why, so the
   * output shows "Needs Review" instead of a false "Automation Ready: YES".
   */
  needsReview: boolean;
  /** Human-readable reasons the case needs review (empty when none). */
  reviewReasons: string[];
  /**
   * The real field labels of the feature form this draft grounded on (empty when
   * no feature form resolved). Lets the Scenario Integrity certifier verify that
   * every field a step references actually EXISTS for this feature — the
   * deterministic Step Validator that stops login fields leaking into an Add
   * Employee flow.
   */
  applicationFields: string[];
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
  /**
   * The dataset record resolved for this case's required data role, carried down
   * FROM the Scenario Graph (resolved once at graph-build time, never here). The
   * Test Case Lab projection sets it; `buildFormatterInputs` reads it straight
   * onto the FormatterInput so the LLM prompt can reference the data by role.
   * Absent when the graph did not resolve a record. Holds real values; masking
   * happens at the prompt boundary.
   */
  resolvedDataset?: ResolvedDatasetRecord;
  /**
   * Deterministic review flag carried through from the draft (Scenario ↔
   * Automation Ready). Optional for back-compat with cases reconstructed from
   * older DB rows. When true the case is "Needs Review", never automation-ready.
   */
  needsReview?: boolean;
  /** Reasons the case needs review (empty/absent when none). */
  reviewReasons?: string[];
  /** Real field labels of the feature form this case grounded on (Step Validator input). */
  applicationFields?: string[];
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
 * Purely structural tokens that carry NO feature identity — HTML/URL scaffolding
 * and filler words. We match on whole tokens (never substrings) over the form's
 * field NAMES + LABELS only (never field TYPE), so the old collisions are already
 * gone: "name"/"user" no longer match inside "username", and the type "text" is
 * not considered at all. This stoplist only removes the remaining generic
 * scaffolding so it can never tip the score toward a foreign form. Real field
 * identities (email, password, first, last, employee, id, ...) are intentionally
 * NOT here — they are exactly what makes a form recognisable.
 */
const FORM_STOP_TOKENS = new Set([
  'value', 'form', 'input', 'field', 'submit', 'button',
  'http', 'https', 'www', 'com', 'html', 'php',
  'the', 'and', 'for', 'with', 'new', 'edit',
]);

/**
 * Score how well a form belongs to a feature. Matching is on WHOLE tokens (not
 * substrings) drawn from the form's field names + labels, minus generic
 * stop-tokens. Substring matching was the trust bug: "name"/"user" matched
 * inside "username" and the type "text" matched everything, so the login form
 * scored against an Add-Employee feature and its fields leaked in.
 */
function scoreForm(form: FormLike, terms: string[]): number {
  const formTokens = new Set<string>();
  const add = (raw: string) => {
    for (const tok of toTerms(raw)) if (!FORM_STOP_TOKENS.has(tok)) formTokens.add(tok);
  };
  // Field identities are the strongest signal; the page/action path is a weaker
  // but real one (a scenario often names the page — "log in", not the field).
  // Both are tokenised whole (never substrings) and the field TYPE is excluded,
  // so "username" no longer leaks the tokens "user"/"name" and the type "text"
  // matches nothing.
  for (const f of form.fields || []) { add(f.name || ''); add(f.label || ''); }
  add(form.page || '');
  add(form.action || '');
  let score = 0;
  for (const t of terms) {
    if (t && !FORM_STOP_TOKENS.has(t) && formTokens.has(t)) score += 1;
  }
  return score;
}

/** Tokenise to distinct lowercase terms (>=3 chars). */
function toTerms(s: string): string[] {
  return Array.from(new Set(lc(s).split(/[^a-z0-9]+/).filter(t => t.length >= 3)));
}

/**
 * FIELD RESOLVER (Scenario ↔ Fields).
 *
 * Pick the form that genuinely belongs to THIS feature: the highest-scoring form
 * against the feature vocabulary (requirement title + scenario terms). Crucially,
 * a form is only eligible to ground steps when it actually matches — if NOTHING
 * matches (best score 0) we return `undefined` instead of falling back to an
 * arbitrary form.
 *
 * WHY: the old "fall back to forms[0]" behaviour is exactly the trust bug — for
 * an "Add Employee" feature whose App Profile only carries a login form, forms[0]
 * (login) was silently chosen, so the steps referenced `username`/`password` and
 * inherited the login form's real selectors, which then flipped Automation Ready
 * to YES. Refusing to ground on a non-matching form makes the builder emit an
 * honest, ungrounded skeleton that the caller marks "Needs Review" — incomplete
 * but correct beats complete but wrong.
 */
function pickForm(forms: FormLike[] | undefined, terms: string[]): FormLike | undefined {
  if (!forms?.length) return undefined;
  let best: FormLike | undefined;
  let bestScore = 0;
  for (const f of forms) {
    const s = scoreForm(f, terms);
    if (s > bestScore) { best = f; bestScore = s; }
  }
  // No form matched the feature vocabulary → do NOT ground on a foreign form.
  return bestScore > 0 ? best : undefined;
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
interface DataIntentScenario {
  coverageType: string;
  title?: string;
  objective?: string;
  riskArea?: string;
  id?: string;
}

function dataPhraseFor(scenario: DataIntentScenario, field: FieldLike): string {
  const label = field.label || field.name || 'value';
  const ct = scenario.coverageType;
  // The scenario's OWN intent — not just its coverage-type bucket — decides the
  // data. This is Scenario ↔ Test Data: a "SQL injection" scenario must carry
  // an injection string, an "XSS" scenario a script payload, a "duplicate"
  // scenario an existing value — never the same default value for all of them.
  const intent = lc(`${scenario.title} ${scenario.objective} ${scenario.riskArea} ${scenario.id}`);
  const fieldText = lc(`${field.name} ${field.label} ${field.type}`);
  const isFile = lc(field.type) === 'file' || /photo|image|upload|file|attach|document|resume|avatar/.test(fieldText);

  // Specific-intent payloads (override the generic phrasing only when the
  // scenario expresses a concrete intent; otherwise fall through to the
  // coverage-type default so polarity words like valid/invalid survive).
  // XSS is checked BEFORE SQL: the XSS scenario id is "…-injection-xss", which
  // also contains "injection" — so SQL (which keys off "injection") must not win
  // that scenario. The more-specific script/xss signal takes precedence.
  if (/\bxss\b|<script|script payload|cross-site|script injection|alert\(/.test(intent)) return `the XSS payload "<script>alert(1)</script>"`;
  if (/\bsql\b|injection|1\s*=\s*1|or\s+1=1|drop table/.test(intent)) return `the SQL-injection string "' OR 1=1 --"`;
  if (/duplicate|already exist|existing (record|employee|entry|id)|not unique/.test(intent)) return `a ${label} that already exists (a duplicate of a record already in the system)`;
  if (isFile && /\.exe|invalid file|wrong (file )?type|not an image|disallow|virus|executable|unsupported/.test(intent)) return `an invalid file type (e.g. "virus.exe")`;
  if (isFile && /corrupt/.test(intent)) return `a corrupted image file (valid extension, unreadable content)`;
  if (/numeric|contains? a? ?number|digits? in|non-alpha|john123/.test(intent)) return `a ${label} containing numbers (e.g. "John123")`;
  if (/whitespace|spaces? only|space-only|only spaces|blank spaces/.test(intent)) return `a whitespace-only ${label} (e.g. "   ")`;
  if (/unicode|accent|non-ascii|special character|emoji|diacritic/.test(intent)) return `a unicode ${label} (e.g. "தமிழ்", "李雷", "😊")`;
  if (/\bmax(imum)?\b|too long|over the limit|exceed|length limit|character limit|501|500 char/.test(intent)) return `a ${label} longer than the maximum allowed length (e.g. 501 characters)`;
  if (/\bmin(imum)?\b|single character|one char|too short/.test(intent)) return `a single-character ${label} (minimum boundary)`;
  if (/leading zero/.test(intent)) return `a ${label} with leading zeros (e.g. "007")`;
  if (/blank|empty|required|mandatory|missing/.test(intent)) return `a blank ${label} (leave it empty)`;

  switch (ct) {
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

  // FIELD RESOLVER (Scenario ↔ Fields): the feature's identity comes from the
  // requirement TITLE — the strongest, least noisy signal of which form belongs
  // to this feature (the description may mention incidental auth words like
  // "logged in" that would otherwise drag a scenario onto the login form). Every
  // scenario is resolved against title terms ∪ its own terms, so a form is only
  // grounded when it matches THIS feature's vocabulary.
  const titleTerms = toTerms(input?.title || '');

  // The builder is a PURE TRANSFORM. It emits exactly one draft per planned
  // scenario and NEVER decides whether a scenario should exist — that decision
  // was already made (and justified with provenance) by the Scenario Planner,
  // the single source of truth for scenario existence. The builder only
  // enriches each immutable planned scenario into a concrete, grounded draft.
  plan.scenarios.forEach((scenario, index) => {
    const scenarioTerms = toTerms(`${scenario.title} ${scenario.objective} ${scenario.riskArea}`);
    const featureTerms = Array.from(new Set([...titleTerms, ...scenarioTerms]));
    const form = pickForm(ap?.forms, featureTerms);
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
      // QA Standard P9 (machine-readable verbs): use "Open ... page", never
      // "Navigate to" — so the deterministic baseline itself already satisfies
      // the QA Standard validator and is a clean fallback.
      steps.push(`Open the ${form?.page ? 'page under test' : 'application'}`);
      grounding.push({ stepIndex: steps.length, page: navTarget });
    }

    let usedRealSelector = false;
    const fields = (form?.fields || []).slice(0, 8);
    for (const f of fields) {
      if (f.selector) usedRealSelector = true;
      const fieldLabel = f.label || f.name || 'field';
      steps.push(`Enter ${dataPhraseFor(scenario, f)} in the ${fieldLabel} field`);
      grounding.push({ stepIndex: steps.length, selector: f.selector, page: form?.page, control: fieldLabel });
    }
    if (form?.submitSelector) {
      usedRealSelector = true;
      const submitLabel = form.submitLabel || 'Submit';
      steps.push(`Click the ${submitLabel} button`);
      grounding.push({ stepIndex: steps.length, selector: form.submitSelector, page: form?.page, control: submitLabel });
    } else if (form) {
      // QA Standard P5 (business language): "Click the Submit button", never a
      // bare "Submit the form" — keep a consistent, parseable action verb.
      steps.push('Click the Submit button');
      grounding.push({ stepIndex: steps.length, page: form?.page, control: 'Submit' });
    }
    if (!form) {
      // No form matched THIS feature (or no App Profile at all). Emit an honest,
      // ungrounded skeleton from the objective rather than fabricating field
      // steps against a foreign form. The caller marks this "Needs Review".
      steps.push(`Exercise the "${scenario.title}" scenario against the application`);
    }
    if (!steps.length) {
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

    // ── Scenario ↔ Automation Ready ── a case is automation-ready ONLY when a
    // real feature form was resolved AND it yielded a real selector. If no form
    // matched this feature, the steps are an honest skeleton — mark "Needs
    // Review" and force automationReady false rather than lie with a YES.
    const featureFormResolved = !!form;
    const applicationFields = (form?.fields || []).map(f => f.label || f.name || 'field');
    const reviewReasons: string[] = [];
    if (!featureFormResolved) {
      reviewReasons.push(
        `No form in the App Profile matches the "${input?.title || scenario.title}" feature — the steps are an ungrounded skeleton. Confirm the real fields and selectors against the live UI before automating.`,
      );
    } else if (!usedRealSelector) {
      reviewReasons.push(
        'The matched feature form exposes no real selectors yet — locators must be resolved before this case can be automated.',
      );
    }
    const needsReview = reviewReasons.length > 0;
    const automationReady = featureFormResolved && usedRealSelector;

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
      automationReady,
      selectorAvailability: usedRealSelector ? 'high' : 'unknown',
      source,
      sourceEvidence,
      provenance: scenario.provenance,
      grounded: usedRealSelector,
      needsReview,
      reviewReasons,
      applicationFields,
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
    needsReview: draft.needsReview,
    reviewReasons: draft.reviewReasons ? draft.reviewReasons.slice() : [],
    applicationFields: draft.applicationFields ? draft.applicationFields.slice() : [],
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

/* ------------------------------------------------------------------ */
/*  FormatterInput — the contract, NOT a prompt                        */
/* ------------------------------------------------------------------ */

/**
 * FormatterInput — the STRUCTURED contract handed to the LLM formatter.
 * ============================================================================
 *
 * This is the heart of the Sprint 2B redesign. The QA Artifact Standard is the
 * CONTRACT, not a prompt: rather than re-teaching the model 20 principles on
 * every request, we make the structural decisions DETERMINISTICALLY (upstream,
 * from `ScenarioSemantics`) and hand the model a nearly-finished object. Almost
 * everything is already decided:
 *
 *   • objective / preconditions / variation / expectedBehavior / dataRole come
 *     straight from the KB-authored ScenarioSemantics — the model may NOT change
 *     them (they are FIXED context it reads to write good prose).
 *   • priority / coverageType are deterministic invariants.
 *   • title / steps / expected are SEED wording the model refines into natural,
 *     human-quality English.
 *
 * The model's ONLY job becomes "write naturally" — not "think". Because the
 * decisions are pre-made, the prompt collapses to a few lines (see
 * `buildFormatterPrompt`) and the 20 principles move OUT of the prompt and INTO
 * a deterministic validator (`qa-standard-validator.ts`) that runs AFTER
 * generation. Standard changes happen in ONE place (the validator + the MD doc),
 * never scattered across prompt strings — no drift.
 *
 * `id` is the canonical scenarioId, round-tripped so the polished wording can be
 * re-attached to the right invariant object regardless of order. Traceability,
 * selectors, severity, source, automation flags are NEVER sent — the model can
 * therefore never corrupt them.
 *
 * IMMUTABLE by contract. Every field is `readonly` and the objects returned by
 * `buildFormatterInputs` are deep-frozen (see below). The FIXED semantic fields
 * (objective / variation / expectedBehavior / dataRole …) are SEMANTIC TRUTH
 * decided upstream by the Planner + ScenarioSemantics — no formatter, prompt
 * builder or repair step is allowed to mutate them. Freezing makes that
 * guarantee enforced at runtime, not just by convention.
 */
export interface FormatterInput {
  /** Canonical scenarioId — round-trip key; the model must echo it back. */
  readonly id: string;
  /* ---- FIXED semantic context (model READS, must honor, must NOT alter) ---- */
  /** The ONE thing this case verifies (from the scenario). */
  readonly objective: string;
  /** The valid starting state (deterministic; the model does not rewrite it). */
  readonly preconditions: string;
  /** The single variable changed from a valid baseline (ScenarioSemantics). */
  readonly variation: string;
  /** The observable pass/fail behavior to assert (ScenarioSemantics). */
  readonly expectedBehavior: string;
  /** The generic data ROLE this case needs, e.g. "registered_user". */
  readonly dataRole: string;
  /** Deterministic priority (invariant). */
  readonly priority: FormatterTestCase['priority'];
  /** Coverage type, e.g. "positive" / "negative" (invariant). */
  readonly coverageType: string;
  /* ---- SEED wording the model REFINES into human-quality prose ---- */
  readonly title: string;
  readonly steps: readonly string[];
  readonly expected: string;
  /**
   * The concrete dataset record the Dataset Resolver matched for `dataRole`, or
   * absent when no available dataset declares that role (resolution is
   * best-effort — the formatter must work with or without it). This is ADDITIVE
   * context: it never replaces `dataRole` and the resolver never mutates the
   * semantics. The prompt shows the model dataset/record/role with MASKED values
   * so it writes role-based wording; the LLM never performs a lookup itself.
   */
  readonly resolvedDataset?: ResolvedDatasetRecord;
}

/**
 * Build the FormatterInput contract for each canonical case, folding in the
 * KB-authored `ScenarioSemantics` (variation / expectedBehavior / dataRole) so
 * the structural decisions travel as DATA, not as prompt instructions. Pure and
 * deterministic. `semanticsById` is keyed by scenarioId; when a case has no
 * semantics (uncurated category / legacy row) the fields fall back to the
 * scenario's own objective so the contract is always total.
 */
export function buildFormatterInputs(
  cases: FormatterTestCase[],
  semanticsById?: Map<string, ScenarioSemantics>,
): FormatterInput[] {
  return cases.map(tc => {
    const sem = semanticsById?.get(tc.scenarioId);
    const dataRole = sem?.requiredDataRole ?? 'valid_data';
    // Resolution already happened ONCE, at Scenario Graph build time, and the
    // winning record was carried down onto this case (via the Test Case Lab
    // projection). We simply READ it here — no dataset lookup, no resolver call,
    // no second resolution. Absent when the graph resolved nothing.
    const resolved = tc.resolvedDataset ?? null;
    // Deep-freeze: the seed steps array AND the whole object, so the immutable
    // contract is enforced at runtime (a stray mutation throws in strict mode /
    // is silently ignored otherwise — never a hidden semantic edit).
    const input: FormatterInput = {
      id: tc.scenarioId,
      objective: tc.objective,
      preconditions: tc.preconditions,
      variation: sem?.variation ?? 'none — the primary path is exercised',
      expectedBehavior: sem?.expectedBehavior ?? tc.objective,
      dataRole,
      priority: tc.priority,
      coverageType: tc.tags?.[tc.tags.length - 1] ?? 'positive',
      title: tc.title,
      steps: Object.freeze(tc.steps.slice()),
      expected: tc.expectedResult,
      ...(resolved ? { resolvedDataset: resolved } : {}),
    };
    return Object.freeze(input);
  });
}

/**
 * Build the MINIMAL formatter prompt.
 * ============================================================================
 *
 * The QA Artifact Standard is NOT in this prompt. All 20 principles are enforced
 * by the deterministic `qa-standard-validator.ts` AFTER generation, so the
 * prompt does not re-teach them every request. Structural decisions already live
 * in the FormatterInput (objective, preconditions, variation, expectedBehavior,
 * dataRole, priority, coverage). The model therefore has ONE job — convert the
 * seed wording into natural human QA prose — and the prompt is a few lines, not
 * eight pages. This is the token/latency win AND the anti-drift win (the
 * standard changes in ONE place, never in scattered prompt strings).
 *
 * Only the editable wording fields are returned ("id", "title", "steps",
 * "expected"). Everything else is a withheld invariant re-attached by `id`.
 */
export function buildFormatterPrompt(inputs: FormatterInput[]): string {
  // Compact, whitespace-free JSON — the FormatterInput contract as data. The
  // resolved dataset record is projected with MASKED values: the model sees the
  // dataset id, record id, role and the field NAMES (so it can write "Enter the
  // registered username") but NEVER the literal secret values — those never
  // belong in a manual test case and must not leak into the prompt/output.
  const projected = inputs.map(maskFormatterInput);
  const payload = JSON.stringify(projected);
  return `You are a senior QA engineer writing manual test cases. Each item below is an ALREADY-DECIDED test case: its objective, preconditions, the single variable under test, the expected behavior, the required data role, priority and coverage are FIXED. Do NOT change, restate or second-guess them.

YOUR ONLY JOB: rewrite "title", "steps" and "expected" into natural, human-quality QA wording that faithfully expresses the fixed context.

Write like a senior tester:
  • Title: "Verify <expected behavior> when <condition>."
  • Steps: one user action each (never combine with "and"); business language ("Enter the registered username", "Click the Login button"); data ROLES, never literal values.
  • Expected: concrete, observable outcomes a tester can see — never "Login successful" / "works correctly".

DATA: when a case has "resolvedDataset", its "values" are MASKED ("*****") on purpose — refer to the data by ROLE and field name (e.g. "the registered user's username"), never write literal credential values.

CONTRACT: return EXACTLY ${inputs.length} objects, SAME order, SAME "id". Never add, drop, merge or reorder cases. Do not put selectors, element ids or raw URLs in step text.

Return ONLY valid JSON (no prose, no markdown):
{ "cases": ${'[{ "id": string, "title": string, "steps": string[], "expected": string }]'} }

TEST CASES:
${payload}`;
}

/**
 * Project a FormatterInput for the prompt, replacing every resolved-dataset
 * value with {@link MASKED_VALUE} while preserving the field NAMES, dataset id,
 * record id and reason. The masking of the record itself reuses the SINGLE
 * shared primitive (`maskResolvedRecord` from the Dataset Resolver) so the mask
 * behaviour is defined in exactly one place. Pure — never mutates the input.
 * Inputs without a resolved dataset pass through untouched.
 */
function maskFormatterInput(input: FormatterInput): FormatterInput {
  if (!input.resolvedDataset) return input;
  return { ...input, resolvedDataset: maskResolvedRecord(input.resolvedDataset) };
}

/**
 * Build the TARGETED repair prompt.
 * ============================================================================
 *
 * Used ONLY when the deterministic QA-Standard validator flags a case. Instead
 * of re-teaching the whole standard, we hand the model back ONLY the failing
 * cases and ONLY their specific violations (produced by the validator). This is
 * the "Generate → Validator → Repair → Validator" loop: the model fixes exactly
 * what failed, nothing else. `fixesById` maps scenarioId → short fix
 * instructions derived from the validator's violations.
 */
export function buildRepairPrompt(
  inputs: FormatterInput[],
  fixesById: Record<string, string[]>,
): string {
  const payload = JSON.stringify(inputs);
  const fixLines = inputs
    .map(inp => `  "${inp.id}":\n${(fixesById[inp.id] || []).map(f => `    - ${f}`).join('\n')}`)
    .join('\n');
  return `You are a senior QA engineer. The test cases below did NOT meet the QA writing standard. Fix ONLY the listed issues in each case's "title", "steps" and "expected". Keep the same test logic and the fixed context (objective, preconditions, variable under test, data role) unchanged.

REQUIRED FIXES (by case id):
${fixLines}

General reminders: one user action per step (never combine with "and"); business language (no automation words like "fill"/"trigger"/selectors); verification is its OWN step; expected results are concrete and observable; title is "Verify <behavior> when <condition>."

CONTRACT: return EXACTLY ${inputs.length} objects, SAME order, SAME "id".

Return ONLY valid JSON (no prose, no markdown):
{ "cases": ${'[{ "id": string, "title": string, "steps": string[], "expected": string }]'} }

TEST CASES:
${payload}`;
}

/**
 * Re-attach the LLM's polished wording to the deterministic canonical objects.
 *
 * Coverage/logic NEVER depend on the model: we start from the deterministic
 * cases (the source of truth) and overlay ONLY the wording fields the model was
 * allowed to touch — `title`, `steps`, `expected` — matched by canonical `id`
 * (falling back to positional order when ids are absent). `objective` and
 * `preconditions` are now FIXED context (part of the semantic contract) and are
 * never overlaid: the model receives them read-only and cannot alter them.
 *
 * Step count: splitting a combined-action step into atomic steps is a legitimate
 * QA-Standard improvement, so a polished count that is >= the deterministic count
 * is accepted; a DECREASE (merging/dropping) is rejected and falls back.
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

    // Accept polished steps if: same-or-more count AND every step a non-blank
    // string. A decrease (merge/drop) or any blank → fall back to deterministic.
    const stepsValid =
      Array.isArray(p.steps) &&
      p.steps.length >= det.steps.length &&
      p.steps.every((s: unknown) => typeof s === 'string' && (s as string).trim().length > 0);
    const steps = stepsValid ? (p.steps as string[]) : det.steps;

    return {
      ...det, // all deterministic invariants preserved verbatim (incl. objective/preconditions)
      title: str(p.title, det.title),
      expectedResult: str(p.expected, det.expectedResult),
      steps,
    };
  });
  return { cases, contractOk: true };
}
