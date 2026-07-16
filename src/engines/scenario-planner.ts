/**
 * Scenario Planner — the SINGLE SOURCE OF TRUTH for "what scenarios exist".
 * ============================================================================
 *
 * Architectural boundary (do not blur it):
 *
 *   The Scenario Planner is the ONLY component allowed to decide whether a
 *   business scenario exists. Everything downstream — the QA Knowledge Engine
 *   (enrichment), the Scenario Builder (transformation), the Script Composer,
 *   Healing — treats the planner's output as IMMUTABLE. They enrich, transform,
 *   validate or consume scenarios; they never create or remove them.
 *
 * A scenario earns its place from its OBLIGATION, which the KNOWLEDGE BASE (not
 * the Planner) owns as data — see `getScenarioObligation`, which returns a
 * { level, condition } pair. The Planner applies one fixed, generic rule based
 * on `condition`:
 *
 *   • condition 'always'   — emitted for every feature of the category, grounded
 *                            in the Requirement that established the category, NOT
 *                            in keyword evidence. The happy-path (`core`) and the
 *                            category obligations (e.g. "invalid credentials
 *                            rejected" for a credential login) are both 'always'.
 *   • condition 'evidence' — justified ONLY by explicit evidence, matched in this
 *                            priority order:
 *                              1. Acceptance Criteria   (the strongest, explicit spec)
 *                              2. Requirement description
 *                              3. App Knowledge         (pages/elements/forms crawled)
 *                              4. Test Data             (supplied datasets)
 *                            An 'evidence' scenario with no recognised evidence is
 *                            NOT planned — this is where "no invention" is enforced.
 *
 * `level` ('required' | 'optional') describes the STRENGTH of the obligation. It
 * is carried through for future prioritisation / coverage-gap reporting but does
 * not yet gate emission — `condition` alone decides what is planned.
 *
 * Separation of concerns (the whole point of this layer):
 *
 *   • The Planner maps EVIDENCE → SCENARIO IDENTITIES. It stays "dumb": it does
 *     NOT decide which scenarios are obligations, and it does NOT know testing
 *     heuristics (what "lockout"/"sql injection"/"expired" mean). Both the
 *     obligation metadata and the recognition vocabulary + matching live in the
 *     Knowledge layer (`getScenarioObligation`, `recognizeScenarioEvidence`), so
 *     the Planner never turns into a second knowledge engine.
 *   • The Planner emits FACTS (structured `evidence`), NOT scores. Confidence is
 *     computed downstream by the orchestrator (`computeConfidence`) so scoring
 *     is consistent across the whole platform and the Planner has one job.
 *
 * Coverage Types authorise CATEGORIES; the Knowledge Base owns the CONTENT
 * (Sprint 6.x). Two rules, no invention in either:
 *   • A family the user did NOT select stays strictly evidence-grounded — Phase 2
 *     only. It can never conjure a CONDITIONAL scenario the requirement / AC /
 *     app / data never mention.
 *   • A family the user EXPLICITLY selected (e.g. Negative, Edge) additionally
 *     emits that category's KB-curated best-practice obligations (Phase 3b),
 *     clearly tagged assumption / 'Standard Coverage'. Selecting the family IS
 *     the instruction to test it; the content is still authored KNOWLEDGE, never
 *     hallucinated. This is what makes a balanced Positive/Negative/Edge suite
 *     the DEFAULT rather than something only Deep Research produces.
 * A bare "user can log in" requirement therefore yields the category's core +
 * mandatory obligations plus the KB obligations for whatever families the user
 * asked for — not a padded list of invented failures. Quality over quantity.
 *
 * Every planned scenario carries its provenance:
 *
 *   { whyExists, source, derivedFrom, assumption, evidence[] }
 *
 * If the planner cannot attach at least one piece of evidence to a scenario,
 * that scenario is NOT planned — it does not exist. This gives explainability,
 * not just a filter.
 *
 * The planner is PURE + synchronous (ZERO LLM tokens).
 */

import type { CoverageType, RequirementInput } from './test-coverage-engine';
import {
  classifyQACategory,
  getBaselineScenarios,
  getScenarioObligation,
  recognizeScenarioEvidence,
  QA_KNOWLEDGE_VERSION,
  type QACategory,
  type PlannedScenario,
  type QACategoryClassification,
  type ScenarioEvidence,
  type EvidenceSource,
  type NormalizedEvidence,
} from './qa-knowledge-engine';

import { coverageFamily, type CoverageFamily } from './generation-quality-engine';

export type { ScenarioEvidence, EvidenceSource } from './qa-knowledge-engine';

/** Where a scenario's justification came from (explicit evidence only). */
export type ProvenanceSource =
  | 'Requirement'
  | 'Acceptance Criteria'
  | 'App Knowledge'
  | 'Test Data'
  /**
   * Deep Coverage (Sprint 5.2) — a domain best-practice scenario emitted ONLY
   * when the user opts into Deep Coverage. It is grounded in the QA Knowledge
   * Base's obligations for the detected category (NOT hallucinated), but is not
   * gated on explicit evidence in THIS requirement. Always carries assumption:true
   * so it is never mistaken for requirement-grounded coverage.
   */
  | 'Deep Coverage'
  /**
   * Standard Coverage (Sprint 6.x) — a domain best-practice scenario emitted
   * because the user EXPLICITLY selected its coverage family (e.g. Negative or
   * Edge), even with Deep Coverage OFF. Like Deep Coverage it is grounded in the
   * QA Knowledge Base's obligations for the detected category (NOT hallucinated)
   * and always carries assumption:true, but it is authorised by the user's
   * explicit type selection rather than the Deep toggle. This is what makes a
   * balanced Positive/Negative/Edge suite the default.
   */
  | 'Standard Coverage';

