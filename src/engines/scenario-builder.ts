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
 * REFINES the wording and may add cases the requirement clearly implies.
 *
 * Design guarantees (same discipline as the planner/optimizer):
 *   • Pure & synchronous — no I/O, no LLM, no randomness. Deterministic output.
 *   • Fail-open — if no App Profile/Test Data is available a draft is still
 *     produced from the scenario objective (source 'knowledge'); the builder
 *     NEVER throws and never returns fewer drafts than grounded scenarios.
 *   • Grounded — steps reference REAL selectors/URLs/datasets when present; a
 *     draft is tagged 'app_profile' when it used real selectors, 'test_data'
 *     when it used a real dataset, else 'knowledge'.
 *   • Coverage-first — emits a draft for EVERY grounded planned scenario, plus
 *     conditional ones the requirement OR the retrieved context supports. This
 *     is what lifts a login requirement off the weak "5 scenarios" floor to the
 *     full senior-QA baseline, WITHOUT inventing ungrounded behaviour.
 */

import type { QACategory } from './qa-knowledge-engine';
import type { AnnotatedPlannedScenario, ScenarioPlan } from './scenario-planner';

/* ------------------------------------------------------------------ */
/*  Loose structural shapes (decoupled from the engine types)          */
/* ------------------------------------------------------------------ */

interface FieldLike { name?: string; type?: string; required?: boolean; selector?: string; label?: string }
interface FormLike { page?: string; action?: string; method?: string; fields?: FieldLike[]; submitSelector?: string }
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
 * A deterministically-assembled draft test case. Mirrors the engine's TestCase
 * shape closely so the LLM's job is to REFINE fields, not restructure. Kept as
 * its own type so the builder stays decoupled and unit-testable in isolation.
 */
export interface DraftTestCase {
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
  steps: string[];
  expectedResult: string;
  testData: string;
  tags: string[];
  automationReady: boolean;
  selectorAvailability: 'high' | 'medium' | 'low' | 'unknown';
  source: 'requirement' | 'knowledge' | 'test_data' | 'app_profile';
  sourceEvidence: string;
  /** True when the draft used at least one REAL selector from the App Profile. */
  grounded: boolean;
}

