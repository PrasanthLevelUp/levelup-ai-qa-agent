/**
 * Requirement Understanding — public types.
 *
 * The Requirement Understanding Engine answers ONE question, deterministically
 * and with no LLM:
 *
 *     "Given a requirement (and, when available, what the repository already
 *      knows), what is the BUSINESS MODEL under test — the entities, actions,
 *      fields, and business rules?"
 *
 * It is the layer that MUST exist before a Coverage Matrix can. A Coverage
 * Matrix only *organizes* discoveries; it does not *make* them. This engine
 * makes them. Every discovered element is attributed to WHERE it came from and
 * HOW MUCH it can be trusted, via the Evidence Hierarchy below — so downstream
 * consumers (the future Coverage Matrix, Scenario Planner, Script Generation,
 * RTM, Release Intelligence) can be configured to admit only the evidence
 * levels a given customer tier allows.
 *
 * Boundaries (deliberately narrow — mirrors the other intelligence engines):
 *   • It does NOT plan scenarios (Scenario Planner).
 *   • It does NOT build a matrix (future Coverage Matrix Builder).
 *   • It does NOT generate test cases or scripts.
 *   • It does NOT call an LLM. Pure, deterministic, reproducible.
 */

import type { RequirementInput } from '../requirement-coverage/types';

/* ------------------------------------------------------------------ */
/*  Evidence Hierarchy                                                 */
/* ------------------------------------------------------------------ */

/**
 * WHERE a discovered element came from, in descending order of trust. This is
 * the backbone of the engine: nothing is a bare fact — every entity, action,
 * field, and rule carries the source that justifies it, so a "Manager" field
 * inferred from a domain template is never confused with an "Email" field read
 * straight out of the repository's crawled form.
 *
 *   repository        ★★★★★  seen in the actual code / crawled app (fact)
 *   requirement       ★★★★☆  stated in the requirement text / acceptance criteria
 *   knowledge_base    ★★★☆☆  universal QA best-practice attached to a known field/type
 *   domain_inference  ★★☆☆☆  likely-by-domain template ("an Employee usually has …")
 *   llm_guess         ★☆☆☆☆  RESERVED — a model's free guess (NOT produced this sprint)
 */
export type EvidenceSource =
  | 'repository'
  | 'requirement'
  | 'knowledge_base'
  | 'domain_inference'
  | 'llm_guess';

/** Numeric rank of each source. Lower = stronger. Drives the tier filter. */
export const EVIDENCE_RANK: Record<EvidenceSource, number> = {
  repository: 1,
  requirement: 2,
  knowledge_base: 3,
  domain_inference: 4,
  llm_guess: 5,
};

/**
 * Baseline confidence (0-100) a source lends to an element it discovers, before
 * any corroboration bonus. These are the ★ ratings expressed numerically.
 */
export const EVIDENCE_BASE_CONFIDENCE: Record<EvidenceSource, number> = {
  repository: 100,
  requirement: 90,
  knowledge_base: 70,
  domain_inference: 50,
  llm_guess: 30,
};

/**
 * One attribution: a single source's claim about one element, with the concrete
 * reference and excerpt that justify it. Kept auditable on purpose — a consumer
 * can always answer "why do we think this field exists?".
 */
export interface Provenance {
  source: EvidenceSource;
  /** 0-100. Base for the source, possibly boosted by corroboration at merge. */
  confidence: number;
  /** WHERE, machine-readable: 'crawl:form#employee', 'requirement:description', 'kb:email', 'domain:employee'. */
  reference: string;
  /** The text/snippet that justified this claim, when there is one. */
  excerpt?: string;
}

/* ------------------------------------------------------------------ */
/*  Discovered elements                                                */
/* ------------------------------------------------------------------ */

/**
 * Common shape for every discovered element. `provenance` is the STRONGEST
 * source that found it; `corroboration` lists the other sources that also found
 * it (used to boost confidence and for audit). `normalized` is the lower-cased
 * dedup key; `name` is the display form.
 */
export interface DiscoveredElement {
  name: string;
  normalized: string;
  provenance: Provenance;
  corroboration: Provenance[];
}

export interface EntityModel extends DiscoveredElement {
  kind: 'entity';
}

/** Canonical CRUD-ish verb an action reduces to. */
export type CanonicalAction =
  | 'create' | 'read' | 'update' | 'delete'
  | 'search' | 'list' | 'assign' | 'approve'
  | 'submit' | 'cancel' | 'login' | 'logout' | 'other';

export interface ActionModel extends DiscoveredElement {
  kind: 'action';
  verb: CanonicalAction;
}