/** Map the machine evidence source to the human-readable provenance bucket. */
const SOURCE_LABEL: Record<EvidenceSource, ProvenanceSource> = {
  acceptanceCriteria: 'Acceptance Criteria',
  requirement: 'Requirement',
  appKnowledge: 'App Knowledge',
  testData: 'Test Data',
};

/**
 * Why a scenario exists. This is the planner's contract: a scenario without at
 * least one piece of `evidence` is never emitted.
 *
 * NOTE: there is deliberately NO numeric confidence here. The Planner emits
 * facts (evidence); the orchestrator scores them (`computeConfidence`).
 */
export interface ScenarioProvenance {
  /** Human sentence explaining why this scenario was derived. */
  whyExists: string;
  /** The (highest-priority) evidence bucket that justified it. */
  source: ProvenanceSource;
  /** The exact evidence text of the highest-priority match (readable citation). */
  derivedFrom: string;
  /**
   * By construction the planner ONLY emits evidence-backed scenarios, so this is
   * always false. Retained (salvaged from the earlier provenance model) so any
   * future inferred scenario could be flagged honestly instead of silently.
   */
  assumption: boolean;
  /**
   * The structured, strongly-typed evidence that justifies this scenario — every
   * matching AC clause / requirement / app-knowledge / test-data item, in
   * priority order. This is the reusable contract downstream modules (Script
   * Gen, Healing, RCA, Impact Analysis, Explainability) consume so they can
   * explain WHY a scenario exists without reparsing the requirement.
   */
  evidence: ScenarioEvidence[];
}

/** A planned scenario annotated with the provenance that justifies it. */
export interface PlannedScenarioWithProvenance extends PlannedScenario {
  provenance: ScenarioProvenance;
}

/**
 * A single EXPLICIT requirement step — a numbered instruction, bullet, acceptance
 * criterion, or business-flow line the author actually wrote. Sprint 5.1 makes
 * these the PRIMARY source of scenarios: every step must be represented by at
 * least one generated test case before any baseline/deep coverage is added.
 */
export interface RequirementStep {
  /** Stable id: req-step-<n>. */
  id: string;
  /** The exact author text of the step (readable citation, capped). */
  text: string;
  /** Which requirement field this step was extracted from. */
  source: 'acceptanceCriteria' | 'description' | 'businessFlow';
  /** Coverage type inferred from the step's wording (positive default). */
  coverageType: CoverageType;
}

/** Per-step coverage record — powers the "Requirement Coverage X/Y" KPI. */
export interface RequirementStepCoverage {
  id: string;
  text: string;
  source: RequirementStep['source'];
  /** True when at least one planned scenario represents this step. */
  covered: boolean;
  /** Ids of the planned scenarios that cover this step. */
  scenarioIds: string[];
}

/**
 * The Requirement Coverage summary — the headline trust metric. The product
 * guarantee (Sprint 5.1) is that this is ALWAYS 100%: no explicit requirement
 * step is left without a test case.
 */
export interface RequirementCoverage {
  steps: RequirementStepCoverage[];
  total: number;
  covered: number;
  /** Integer percent 0-100. */
  percent: number;
}

export interface ScenarioPlan {
  /** Detected QA category + confidence + the signals that drove it. */
  classification: QACategoryClassification;
  /** The justified scenarios (filtered to the user's selected coverage types). */
  scenarios: PlannedScenarioWithProvenance[];
  /** Count of justified scenarios (== scenarios.length; all are evidence-backed). */
  justifiedCount: number;
  /**
   * Requirement Coverage — the mandatory per-step coverage map (Sprint 5.1).
   * Guaranteed 100% because unmatched steps synthesize a requirement-derived
   * scenario. Undefined only on the legacy zero-requirement edge.
   */
  requirementCoverage: RequirementCoverage;
  /** KB version for telemetry correlation. */
  knowledgeVersion: string;
  /** Whether the plan is empty (generic category or nothing justified). */
  isEmpty: boolean;
}

/**
 * Minimal shape of the knowledge context the planner reads for evidence.
 * Deliberately permissive (index signatures) so the richer engine
 * `KnowledgeContext` is structurally assignable without a cast — the planner
 * only reads the handful of fields below and ignores the rest.
 */
interface PlannerKnowledge {
  applicationProfile?: {
    name?: string;
    pages?: Array<{ title?: string; pageType?: string; [k: string]: any }>;
    keyElements?: Array<{ label?: string; role?: string; tag?: string; [k: string]: any }>;
    forms?: Array<{ submitLabel?: string; [k: string]: any }>;
    [k: string]: any;
  };
  testData?: Array<{ name?: string; sampleKeys?: string[]; [k: string]: any }>;
  [k: string]: any;
}

const lc = (s?: string) => (s || '').toLowerCase();

/**
 * Split acceptance criteria into individual clauses so a matched scenario can
 * cite the SPECIFIC criterion it came from (not the whole blob). Splits on
 * newlines, bullets, semicolons and numbered markers — no NLP, fully
 * deterministic.
 */
function splitAcceptanceClauses(ac?: string): string[] {
  if (!ac) return [];
  return ac
    .split(/\r?\n|;|•|\u2022|\u2023|\u25E6|(?:^|\s)[-*]\s+|\d+[.)]\s+/)
    .map(c => c.trim())
    .filter(c => c.length > 0);
}

/** Cap evidence text so provenance stays a readable citation, not a dump. */
function cap(s: string, n = 160): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** All searchable App Knowledge text — page titles/types, element labels/roles,
 * form submit labels. Deliberately EXCLUDES field names so a password/username
 * field never false-matches a security/negative keyword. */
function appKnowledgeText(k?: PlannerKnowledge): string {
  const ap = k?.applicationProfile;
  if (!ap) return '';
  const parts: string[] = [];
  if (ap.name) parts.push(ap.name);
  for (const p of ap.pages || []) { if (p.title) parts.push(p.title); if (p.pageType) parts.push(p.pageType); }
  for (const e of ap.keyElements || []) { if (e.label) parts.push(e.label); if (e.role) parts.push(e.role); }
  for (const f of ap.forms || []) { if (f.submitLabel) parts.push(f.submitLabel); }
  return lc(parts.join(' '));
}