export interface BuildDraftsResult {
  drafts: DraftTestCase[];
  /** How many drafts were grounded in real selectors (analytics). */
  groundedCount: number;
  /** How many conditional scenarios were kept because context supported them. */
  conditionalKept: number;
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
 */
export interface FormatterTestCase {
  title: string;
  objective: string;
  scenarioIndex: number;
  /** Stable canonical id (from the KB scenario) — see DraftTestCase.scenarioId. */
  scenarioId: string;
  riskArea: string;
  preconditions: string;
  steps: string[];
  expectedResult: string;
  testData: string;
  /**
   * Selectors referenced by the steps, extracted DETERMINISTICALLY (the tokens
   * in parentheses like "#email"). Surfaced as a typed field so the Validator
   * can assert every selector is real BEFORE the LLM is ever called, and so
   * traceability does not depend on re-parsing prose.
   */
  selectors: string[];
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  severity: 'critical' | 'major' | 'minor' | 'trivial';
  tags: string[];
  automationReady: boolean;
  automationComplexity: 'low' | 'medium' | 'high';
  selectorAvailability: 'high' | 'medium' | 'low' | 'unknown';
  source: 'requirement' | 'knowledge' | 'test_data' | 'app_profile';
  sourceEvidence: string;
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

function haystackFromRequirement(input?: RequirementLike): string {
  if (!input) return '';
  return [input.title, input.description, input.acceptanceCriteria, input.businessFlow]
    .filter(Boolean).join(' ').toLowerCase();
}

/** All searchable text from the App Profile + Test Data (for evidence checks). */
function haystackFromContext(k?: KnowledgeLike): string {
  const ap = k?.applicationProfile;
  const parts: string[] = [];
  if (ap) {
    for (const p of ap.pages || []) parts.push(lc(p.url), lc(p.title), lc(p.pageType));
    for (const f of ap.forms || []) {
      parts.push(lc(f.page), lc(f.action));
      for (const fd of f.fields || []) parts.push(lc(fd.name), lc(fd.label), lc(fd.type));
    }
    for (const e of ap.keyElements || []) parts.push(lc(e.label), lc(e.role), lc(e.selector));
  }
  for (const d of k?.testData || []) {
    parts.push(lc(d.name));
    for (const key of d.sampleKeys || []) parts.push(lc(key));
  }
  return parts.filter(Boolean).join(' ');
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

/** Expected-result phrasing anchored on the scenario objective + coverage type. */
function expectedResultFor(scenario: AnnotatedPlannedScenario): string {
  // The objective already states what the scenario PROVES — the most honest,
  // grounded expected result is that objective, which the LLM then sharpens.
  return scenario.objective;
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
    return { drafts: [], groundedCount: 0, conditionalKept: 0 };
  }

  const ap = knowledge?.applicationProfile;
  const category = plan.classification.category;
  const reqHay = haystackFromRequirement(input);
  const ctxHay = haystackFromContext(knowledge);
  const baseUrl = ap?.baseUrl;
  const loginUrl = ap?.loginUrl;

  const drafts: DraftTestCase[] = [];
  let groundedCount = 0;
  let conditionalKept = 0;

  plan.scenarios.forEach((scenario, index) => {
    // ── Decide whether to emit a draft for this scenario ──
    // Grounded (non-conditional) scenarios are ALWAYS emitted. Conditional
    // scenarios are emitted only when the requirement OR the retrieved context
    // actually references the behaviour — this is what raises the count beyond
    // the weak baseline WITHOUT inventing ungrounded scenarios.
    if (scenario.conditional) {
      const keywords = scenario.conditionalOnKeywords || [];
      const supported = keywords.some(k => reqHay.includes(lc(k)) || ctxHay.includes(lc(k)));
      if (!supported) return; // skip — nothing supports it
      conditionalKept += 1;
    }

    const scenarioTerms = toTerms(`${scenario.title} ${scenario.objective} ${scenario.riskArea}`);
    const form = pickForm(ap?.forms, scenarioTerms);
    const dataset = pickDataset(knowledge?.testData, scenarioTerms);

    // ── Steps ── grounded in the real form fields + submit selector when present.
    const steps: string[] = [];
    const navTarget = loginUrl || form?.page || baseUrl;
    if (navTarget) steps.push(`Navigate to ${navTarget}`);

    let usedRealSelector = false;
    const fields = (form?.fields || []).slice(0, 8);
    for (const f of fields) {
      const sel = f.selector ? ` (${f.selector})` : '';
      if (f.selector) usedRealSelector = true;
      const fieldLabel = f.label || f.name || 'field';
      steps.push(`Enter ${dataPhraseFor(scenario.coverageType, f)} in the ${fieldLabel} field${sel}`);
    }
    if (form?.submitSelector) {
      usedRealSelector = true;
      steps.push(`Click the submit control (${form.submitSelector})`);
    } else if (form) {
      steps.push('Submit the form');
    }
    if (!steps.length) {
      // No App Profile at all — still produce a usable skeleton from the objective.
      steps.push(`Exercise the "${scenario.title}" scenario against the application`);
    }
    steps.push('Observe and verify the outcome');

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

    // ── Provenance ──
    let source: DraftTestCase['source'];
    let sourceEvidence: string;
    if (usedRealSelector) {
      source = 'app_profile';
      sourceEvidence = `Real selectors from ${form?.page || 'app profile'}`;
    } else if (dataset?.name) {
      source = 'test_data';
      sourceEvidence = `${dataset.name} dataset`;
    } else {
      source = 'knowledge';
      sourceEvidence = `QA baseline for ${category}: ${scenario.id}`;
    }
    if (usedRealSelector) groundedCount += 1;

    drafts.push({
      scenarioIndex: index,
      scenarioId: scenario.id,
      title: scenario.title,
      objective: scenario.objective,
      coverageType: scenario.coverageType,
      priority: scenario.priority,
      riskArea: scenario.riskArea,
      preconditions,
      steps,
      expectedResult: expectedResultFor(scenario),
      testData,
      tags: Array.from(new Set([category, scenario.coverageType])),
      automationReady: usedRealSelector,
      selectorAvailability: usedRealSelector ? 'high' : 'unknown',
      source,
      sourceEvidence,
      grounded: usedRealSelector,
    });
  });

  return { drafts, groundedCount, conditionalKept };
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
These drafts were built by the platform from the crawled App Profile (real selectors), the Test Data sets, and the QA knowledge base — NOT guessed. Your job is to REFINE them into final, polished test cases, NOT to re-derive coverage from scratch.

Rules for using the drafts:
  • Produce one testCase per draft as the baseline, keeping its "scenarioIndex", the REAL selectors in the steps, the REAL dataset references, priority, riskArea and source. Improve ONLY the wording/specificity (sharper title, concrete values, crisp expected result).
  • You MAY split a draft into multiple concrete test cases when it genuinely covers distinct inputs/states (e.g. wrong-password vs unknown-user), and you MAY add further cases the requirement or context clearly implies. The drafts are a FLOOR, not a ceiling — never emit FEWER cases than there are drafts.
  • Do NOT invent selectors, pages or datasets not present in the drafts/context. Do NOT drop a draft unless it is truly unsupported by the requirement.
  • Keep the deterministic grounding: a draft tagged source "app_profile"/"test_data" must stay grounded in that evidence.

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
  return {
    title: draft.title,
    objective: draft.objective,
    scenarioIndex,
    scenarioId: draft.scenarioId,
    riskArea: draft.riskArea,
    preconditions: draft.preconditions,
    steps,
    expectedResult: draft.expectedResult,
    testData: draft.testData,
    selectors: extractSelectors(steps),
    priority: draft.priority,
    severity: SEVERITY_FOR_PRIORITY[draft.priority] || 'major',
    tags: draft.tags.slice(),
    automationReady: draft.automationReady,
    automationComplexity: draft.grounded ? 'low' : 'medium',
    selectorAvailability: draft.selectorAvailability,
    source: draft.source === 'requirement' ? 'knowledge' : draft.source,
    sourceEvidence: draft.sourceEvidence,
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
  return `You are a senior QA technical editor. Below are ${testCases.length} test cases that were assembled DETERMINISTICALLY from the real application. The logic, selectors, data and coverage are FINAL — only the English needs polishing.

YOUR ONLY JOB: sharpen the wording of "title", "objective", "preconditions", "expected" and re-phrase each step for clarity.

STRICT RULES (violating any is a failure):
  • Return EXACTLY ${testCases.length} objects in the SAME order, each with the SAME "id". Never add, remove, split, merge or reorder.
  • Keep the SAME number of steps per case and the SAME action per step — reword only. Preserve every selector/URL token in parentheses (e.g. "(#email)") and any http URL EXACTLY.
  • Do not add fields. Do not invent steps, selectors, pages or data.

Return ONLY valid JSON (no prose):
{ "cases": ${'[{ "id": string, "title": string, "objective": string, "preconditions": string, "steps": string[], "expected": string }]'} }

TEST CASES TO POLISH:
${payload}`;
}

/**
 * Re-attach the LLM's polished wording to the deterministic canonical objects.
 *
 * Coverage/logic NEVER depend on the model: we start from the deterministic
 * cases (the source of truth) and overlay ONLY the wording fields, matched by
 * canonical `id` (falling back to positional order when ids are absent). Any
 * field the model omitted, blanked, or returned with a changed step-count is
 * kept from the deterministic object. If the model broke the contract (wrong
 * count), the caller ships the deterministic output unchanged.
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
    const steps =
      Array.isArray(p.steps) &&
      p.steps.length === det.steps.length &&
      p.steps.every((s: unknown) => typeof s === 'string' && (s as string).trim().length > 0)
        ? (p.steps as string[])
        : det.steps;
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
