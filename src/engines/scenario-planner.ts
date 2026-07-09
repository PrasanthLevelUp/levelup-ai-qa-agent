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
 * A scenario earns its place in one of three ways, and the KNOWLEDGE BASE (not
 * the Planner) decides which — see `getScenarioTier`:
 *
 *   • core        — the category's happy-path (the requirement itself).
 *   • mandatory   — a category-universal obligation the KB declares for every
 *                   feature of the category (e.g. "invalid credentials rejected"
 *                   for a credential login). Justified by the Requirement
 *                   establishing the category, NOT by keyword evidence.
 *   • conditional — justified ONLY by explicit evidence, matched in this
 *                   priority order:
 *                     1. Acceptance Criteria   (the strongest, explicit spec)
 *                     2. Requirement description
 *                     3. App Knowledge         (pages/elements/forms crawled)
 *                     4. Test Data             (supplied datasets)
 *                   A conditional scenario with no recognised evidence is NOT
 *                   planned — this is where "no invention" is enforced.
 *
 * Separation of concerns (the whole point of this layer):
 *
 *   • The Planner maps EVIDENCE → SCENARIO IDENTITIES. It stays "dumb": it does
 *     NOT decide which scenarios are obligations, and it does NOT know testing
 *     heuristics (what "lockout"/"sql injection"/"expired" mean). Both the
 *     obligation tiers and the recognition vocabulary + matching live in the
 *     Knowledge layer (`getScenarioTier`, `recognizeScenarioEvidence`), so the
 *     Planner never turns into a second knowledge engine.
 *   • The Planner emits FACTS (structured `evidence`), NOT scores. Confidence is
 *     computed downstream by the orchestrator (`computeConfidence`) so scoring
 *     is consistent across the whole platform and the Planner has one job.
 *
 * Coverage Types are a FILTER, never a creator. Selecting "negative" asks
 * "include the negative scenarios that the KB obligations / evidence justify" —
 * it can never conjure a CONDITIONAL scenario the requirement/AC/app/data never
 * mention. A bare "user can log in" requirement yields the category's core +
 * mandatory obligations (valid login, invalid credentials, required fields), not
 * a padded list of invented failures. Quality over quantity.
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
  getScenarioTier,
  recognizeScenarioEvidence,
  QA_KNOWLEDGE_VERSION,
  type QACategory,
  type PlannedScenario,
  type QACategoryClassification,
  type ScenarioEvidence,
  type EvidenceSource,
  type NormalizedEvidence,
} from './qa-knowledge-engine';

export type { ScenarioEvidence, EvidenceSource } from './qa-knowledge-engine';

/** Where a scenario's justification came from (explicit evidence only). */
export type ProvenanceSource =
  | 'Requirement'
  | 'Acceptance Criteria'
  | 'App Knowledge'
  | 'Test Data';

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