/** All searchable Test Data text — dataset names + sample keys. */
function testDataText(k?: PlannerKnowledge): string {
  const parts: string[] = [];
  for (const d of k?.testData || []) {
    if (d.name) parts.push(d.name);
    for (const key of d.sampleKeys || []) parts.push(key);
  }
  return lc(parts.join(' '));
}

/**
 * Assemble the normalized evidence buckets for a requirement. This is evidence
 * COLLECTION (which the Planner owns for now — a dedicated Evidence Collector is
 * a later stage). The MATCHING against this evidence is owned by the Knowledge
 * layer (`recognizeScenarioEvidence`), never here.
 */
function buildEvidence(
  input: Pick<RequirementInput, 'title' | 'description' | 'module' | 'businessFlow' | 'acceptanceCriteria'>,
  knowledge?: PlannerKnowledge,
): NormalizedEvidence {
  return {
    requirementText: lc([input.title, input.description, input.module, input.businessFlow].filter(Boolean).join(' ')),
    requirementLabel: cap((input.title || input.description || 'the requirement').trim()),
    acceptanceClauses: splitAcceptanceClauses(input.acceptanceCriteria),
    appKnowledge: appKnowledgeText(knowledge),
    testData: testDataText(knowledge),
  };
}

/**
 * Derive the provenance for a baseline scenario, or null if the evidence does
 * not justify it (⇒ the scenario is not planned). This is where "no invention"
 * is enforced — an 'evidence' scenario with no recognised evidence simply does
 * not exist.
 *
 * The Planner does NOT decide WHICH scenarios are obligations, nor does it
 * inspect keywords: it asks the Knowledge layer for the scenario's obligation
 * (`getScenarioObligation`) and delegates recognition to it
 * (`recognizeScenarioEvidence`). It only maps the result into provenance. No
 * numeric confidence is attached — the orchestrator scores the evidence
 * downstream.
 *
 * Two emission paths, keyed off obligation.condition (owned by the KB):
 *   • 'always'   — justified by the Requirement that established the category.
 *                  `core` reads as the primary happy-path; every other 'always'
 *                  obligation reads as a category obligation. No keyword needed.
 *   • 'evidence' — justified ONLY by recognised explicit evidence, else dropped.
 */
function deriveProvenance(
  scenario: PlannedScenario,
  ev: NormalizedEvidence,
  category: QACategory,
): ScenarioProvenance | null {
  const obligation = getScenarioObligation(scenario);

  // ALWAYS obligations are emitted for ANY feature of this category — the KB
  // declares them, the Planner just honours them. They are grounded in the
  // Requirement that ESTABLISHED the category (not in keyword evidence), so the
  // citation is the requirement itself. This is an evidence MAPPING (obligation ⇒
  // requirement evidence), not a testing heuristic, so it stays in the Planner.
  // The only difference between the happy-path and the other always-obligations
  // is the human-readable reason: `core` is the primary flow the requirement
  // states, the rest are category obligations the requirement implies.
  if (obligation.condition === 'always') {
    const evidence: ScenarioEvidence[] = [{
      id: `${scenario.id}:req`,
      source: 'requirement',
      reference: 'REQ',
      excerpt: ev.requirementLabel,
    }];
    const whyExists = scenario.core
      ? 'Primary happy-path stated by the requirement'
      : `Standard ${category} obligation — expected for any ${category} feature, independent of the specific wording`;
    return {
      whyExists,
      source: 'Requirement',
      derivedFrom: ev.requirementLabel,
      assumption: false,
      evidence,
    };
  }

  // EVIDENCE obligations: ask the Knowledge layer which evidence recognises this
  // scenario. Nothing recognised → not planned (the Planner never invents).
  const evidence = recognizeScenarioEvidence(scenario, ev);
  if (!evidence.length) return null; // no recognised evidence → not planned

  // The highest-priority match (evidence is returned AC → REQ → AK → TD) drives
  // the human-readable provenance summary.
  const primary = evidence[0];
  return {
    whyExists: `Justified by ${SOURCE_LABEL[primary.source]}: "${primary.excerpt}"`,
    source: SOURCE_LABEL[primary.source],
    derivedFrom: primary.excerpt,
    assumption: false,
    evidence,
  };
}

/* ---------------------------------------------------------------------------
 * Sprint 5.1 — Requirement Completeness
 * The requirement is the PRIMARY source of scenarios. We extract every explicit
 * step (numbered instruction / bullet / acceptance criterion / business-flow
 * line) and GUARANTEE each is represented by at least one scenario. The baseline
 * library is ADDITIVE (adds quality) — it never replaces requirement coverage.
 * ------------------------------------------------------------------------- */

/** Splitter for explicit step markers: newlines, bullets, numbered markers,
 *  flow arrows, and sentence terminators. Deterministic — no NLP. */