/** Data type of a field — drives which validations later apply to it. */
export type FieldDataType =
  | 'text' | 'email' | 'phone' | 'number' | 'date'
  | 'enum' | 'boolean' | 'password' | 'url' | 'unknown';

export interface FieldModel extends DiscoveredElement {
  kind: 'field';
  dataType: FieldDataType;
  /** Known-required, when a source asserted it (e.g. a mandatory rule or a `required` form field). */
  required?: boolean;
}

/** Kind of constraint a business rule expresses. */
export type BusinessRuleKind =
  | 'mandatory' | 'unique' | 'format'
  | 'length' | 'range' | 'permission' | 'dependency' | 'other';

export interface BusinessRuleModel extends DiscoveredElement {
  kind: 'rule';
  ruleType: BusinessRuleKind;
  /** Normalized name of the field/entity this rule constrains, when bindable. */
  appliesTo?: string;
}

/* ------------------------------------------------------------------ */
/*  Tier / profile                                                     */
/* ------------------------------------------------------------------ */

/**
 * Which evidence levels a consumer admits. This is the configurability Prasanth
 * asked for: an enterprise customer trusts only what is in the code or the
 * requirement; a startup also accepts best-practice knowledge; Deep Research
 * additionally admits domain inference. `maxEvidenceLevel` is the inclusive
 * highest EVIDENCE_RANK allowed.
 */
export type UnderstandingTier = 'enterprise' | 'startup' | 'deep_research' | 'custom';

export interface UnderstandingProfile {
  tier: UnderstandingTier;
  /** Inclusive max EVIDENCE_RANK admitted (1=repository … 5=llm_guess). */
  maxEvidenceLevel: number;
}

/** Preset profiles. `llm_guess` (5) is never a preset default — reserved. */
export const TIER_PROFILES: Record<Exclude<UnderstandingTier, 'custom'>, UnderstandingProfile> = {
  enterprise: { tier: 'enterprise', maxEvidenceLevel: EVIDENCE_RANK.requirement },        // L1-L2
  startup: { tier: 'startup', maxEvidenceLevel: EVIDENCE_RANK.knowledge_base },            // L1-L3
  deep_research: { tier: 'deep_research', maxEvidenceLevel: EVIDENCE_RANK.domain_inference } // L1-L4
};

export const DEFAULT_PROFILE: UnderstandingProfile = TIER_PROFILES.startup;

/* ------------------------------------------------------------------ */
/*  Repository evidence adapter                                        */
/* ------------------------------------------------------------------ */

/**
 * The MINIMAL repository shape this engine consumes. Callers adapt their richer
 * records (RepositoryProfile.coverageModel, the page-crawler's FormInfo, etc.)
 * down to this — exactly as callers adapt their requirements down to
 * RequirementInput. Everything is optional; the engine degrades gracefully to
 * requirement-only understanding when no repository evidence is supplied.
 */
export interface RepositoryFieldEvidence {
  name: string;
  /** Raw type hint from the crawl/schema (e.g. 'email', 'select', 'number'). */
  type?: string;
  required?: boolean;
}

export interface RepositoryFormEvidence {
  /** Form/screen name, if known. */
  name?: string;
  /** Entity this form operates on, if known (e.g. 'Employee'). */
  entity?: string;
  fields: RepositoryFieldEvidence[];
}

export interface RepositoryEvidence {
  /** Entities discovered in the repo (page objects, DB models, domain types). */
  entities?: string[];
  /** Forms discovered by the crawler, with their fields. */
  forms?: RepositoryFormEvidence[];
  /** Business flows / actions the repository already exercises. */
  flows?: Array<{ name: string; category?: string }>;
}

/* ------------------------------------------------------------------ */
/*  Engine input / output                                              */
/* ------------------------------------------------------------------ */

export interface UnderstandingInput {
  requirement: RequirementInput;
  repository?: RepositoryEvidence;
  /** Defaults to DEFAULT_PROFILE (startup). */
  profile?: UnderstandingProfile;
}

/**
 * The Business Model — the single composed answer this engine produces. This is
 * what the future Coverage Matrix Builder, Scenario Planner, and other
 * consumers read. It is DATA, not prose: every element is attributed and
 * scored, so any surface can render "Email (Repository · 100%)" verbatim.
 */
export interface BusinessModel {
  requirementId: string;
  entities: EntityModel[];
  actions: ActionModel[];
  fields: FieldModel[];
  businessRules: BusinessRuleModel[];
  /** Aggregate 0-100: mean element confidence (0 when nothing was discovered). */
  confidence: number;
  /** Distinct evidence sources that actually contributed, strongest first. */
  evidenceLevels: EvidenceSource[];
  /** The profile that produced this model (which levels were admitted). */
  profile: UnderstandingProfile;
}