export interface ScenarioPlan {
  /** Detected QA category + confidence + the signals that drove it. */
  classification: QACategoryClassification;
  /** The justified scenarios (filtered to the user's selected coverage types). */
  scenarios: PlannedScenarioWithProvenance[];
  /** Count of justified scenarios (== scenarios.length; all are evidence-backed). */
  justifiedCount: number;
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
 * is enforced — a CONDITIONAL scenario with no recognised evidence simply does
 * not exist.
 *
 * The Planner does NOT decide WHICH scenarios are obligations, nor does it
 * inspect keywords: it asks the Knowledge layer for the scenario's obligation
 * tier (`getScenarioTier`) and delegates recognition to it
 * (`recognizeScenarioEvidence`). It only maps the result into provenance. No
 * numeric confidence is attached — the orchestrator scores the evidence
 * downstream.
 *
 * Three tiers (all owned by the KB, see `getScenarioTier`):
 *   • core        — the requirement's happy-path; justified by the Requirement.
 *   • mandatory   — a category-universal obligation; also justified by the
 *                   Requirement establishing the feature category (no keyword
 *                   evidence needed — the KB, not the Planner, declares it).
 *   • conditional — justified ONLY by recognised explicit evidence, else dropped.
 */
function deriveProvenance(
  scenario: PlannedScenario,
  ev: NormalizedEvidence,
  category: QACategory,
): ScenarioProvenance | null {
  const tier = getScenarioTier(scenario);

  // The core happy-path is the requirement itself — always justified by it.
  // This is an evidence MAPPING (core scenario ⇒ requirement evidence), not a
  // testing heuristic, so it stays in the Planner.
  if (tier === 'core') {
    const evidence: ScenarioEvidence[] = [{
      id: `${scenario.id}:req`,
      source: 'requirement',
      reference: 'REQ',
      excerpt: ev.requirementLabel,
    }];
    return {
      whyExists: 'Primary happy-path stated by the requirement',
      source: 'Requirement',
      derivedFrom: ev.requirementLabel,
      assumption: false,
      evidence,
    };
  }

  // A mandatory obligation is emitted for ANY feature of this category — the KB
  // declares it, the Planner just honours it. It is grounded in the Requirement
  // establishing the feature category (not in keyword evidence), so the citation
  // is the requirement itself and the reason names the category obligation.
  if (tier === 'mandatory') {
    const evidence: ScenarioEvidence[] = [{
      id: `${scenario.id}:req`,
      source: 'requirement',
      reference: 'REQ',
      excerpt: ev.requirementLabel,
    }];
    return {
      whyExists: `Standard ${category} obligation — expected for any ${category} feature, independent of the specific wording`,
      source: 'Requirement',
      derivedFrom: ev.requirementLabel,
      assumption: false,
      evidence,
    };
  }

  // Conditional: ask the Knowledge layer which evidence recognises this scenario.
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

/**
 * Build a deterministic scenario plan for a requirement.
 *
 * @param input          The requirement.
 * @param coverageTypes  The user's SELECTED coverage types (a FILTER — we only
 *                       keep justified scenarios whose type the user picked).
 * @param featureTypeHint Optional upstream analysis featureType hint.
 * @param knowledge      Optional App Knowledge / Test Data — additional evidence
 *                       the planner may derive scenarios from.
 */
export function planScenarios(
  input: Pick<RequirementInput, 'title' | 'description' | 'module' | 'businessFlow' | 'acceptanceCriteria'>,
  coverageTypes: CoverageType[],
  featureTypeHint?: string,
  knowledge?: PlannerKnowledge,
): ScenarioPlan {
  const classification = classifyQACategory(input, featureTypeHint);
  const baseline = getBaselineScenarios(classification.category);

  // Respect the user's coverage selection: never keep a scenario for a type the
  // user did not select. If nothing is selected, fall back to positive so a plan
  // can still form (matches the engine's own default).
  const selected = new Set<CoverageType>(coverageTypes.length ? coverageTypes : ['positive']);

  const evidence = buildEvidence(input, knowledge);

  // Derive ONLY the scenarios explicit evidence justifies. Coverage type filters;
  // provenance decides existence.
  const scenarios: PlannedScenarioWithProvenance[] = [];
  for (const s of baseline) {
    if (!selected.has(s.coverageType)) continue;
    const provenance = deriveProvenance(s, evidence, classification.category);
    if (!provenance) continue; // unjustified → not planned (no invention)
    scenarios.push({ ...s, provenance });
  }

  return {
    classification,
    scenarios,
    justifiedCount: scenarios.length,
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

  // Group by coverage type for a clean, senior-QA-style checklist.
  const byType = new Map<CoverageType, PlannedScenarioWithProvenance[]>();
  for (const s of plan.scenarios) {
    const arr = byType.get(s.coverageType) || [];
    arr.push(s);
    byType.set(s.coverageType, arr);
  }

  const lines: string[] = [];
  for (const [type, items] of byType) {
    lines.push(`  [${type}]`);
    for (const s of items) {
      lines.push(`    • ${s.title} — ${s.objective}  (source: ${s.provenance.source})`);
    }
  }

  return `
--- DERIVED SCENARIO PLAN (QA Knowledge Engine — category: ${plan.classification.category}, confidence: ${plan.classification.confidence}) ---
These are the ONLY business scenarios justified by the explicit Requirement, Acceptance Criteria, App Knowledge and Test Data. They were derived deterministically and each cites the evidence that justifies it.

Your job is to write each scenario up as a concrete, grounded test case — NOT to change WHICH scenarios exist:
  • Produce exactly one (or more, if a scenario genuinely needs multiple data variations) test case per planned scenario below.
  • DO NOT invent additional scenarios. If a failure mode / edge case is not listed here, the evidence did not justify it — leave it out.
  • DO NOT drop a planned scenario. Every line below is justified and must be written up.

PLANNED SCENARIOS (${plan.justifiedCount} justified):
${lines.join('\n')}
--- END SCENARIO PLAN ---`;
}