const STEP_SPLIT_RE = /\r?\n|(?:^|\s)[-*]\s+|[•\u2022\u2023\u25E6]|\d+[.)]\s+|→|=>|(?<=[.!?])\s+(?=[A-Z0-9"'(])/;

/** Leading BDD / ordinal noise we strip so two phrasings of the same step match. */
const STEP_PREFIX_RE = /^\s*(?:given|when|then|and|but|step\s*\d+|scenario)\b[:.)\-]?\s*/i;

/** Words that add no meaning to token-overlap similarity. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'is', 'are', 'be', 'in', 'on', 'for',
  'with', 'that', 'this', 'it', 'as', 'at', 'by', 'from', 'should', 'must', 'will',
  'shall', 'can', 'user', 'users', 'system', 'when', 'then', 'given', 'if',
]);

/** Cues that flip an extracted step's inferred coverage type away from positive. */
const NEGATIVE_CUES = ['invalid', 'incorrect', 'reject', 'error', 'fail', 'must not', 'cannot', "can't", 'denied', 'deny', 'unauthorized', 'unauthorised', 'blocked', 'forbidden', 'not allowed', 'wrong', 'missing', 'empty', 'without', 'prevent'];
const BOUNDARY_CUES = ['maximum', 'minimum', ' max ', ' min ', 'at least', 'at most', 'up to', 'no more than', 'no less than', 'limit', 'characters', 'length', 'between', 'exceed'];
const SECURITY_CUES = ['injection', 'xss', 'csrf', 'sql', 'sanitiz', 'sanitis', 'malicious', 'session token', 'brute', 'permission', 'role', 'authorization', 'authorisation', 'access control'];

function inferStepCoverageType(text: string): CoverageType {
  const t = lc(` ${text} `);
  if (SECURITY_CUES.some(c => t.includes(c))) return 'security';
  if (BOUNDARY_CUES.some(c => t.includes(c))) return 'boundary';
  if (NEGATIVE_CUES.some(c => t.includes(c))) return 'negative';
  return 'positive';
}

/** Normalize step text to a comparable token set (lowercase, stopwords removed). */
function tokenize(text: string): Set<string> {
  return new Set(
    lc(text)
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w)),
  );
}

/** Jaccard token overlap of two texts (0-1). */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** A short, readable scenario title from a longer step sentence. */
function stepTitle(text: string): string {
  const words = text.replace(/[.;:]+$/, '').split(/\s+/);
  const short = words.slice(0, 9).join(' ');
  const titled = short.charAt(0).toUpperCase() + short.slice(1);
  return words.length > 9 ? `${titled}…` : titled;
}

/**
 * Extract explicit requirement steps from the acceptance criteria, description
 * and business flow. Steps are de-duplicated (lexically) across fields, in
 * priority order AC → description → businessFlow, so the strongest spec wins.
 */
export function extractRequirementSteps(
  input: Partial<Pick<RequirementInput, 'description' | 'businessFlow' | 'acceptanceCriteria'>>,
): RequirementStep[] {
  const fields: Array<{ source: RequirementStep['source']; raw?: string }> = [
    { source: 'acceptanceCriteria', raw: input.acceptanceCriteria },
    { source: 'description', raw: input.description },
    { source: 'businessFlow', raw: input.businessFlow },
  ];

  const steps: RequirementStep[] = [];
  const seen: Set<string>[] = []; // token sets already accepted (for cross-field dedup)
  let n = 0;

  for (const { source, raw } of fields) {
    if (!raw || !raw.trim()) continue;
    const fragments = raw
      .split(STEP_SPLIT_RE)
      .map(f => (f || '').replace(STEP_PREFIX_RE, '').trim())
      .filter(f => f.length >= 4 && /[a-z0-9]/i.test(f));

    for (const frag of fragments) {
      const toks = tokenize(frag);
      if (toks.size === 0) continue;
      // Skip if a near-identical step was already captured (>= 0.8 overlap).
      if (seen.some(prev => jaccard(prev, toks) >= 0.8)) continue;
      seen.push(toks);
      n += 1;
      steps.push({
        id: `req-step-${n}`,
        text: cap(frag, 200),
        source,
        coverageType: inferStepCoverageType(frag),
      });
      if (steps.length >= MAX_REQUIREMENT_STEPS) return steps; // runaway guard
    }
  }
  return steps;
}

/** Upper bound on extracted steps so a pathological paste never explodes the plan. */
const MAX_REQUIREMENT_STEPS = 60;

/** How close a scenario must be to a step (token overlap) to "cover" it. */
const STEP_COVER_THRESHOLD = 0.34;

/* ------------------------------------------------------------------ */
/*  Field-aware expansion                                              */
/*                                                                     */
/*  A senior QA does NOT collapse validation into a single generic     */
/*  "missing required field" case — they write a per-field check for   */
/*  each input the form actually names (blank, whitespace, length,     */
/*  type). The generic CRUD obligations state each CONCEPT once; this  */
/*  pass expands the concept across the FIELDS the requirement names,  */
/*  so the generated suite reads like a human wrote it. Pure +         */
/*  deterministic; the fields are read from the requirement text and   */
/*  never hardcoded.                                                   */
/* ------------------------------------------------------------------ */

type FieldKind = 'name' | 'id' | 'text';
interface InputField { label: string; slug: string; kind: FieldKind; }

/** Compound field nouns worth expanding, most-specific first so "first name"
 *  wins over the bare "name". Deliberately small + generic. */
const FIELD_NOUNS: string[] = [
  'first name', 'last name', 'full name', 'middle name', 'display name',
  'employee id', 'user id', 'product id', 'order id', 'employee code',
  'name', 'email', 'phone', 'mobile', 'address', 'city', 'zip', 'postal code',
  'username', 'title', 'description', 'quantity', 'price', 'sku', 'code',
];

/** File-ish fields are covered by the upload obligations — never text-expanded. */
const FILE_FIELD_RE = /\b(photo|image|picture|avatar|file|attachment|document|logo)\b/;

/** An explicit field-list clause: "entering X, Y and Z" / "with X, Y, Z". */
const FIELD_CLAUSE_RE =
  /\b(?:enter(?:ing)?|with|includ(?:ing|es?)|provid(?:e|ing)|input|containing|contains?|fields?|capturing?)\b[:\s]+([^.;]+)/i;

function classifyFieldKind(label: string): FieldKind {
  if (/\b(id|code|number|no)\b/.test(label)) return 'id';
  if (/\bname\b/.test(label)) return 'name';
  return 'text';
}

function titleCaseField(label: string): string {
  return label.replace(/\b([a-z])/g, (_, c) => c.toUpperCase());
}

/** Extract the distinct input fields a requirement names. Two passes:
 *  (a) an explicit list clause ("entering X, Y and Z");
 *  (b) a scan for well-known field nouns anywhere in the text. */
function extractInputFields(text: string): InputField[] {
  const found = new Map<string, InputField>(); // slug -> field (dedup)
  const add = (raw: string) => {
    let label = raw.toLowerCase().trim()
      .replace(/^(an?|the|its?|their|optional|new|valid|unique)\s+/g, '')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    label = label.replace(/\b(field|value|details?)$/, '').trim();
    if (!label || label.length > 40) return;
    if (label.split(' ').length > 4) return;
    if (FILE_FIELD_RE.test(label)) return; // uploads handled by upload obligations
    const slug = label.replace(/\s+/g, '-');
    if (!slug || found.has(slug)) return;
    found.set(slug, { label, slug, kind: classifyFieldKind(label) });
  };

  const lower = ` ${text.toLowerCase().replace(/\s+/g, ' ')} `;

  const clause = text.match(FIELD_CLAUSE_RE);
  if (clause) for (const frag of clause[1].split(/,|\band\b|\/|;/i)) add(frag);

  for (const noun of FIELD_NOUNS) {
    if (lower.includes(` ${noun} `) || lower.includes(` ${noun},`) || lower.includes(` ${noun}.`)) add(noun);
  }

  // If a specific name field (first/last name) was captured, drop the bare
  // "name" — the specific fields are what a QA actually expands.
  if ([...found.values()].some(f => f.kind === 'name' && f.slug !== 'name')) found.delete('name');

  return [...found.values()];
}

/** Build the per-field validation + boundary scenarios a senior QA writes when
 *  a data-entry form names its fields. Each objective literally names the field
 *  so it reads like a hand-authored suite. Returns bare PlannedScenarios —
 *  planScenarios tags them Standard/Deep coverage (assumption, never grounded). */
function fieldAwareScenarios(fields: InputField[]): PlannedScenario[] {
  if (fields.length === 0) return [];
  const out: PlannedScenario[] = [];
  const nameFields = fields.filter(f => f.kind === 'name');
  const idFields = fields.filter(f => f.kind === 'id');
  const textFields = fields.filter(f => f.kind === 'text');

  // (1) Whitespace-only — a DISTINCT per-field check (trimming can be missed on
  //     any single field). Emit for each named name/text field (cap 4).
  for (const f of [...nameFields, ...textFields].slice(0, 4)) {
    out.push({
      id: `field-${f.slug}-whitespace`,
      title: `${titleCaseField(f.label)} containing only whitespace is rejected`,
      objective: `A ${f.label} value of only whitespace / spaces is trimmed to blank and rejected as required — whitespace-only ${f.label}.`,
      coverageType: 'negative', priority: 'P1', riskArea: 'Input validation',
    });
  }

  // (2) All-required-blank — one cross-field submit when 2+ required fields.
  const requiredish = [...nameFields, ...idFields, ...textFields];
  if (requiredish.length >= 2) {
    const bothNames = nameFields.length >= 2 ? 'both names blank / ' : '';
    out.push({
      id: 'field-all-required-blank',
      title: 'All required fields blank is rejected',
      objective: `Submitting with ${bothNames}all required fields blank at once is rejected, with a validation error on every empty field.`,
      coverageType: 'negative', priority: 'P1', riskArea: 'Input validation',
    });
  }

  // (3) Numeric-in-name — once, on the first name field (a name-type rule).
  if (nameFields.length) {
    const f = nameFields[0];
    out.push({
      id: `field-${f.slug}-numeric`,
      title: `Numeric digits in the ${f.label} are handled per rule`,
      objective: `Numbers in name input — digits entered in the ${f.label} (e.g. "John123") — are validated per the field rule (digits in ${f.label}).`,
      coverageType: 'negative', priority: 'P2', riskArea: 'Input validation',
    });
  }

  // (4) Max-length accepted + one-over rejected — on the first name field and
  //     each id field (representative boundaries a QA always checks).
  for (const f of [...nameFields.slice(0, 1), ...idFields]) {
    out.push({
      id: `field-${f.slug}-max-accepted`,
      title: `${titleCaseField(f.label)} at maximum length is accepted`,
      objective: `A ${f.label} exactly at the maximum length is accepted and stored — ${f.label} max length boundary.`,
      coverageType: 'boundary', priority: 'P2', riskArea: 'Boundary handling',
    });
    out.push({
      id: `field-${f.slug}-over-max`,
      title: `${titleCaseField(f.label)} over the maximum length is rejected`,
      objective: `A ${f.label} one character over the maximum length is rejected — ${f.label} too long / exceeds max length.`,
      coverageType: 'boundary', priority: 'P2', riskArea: 'Boundary handling',
    });
  }

  // (5) Minimum single-character + (6) unicode/accented — once, on first name.
  if (nameFields.length) {
    const f = nameFields[0];
    out.push({
      id: `field-${f.slug}-min`,
      title: `Single-character ${f.label} is accepted`,
      objective: `A single character ${f.label} (minimum length name) is accepted at the lower boundary — one character name.`,
      coverageType: 'boundary', priority: 'P2', riskArea: 'Boundary handling',
    });
    out.push({
      id: `field-${f.slug}-unicode`,
      title: `Unicode / accented characters in the ${f.label} are accepted`,
      objective: `Unicode name input — accented / non-ascii characters in the ${f.label} (José, O'Brien) — are accepted and stored (special characters in name).`,
      coverageType: 'boundary', priority: 'P2', riskArea: 'Boundary handling',
    });
  }

  // (7) Leading zeros — per id field (must not be truncated to a number).
  for (const f of idFields) {
    out.push({
      id: `field-${f.slug}-leading-zero`,
      title: `Leading zeros in the ${f.label} are preserved`,
      objective: `An ${f.label} entered with a leading zero (e.g. "007") is stored and displayed with the leading zero intact — not truncated to a number.`,
      coverageType: 'boundary', priority: 'P2', riskArea: 'Data integrity',
    });
  }

  return out;
}

/** Build a requirement-derived scenario for a step the baseline did not cover. */
function requirementScenario(step: RequirementStep): PlannedScenarioWithProvenance {
  const isAC = step.source === 'acceptanceCriteria';
  const sourceLabel: ProvenanceSource = isAC ? 'Acceptance Criteria' : 'Requirement';
  const evSource: EvidenceSource = isAC ? 'acceptanceCriteria' : 'requirement';
  const fieldName = step.source === 'acceptanceCriteria' ? 'Acceptance Criteria'
    : step.source === 'businessFlow' ? 'Business Flow' : 'Requirement description';
  return {
    id: step.id,
    title: stepTitle(step.text),
    objective: `Verify the requirement: "${step.text}"`,
    coverageType: step.coverageType,
    priority: 'P1',
    riskArea: 'Requirement coverage',
    provenance: {
      whyExists: `Explicit requirement step (${fieldName})`,
      source: sourceLabel,
      derivedFrom: step.text,
      assumption: false,
      evidence: [{
        id: `${step.id}:${evSource}`,
        source: evSource,
        reference: isAC ? 'AC' : 'REQ',
        excerpt: step.text,
      }],
    },
  };
}

/**
 * Build a deterministic scenario plan for a requirement.
 *
 * Pipeline (Sprint 5.1 + 5.2):
 *   1. Requirement Coverage (MANDATORY) — every explicit step gets a scenario.
 *   2. Baseline Library (additive) — evidence-justified category obligations,
 *      filtered to the user's selected coverage types.
 *   3. Deep Coverage (optional) — when `deep`, also emit the category's known
 *      obligations that lack explicit evidence, as honest best-practice cases.
 *   4. Deduplicate (lexical) — merge near-identical scenarios; requirement
 *      coverage is preserved (a step matched to a baseline scenario stays covered).
 *
 * @param input          The requirement.
 * @param coverageTypes  The user's SELECTED coverage types (a FILTER for the
 *                       baseline/deep library only — requirement steps are ALWAYS
 *                       covered regardless).
 * @param featureTypeHint Optional upstream analysis featureType hint.
 * @param knowledge      Optional App Knowledge / Test Data — additional evidence.
 * @param deep           Deep Coverage toggle (Sprint 5.2). When true, broadens
 *                       the baseline library with best-practice obligations.
 */
/**
 * Requirement-aware Deep Coverage sets (Sprint 6.x).
 *
 * Deep Coverage USED to expand every requirement to the SAME fixed 7 types
 * (positive, negative, edge_cases, boundary, security, integration, role_based).
 * That is right for a complex workflow but wasteful for a simple one — a login
 * story does not need boundary/integration/role_based, yet paid tokens for them
 * on BOTH the prompt (planned-scenario block) and completion (per-scenario
 * output budget) sides. That's what tripled a login run's tokens (4.5k → 13k)
 * for little added value.
 *
 * The fix is NOT a token cap (which would truncate genuine coverage on a big
 * requirement — explicitly forbidden by the "budget never shrinks coverage"
 * directive). Instead we make the deep set CONTEXT-AWARE: each QA category adds
 * only the extra coverage types that actually matter for it. The user's own
 * selection is always honoured on top of this (union) — we only decide what
 * Deep ADDS, never what it removes.
 */
const DEEP_COVERAGE_TYPES_BY_CATEGORY: Record<QACategory, CoverageType[]> = {
  // Auth: credential correctness + abuse resistance. No boundary/integration/RBAC.
  authentication: ['positive', 'negative', 'edge_cases', 'security'],
  // CRUD: field-level correctness + limits. No security/RBAC unless user asked.
  crud: ['positive', 'negative', 'edge_cases', 'boundary'],
  // Search: query handling + input limits.
  search: ['positive', 'negative', 'edge_cases', 'boundary'],
  // Checkout: money path — the widest legitimately-deep flow.
  checkout: ['positive', 'negative', 'edge_cases', 'boundary', 'security', 'integration'],
  // Payment: money path + gateway integration + fraud surface.
  payment: ['positive', 'negative', 'edge_cases', 'boundary', 'security', 'integration'],
  // Admin: privilege + access control is the whole point → role_based + security.
  admin: ['positive', 'negative', 'edge_cases', 'security', 'role_based'],
  // Workflow: multi-step state hand-off → integration matters, boundary rarely.
  workflow: ['positive', 'negative', 'edge_cases', 'integration'],
  // Reporting: correctness of aggregates + range limits.
  reporting: ['positive', 'negative', 'edge_cases', 'boundary'],
  // Import: file parsing + malformed input + downstream persistence.
  import: ['positive', 'negative', 'edge_cases', 'boundary', 'integration'],
  // Export: output correctness + large-set limits.
  export: ['positive', 'negative', 'edge_cases', 'boundary'],
  // Generic/unknown: stay conservative — do NOT invent security/RBAC surface for
  // a feature we couldn't classify. Positive/negative/edge is the honest floor.
  generic: ['positive', 'negative', 'edge_cases'],
};

export function planScenarios(
  input: Pick<RequirementInput, 'title' | 'description' | 'module' | 'businessFlow' | 'acceptanceCriteria'>,
  coverageTypes: CoverageType[],
  featureTypeHint?: string,
  knowledge?: PlannerKnowledge,
  deep = false,
): ScenarioPlan {
  const classification = classifyQACategory(input, featureTypeHint);
  const baseline = getBaselineScenarios(classification.category);

  // Respect the user's coverage selection for the LIBRARY only. If nothing is
  // selected, fall back to positive. In Deep mode the selection is broadened —
  // but by a REQUIREMENT-AWARE set (per category), not a fixed 7-type blast, so
  // a simple requirement is not padded with irrelevant types (see the map above).
  const deepTypes = DEEP_COVERAGE_TYPES_BY_CATEGORY[classification.category]
    ?? DEEP_COVERAGE_TYPES_BY_CATEGORY.generic;
  const base: CoverageType[] = coverageTypes.length ? coverageTypes : ['positive'];
  const selected = new Set<CoverageType>(deep ? [...base, ...deepTypes] : base);

  const evidence = buildEvidence(input, knowledge);

  const scenarios: PlannedScenarioWithProvenance[] = [];

  // ── Phase 2: Baseline library (evidence-justified) ──
  // Existing behaviour — a scenario earns its place from explicit evidence /
  // 'always' obligation. Coverage type filters; provenance decides existence.
  const emittedIds = new Set<string>();
  for (const s of baseline) {
    if (!selected.has(s.coverageType)) continue;
    const provenance = deriveProvenance(s, evidence, classification.category);
    if (!provenance) continue; // unjustified → not planned (no invention)
    scenarios.push({ ...s, provenance });
    emittedIds.add(s.id);
  }

  // ── Phase 3: Deep Coverage (optional, honest best-practice) ──
  // Emit the category's KNOWN obligations that lacked explicit evidence, marked
  // as assumption-based Deep Coverage so they are never mistaken for grounded
  // requirement coverage. This is what makes the toggle produce MORE real cases.
  if (deep) {
    for (const s of baseline) {
      if (emittedIds.has(s.id)) continue;
      if (!selected.has(s.coverageType)) continue;
      const obligation = getScenarioObligation(s);
      if (obligation.condition === 'always') continue; // already covered above
      scenarios.push({
        ...s,
        provenance: {
          whyExists: `Deep Coverage: standard ${classification.category} ${s.coverageType} check — domain best-practice, not explicitly stated in this requirement`,
          source: 'Deep Coverage',
          derivedFrom: `${classification.category} best-practice`,
          assumption: true,
          evidence: [],
        },
      });
      emittedIds.add(s.id);
    }
  }

  // ── Phase 3b (balanced default): explicitly-selected coverage families ──
  // Sprint 6.x — founder directive: a balanced Positive/Negative/Edge suite is
  // the DEFAULT, not something only Deep Research produces. When the user
  // EXPLICITLY selects a coverage family (Negative, Edge) in the UI, that
  // selection IS an instruction to test that family — so we emit that family's
  // KNOWN, KB-curated obligations as standard best-practice checks even with
  // Deep OFF. This is NOT the planner "inventing" failures: every emitted
  // scenario is a Knowledge-Base obligation authored for THIS feature category
  // (see QA_KNOWLEDGE_BASE), it is clearly tagged assumption/standard-coverage,
  // and families the user did NOT select stay strictly evidence-grounded
  // (Phase 2 only). Selection authorises the category; the KB owns the content.
  //
  // Skipped when `deep` — Phase 3 above already emitted every selected AND
  // deep-broadened obligation, so re-emitting here would duplicate.
  if (!deep) {
    const explicitFamilies = new Set<CoverageFamily>(base.map(t => coverageFamily(t)));
    for (const s of baseline) {
      if (emittedIds.has(s.id)) continue;
      const fam = coverageFamily(s.coverageType);
      // Only the CORE failure/edge families are balanced-by-default here:
      //   • positive is requirement-guaranteed by Phase 1 → skip;
      //   • advanced families (security / integration / role_based / performance)
      //     stay strictly evidence-gated (Phase 2) or Deep-gated (Phase 3) — we do
      //     NOT speculatively emit e.g. an injection or RBAC test for a bare
      //     requirement that never mentions that surface. This preserves the
      //     "no invention" invariant for advanced coverage while still making a
      //     balanced Positive/Negative/Edge suite the default.
      //   • and only families the user EXPLICITLY selected.
      if (fam === 'positive' || fam === 'advanced' || !explicitFamilies.has(fam)) continue;
      const obligation = getScenarioObligation(s);
      if (obligation.condition === 'always') continue; // already grounded in Phase 2
      // The KB's own signal for "this obligation tests a FEATURE-SPECIFIC
      // mechanism, not a category-universal best practice" is
      // `conditionalOnKeywords` (e.g. auth account-lockout, password-masking,
      // unique-constraint). Those stay strictly evidence-gated (Phase 2) or
      // Deep-gated (Phase 3): selecting a family must NOT conjure a test for a
      // mechanism the requirement never mentions. Standard Coverage emits only
      // the category-UNIVERSAL obligations (e.g. "missing required fields",
      // "invalid formats", "field-length boundaries") — the ones that apply to
      // essentially every feature in the category. This is the exact line that
      // keeps balanced-by-default from becoming invention.
      if (s.conditionalOnKeywords && s.conditionalOnKeywords.length > 0) continue;
      scenarios.push({
        ...s,
        provenance: {
          whyExists: `Standard Coverage: ${s.coverageType} check for a ${classification.category} feature — emitted because ${fam} coverage was explicitly selected (KB best-practice, not explicitly stated in this requirement)`,
          source: 'Standard Coverage',
          derivedFrom: `${classification.category} best-practice`,
          assumption: true,
          evidence: [],
        },
      });
      emittedIds.add(s.id);
    }
  }

  // ── Phase 3c: Field-aware expansion (data-entry forms) ──
  // A senior QA writes a per-field validation/boundary check for each input the
  // form names — not one generic "required field" case. For CRUD features we
  // read the fields from the requirement and expand the universal
  // validation/boundary concepts across them. Emitted only for the coverage
  // families the run already includes (so a positive-only run is untouched) and
  // tagged assumption-based (Standard/Deep Coverage) — never fake grounding.
  if (classification.category === 'crud') {
    const fieldText = `${input.title || ''}. ${input.description || ''}. ${input.acceptanceCriteria || ''}. ${input.businessFlow || ''}`;
    for (const s of fieldAwareScenarios(extractInputFields(fieldText))) {
      if (emittedIds.has(s.id)) continue;
      if (!selected.has(s.coverageType)) continue;
      scenarios.push({
        ...s,
        provenance: {
          whyExists: `${deep ? 'Deep' : 'Standard'} Coverage: per-field ${s.coverageType} check for a field this requirement names — a senior QA writes one per field rather than one generic collapse (KB best-practice, not explicitly stated)`,
          source: deep ? 'Deep Coverage' : 'Standard Coverage',
          derivedFrom: 'field-aware expansion',
          assumption: true,
          evidence: [],
        },
      });
      emittedIds.add(s.id);
    }
  }

  // ── Phase 1 (guarantee): Requirement Coverage ──
  // Extract explicit steps and ensure each maps to at least one scenario. A step
  // already represented by an emitted scenario (lexical match) is marked covered
  // by it; otherwise we synthesize a requirement-derived scenario. Requirement
  // steps are NEVER dropped for coverage-type reasons — completeness first.
  const steps = extractRequirementSteps(input);
  const scenarioTokens = scenarios.map(s => tokenize(`${s.title} ${s.objective} ${(s.conditionalOnKeywords || []).join(' ')}`));
  const coverage: RequirementStepCoverage[] = [];

  for (const step of steps) {
    const stepToks = tokenize(step.text);
    const matchedIds: string[] = [];
    let best = 0;
    scenarios.forEach((s, i) => {
      const sim = jaccard(stepToks, scenarioTokens[i]);
      if (sim >= STEP_COVER_THRESHOLD) matchedIds.push(s.id);
      if (sim > best) best = sim;
    });

    if (matchedIds.length === 0) {
      // No existing scenario represents this step → synthesize one (mandatory).
      const rs = requirementScenario(step);
      scenarios.push(rs);
      scenarioTokens.push(stepToks);
      matchedIds.push(rs.id);
    }
    coverage.push({ id: step.id, text: step.text, source: step.source, covered: true, scenarioIds: matchedIds });
  }

  const requirementCoverage: RequirementCoverage = {
    steps: coverage,
    total: coverage.length,
    covered: coverage.filter(c => c.covered).length,
    percent: coverage.length === 0 ? 100 : Math.round((coverage.filter(c => c.covered).length / coverage.length) * 100),
  };

  return {
    classification,
    scenarios,
    justifiedCount: scenarios.length,
    requirementCoverage,
    knowledgeVersion: QA_KNOWLEDGE_VERSION,
    isEmpty: scenarios.length === 0,
  };
}

/**
 * Render a scenario plan into a compact prompt block. Because the planner is now
 * the single source of truth for scenario existence, the block tells the LLM to
 * REFINE the wording of these scenarios — it must NOT invent additional
 * scenarios. Each line cites its provenance so the instruction is self-evident.
 *
 * Returns '' for an empty plan so the caller can cleanly fall back to the legacy
 * (plan-free) prompt with no dangling section.
 */
export function buildScenarioPlanBlock(plan: ScenarioPlan): string {
  if (plan.isEmpty) return '';

  // ── Phase 5: Ordering — Happy → Negative → Boundary → Edge → the rest. ──
  const TYPE_ORDER: CoverageType[] = ['positive', 'negative', 'boundary', 'edge_cases', 'security', 'integration', 'role_based'];
  const orderIdx = (t: CoverageType) => {
    const i = TYPE_ORDER.indexOf(t);
    return i === -1 ? TYPE_ORDER.length : i;
  };
  const byType = new Map<CoverageType, PlannedScenarioWithProvenance[]>();
  for (const s of plan.scenarios) {
    const arr = byType.get(s.coverageType) || [];
    arr.push(s);
    byType.set(s.coverageType, arr);
  }
  const orderedTypes = [...byType.keys()].sort((a, b) => orderIdx(a) - orderIdx(b));

  const lines: string[] = [];
  for (const type of orderedTypes) {
    lines.push(`  [${type}]`);
    // Within a type, list requirement-grounded scenarios first, then Deep Coverage.
    const items = (byType.get(type) || []).slice().sort((a, b) => {
      const aDeep = a.provenance.source === 'Deep Coverage' ? 1 : 0;
      const bDeep = b.provenance.source === 'Deep Coverage' ? 1 : 0;
      return aDeep - bDeep;
    });
    for (const s of items) {
      const tag = s.provenance.source === 'Deep Coverage' ? 'deep-coverage' : 'requirement-grounded';
      lines.push(`    • ${s.title} — ${s.objective}  (source: ${s.provenance.source}; ${tag})`);
    }
  }

  const rc = plan.requirementCoverage;
  const checklist = rc.steps
    .map((s, i) => `  ${s.covered ? '✓' : '✗'} Step ${i + 1}: ${s.text}`)
    .join('\n');
  const coverageHeader = rc.total > 0
    ? `REQUIREMENT COVERAGE: ${rc.covered}/${rc.total} (${rc.percent}%) — every explicit requirement step below MUST have at least one test case.\n${checklist}\n`
    : '';

  return `
--- DERIVED SCENARIO PLAN (QA Knowledge Engine — category: ${plan.classification.category}, confidence: ${plan.classification.confidence}) ---
These are the business scenarios justified by the explicit Requirement, Acceptance Criteria, App Knowledge and Test Data, plus (when Deep Coverage is on) domain best-practice checks clearly tagged 'deep-coverage'. They were derived deterministically and each cites the evidence that justifies it.

${coverageHeader}
Your job is to write each scenario up as a concrete, grounded test case — NOT to change WHICH scenarios exist:
  • Produce exactly one (or more, if a scenario genuinely needs multiple data variations) test case per planned scenario below.
  • DO NOT invent additional scenarios. If a failure mode / edge case is not listed here, it was not justified — leave it out.
  • DO NOT drop a planned scenario. Every line below is justified and MUST be written up — most importantly, every requirement step above must be covered.
  • Scenarios are already ordered Happy Path → Negative → Boundary → Edge; preserve that order.

PLANNED SCENARIOS (${plan.justifiedCount} justified):
${lines.join('\n')}
--- END SCENARIO PLAN ---`;
}
