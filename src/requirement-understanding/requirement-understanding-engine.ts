/**
 * Requirement Understanding Engine.
 *
 * Merges a Requirement with (optional) Repository Context into a deterministic
 * Business Model — entities, actions, fields, business rules — where every
 * element is attributed to its Evidence source and scored for confidence.
 *
 *     Requirement ─┐
 *                  ├─▶ understandRequirement() ─▶ BusinessModel
 *  RepositoryEvid ─┘        (deterministic, no LLM)
 *
 * Pipeline:
 *   1. Collect candidate elements from each source, strongest first:
 *        L1 repository  →  L2 requirement  →  L3 knowledge base  →  L4 domain
 *   2. Merge duplicates across sources: strongest source becomes the primary
 *      provenance; weaker corroborators add a confidence bonus.
 *   3. Drop anything whose strongest source exceeds the profile's admitted level.
 *   4. Compute an aggregate confidence and report which levels contributed.
 *
 * L5 (llm_guess) is reserved in the type system and produced by NO path here.
 */

import type { RequirementInput } from '../requirement-coverage/types';
import {
  DEFAULT_PROFILE,
  EVIDENCE_BASE_CONFIDENCE,
  EVIDENCE_RANK,
  type ActionModel,
  type BusinessModel,
  type BusinessRuleKind,
  type BusinessRuleModel,
  type CanonicalAction,
  type DiscoveredElement,
  type EntityModel,
  type EvidenceSource,
  type FieldDataType,
  type FieldModel,
  type Provenance,
  type RepositoryEvidence,
  type UnderstandingInput,
} from './types';
import {
  domainFieldsForEntity,
  inferFieldDataType,
  knowledgeBaseRulesFor,
} from './domain-knowledge';

/* ------------------------------------------------------------------ */
/*  Text utilities                                                     */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'new', 'to', 'of', 'for', 'with', 'and', 'or',
  'can', 'should', 'must', 'able', 'be', 'is', 'are', 'as', 'that', 'this',
  'user', 'users', 'system', 'admin', 'able to',
]);

/** Canonical verb an action word reduces to. */
const VERB_CANON: Record<string, CanonicalAction> = {
  create: 'create', add: 'create', new: 'create', register: 'create',
  insert: 'create', signup: 'create', onboard: 'create',
  update: 'update', edit: 'update', modify: 'update', change: 'update',
  delete: 'delete', remove: 'delete', deactivate: 'delete', archive: 'delete',
  view: 'read', see: 'read', display: 'read', show: 'read', read: 'read', get: 'read',
  search: 'search', find: 'search', filter: 'search', query: 'search',
  list: 'list', browse: 'list',
  assign: 'assign', approve: 'approve', reject: 'approve',
  submit: 'submit', save: 'submit',
  cancel: 'cancel',
  login: 'login', signin: 'login',
  logout: 'logout', signout: 'logout',
};

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Naive singularization for entity dedup (employees → employee). */
function singularize(word: string): string {
  if (/([^aeiou])ies$/i.test(word)) return word.replace(/ies$/i, 'y');
  if (/(ses|xes|zes|ches|shes)$/i.test(word)) return word.replace(/es$/i, '');
  if (/[^s]s$/i.test(word)) return word.replace(/s$/i, '');
  return word;
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

function tokens(text: string): string[] {
  return normalize(text).split(/[^a-z0-9]+/i).filter(Boolean);
}

/** The full free-text surface of a requirement (title + description + flows). */
function requirementText(req: RequirementInput): string {
  const parts: string[] = [req.title];
  if (req.description) parts.push(req.description);
  if (req.expectedFlows?.length) parts.push(req.expectedFlows.join('. '));
  if (req.behaviors?.length) parts.push(req.behaviors.map((b) => b.label).join('. '));
  return parts.join('. ');
}

/* ------------------------------------------------------------------ */
/*  Extraction — requirement (L2)                                      */
/* ------------------------------------------------------------------ */

/**
 * Pull the primary entity from a requirement: the noun phrase that follows the
 * first action verb in the title ("create employee" → Employee), falling back
 * to the `feature` hint, then the last meaningful noun in the title.
 */
function extractEntity(req: RequirementInput): string | null {
  const toks = tokens(req.title);
  const verbIdx = toks.findIndex((t) => VERB_CANON[t]);
  if (verbIdx >= 0) {
    for (let i = verbIdx + 1; i < toks.length; i++) {
      const t = toks[i];
      if (STOPWORDS.has(t) || VERB_CANON[t]) continue;
      return titleCase(singularize(t));
    }
  }
  if (req.feature) return titleCase(singularize(normalize(req.feature)));
  const meaningful = toks.filter((t) => !STOPWORDS.has(t) && !VERB_CANON[t]);
  if (meaningful.length) return titleCase(singularize(meaningful[meaningful.length - 1]));
  return null;
}

/** Every canonical action verb mentioned anywhere in the requirement. */
function extractActions(req: RequirementInput): CanonicalAction[] {
  const found = new Set<CanonicalAction>();
  for (const t of tokens(requirementText(req))) {
    if (VERB_CANON[t]) found.add(VERB_CANON[t]);
  }
  return [...found];
}

const KNOWN_FIELD_NOUNS = [
  'first name', 'last name', 'full name', 'name', 'email', 'phone', 'mobile',
  'address', 'city', 'state', 'zip', 'postal code', 'country', 'password',
  'username', 'department', 'role', 'title', 'salary', 'manager', 'gender',
  'date of birth', 'dob', 'status', 'description', 'quantity', 'price', 'sku',
  'category', 'company', 'start date', 'due date', 'priority', 'assignee',
];

/**
 * Extract candidate field names from a requirement. Two deterministic passes:
 *   (a) an explicit clause — "fields: X, Y, Z" / "with X, Y and Z" / "enter X".
 *   (b) a scan for well-known field nouns appearing anywhere in the text.
 */
function extractFields(req: RequirementInput): string[] {
  const text = requirementText(req);
  const out = new Set<string>();

  const clause = text.match(
    /\b(?:fields?|with|including|includes?|enter|provide|input|containing|contains?)\b[:\s]+([^.;]+)/i,
  );
  if (clause) {
    for (const raw of clause[1].split(/,|\band\b|\/|;/i)) {
      const name = normalize(raw).replace(/^(the|a|an)\s+/, '');
      if (name && name.length <= 40 && !STOPWORDS.has(name)) out.add(name);
    }
  }

  const lower = ` ${normalize(text)} `;
  for (const noun of KNOWN_FIELD_NOUNS) {
    if (lower.includes(` ${noun} `) || lower.includes(` ${noun},`) || lower.includes(` ${noun}.`)) {
      out.add(noun);
    }
  }
  return [...out];
}

/** Business rules stated in the requirement, bound to a field when possible. */
function extractRules(req: RequirementInput, fieldKeys: string[]): Array<{ ruleType: BusinessRuleKind; appliesTo?: string; excerpt: string }> {
  const text = requirementText(req);
  const sentences = text.split(/[.;]\s*/);
  const rules: Array<{ ruleType: BusinessRuleKind; appliesTo?: string; excerpt: string }> = [];

  const patterns: Array<[BusinessRuleKind, RegExp]> = [
    ['mandatory', /\b(mandatory|required|cannot be empty|must be provided|is required|not be blank)\b/i],
    ['unique', /\b(unique|already exists|duplicate|must be unique|no two|not be duplicated)\b/i],
    ['format', /\b(valid|invalid|format|well[- ]formed|properly formatted|matches the pattern)\b/i],
    ['length', /\b(at least|at most|maximum|minimum|characters|length|max length|min length|too long|too short)\b/i],
    ['range', /\b(between|greater than|less than|no more than|no less than|positive|non-negative)\b/i],
    ['permission', /\b(only .* can|permission|authori[sz]ed|role-based|admin only|restricted to|not allowed)\b/i],
    ['dependency', /\b(requires|depends on|only if|when .* is|prerequisite)\b/i],
  ];

  for (const sentence of sentences) {
    for (const [ruleType, re] of patterns) {
      if (re.test(sentence)) {
        const appliesTo = fieldKeys.find((f) => sentence.toLowerCase().includes(f));
        rules.push({ ruleType, appliesTo, excerpt: sentence.trim() });
      }
    }
  }
  return rules;
}

/* ------------------------------------------------------------------ */
/*  Candidate collection                                               */
/* ------------------------------------------------------------------ */

type Kind = 'entity' | 'action' | 'field' | 'rule';

interface Candidate {
  kind: Kind;
  name: string;
  normalized: string;
  provenance: Provenance;
  // kind-specific extras
  verb?: CanonicalAction;
  dataType?: FieldDataType;
  required?: boolean;
  ruleType?: BusinessRuleKind;
  appliesTo?: string;
}

function prov(source: EvidenceSource, reference: string, excerpt?: string): Provenance {
  return { source, confidence: EVIDENCE_BASE_CONFIDENCE[source], reference, excerpt };
}

/** L1 — everything the repository already knows (strongest). */
function collectRepository(repo: RepositoryEvidence | undefined): Candidate[] {
  if (!repo) return [];
  const out: Candidate[] = [];

  for (const e of repo.entities ?? []) {
    const norm = singularize(normalize(e));
    if (norm) out.push({ kind: 'entity', name: titleCase(norm), normalized: norm, provenance: prov('repository', 'repo:entity') });
  }

  for (const form of repo.forms ?? []) {
    if (form.entity) {
      const norm = singularize(normalize(form.entity));
      out.push({ kind: 'entity', name: titleCase(norm), normalized: norm, provenance: prov('repository', `crawl:form#${form.name ?? form.entity}`) });
    }
    for (const f of form.fields ?? []) {
      const norm = normalize(f.name);
      if (!norm) continue;
      out.push({
        kind: 'field',
        name: titleCase(norm),
        normalized: norm,
        dataType: inferFieldDataType(f.name, f.type),
        required: f.required,
        provenance: prov('repository', `crawl:form#${form.name ?? 'unknown'}:${f.name}`),
      });
      if (f.required) {
        out.push({ kind: 'rule', name: `${titleCase(norm)} is mandatory`, normalized: `mandatory:${norm}`, ruleType: 'mandatory', appliesTo: norm, provenance: prov('repository', `crawl:form#${form.name ?? 'unknown'}:${f.name}:required`) });
      }
    }
  }

  for (const flow of repo.flows ?? []) {
    for (const t of tokens(flow.name)) {
      if (VERB_CANON[t]) {
        const verb = VERB_CANON[t];
        out.push({ kind: 'action', name: titleCase(verb), normalized: verb, verb, provenance: prov('repository', `repo:flow#${flow.name}`) });
      }
    }
  }
  return out;
}

/** L2 — everything stated in the requirement. */
function collectRequirement(req: RequirementInput): Candidate[] {
  const out: Candidate[] = [];

  const entity = extractEntity(req);
  if (entity) {
    const norm = normalize(entity);
    out.push({ kind: 'entity', name: entity, normalized: norm, provenance: prov('requirement', 'requirement:title', req.title) });
  }

  for (const verb of extractActions(req)) {
    out.push({ kind: 'action', name: titleCase(verb), normalized: verb, verb, provenance: prov('requirement', 'requirement:title', req.title) });
  }

  const fieldNames = extractFields(req);
  for (const fn of fieldNames) {
    const norm = normalize(fn);
    out.push({ kind: 'field', name: titleCase(fn), normalized: norm, dataType: inferFieldDataType(fn), provenance: prov('requirement', 'requirement:text') });
  }

  for (const r of extractRules(req, fieldNames.map(normalize))) {
    const key = r.appliesTo ? `${r.ruleType}:${r.appliesTo}` : `${r.ruleType}:*`;
    const label = r.appliesTo ? `${titleCase(r.appliesTo)} ${r.ruleType}` : `${titleCase(r.ruleType)} rule`;
    out.push({ kind: 'rule', name: label, normalized: key, ruleType: r.ruleType, appliesTo: r.appliesTo, provenance: prov('requirement', 'requirement:text', r.excerpt) });
    if (r.ruleType === 'mandatory' && r.appliesTo) {
      // a mandatory rule tells us the field is required
      out.push({ kind: 'field', name: titleCase(r.appliesTo), normalized: r.appliesTo, dataType: inferFieldDataType(r.appliesTo), required: true, provenance: prov('requirement', 'requirement:text', r.excerpt) });
    }
  }
  return out;
}

/** L3 — best-practice rules implied by the TYPE of already-discovered fields. */
function collectKnowledgeBase(fieldCandidates: Candidate[]): Candidate[] {
  const out: Candidate[] = [];
  for (const f of fieldCandidates) {
    if (f.kind !== 'field' || !f.dataType) continue;
    for (const ruleType of knowledgeBaseRulesFor(f.dataType)) {
      out.push({
        kind: 'rule',
        name: `${f.name} ${ruleType}`,
        normalized: `${ruleType}:${f.normalized}`,
        ruleType,
        appliesTo: f.normalized,
        provenance: prov('knowledge_base', `kb:${f.dataType}`),
      });
    }
  }
  return out;
}

/** L4 — likely fields for a recognized entity, from a domain template. */
function collectDomainInference(entityCandidates: Candidate[]): Candidate[] {
  const out: Candidate[] = [];
  for (const e of entityCandidates) {
    if (e.kind !== 'entity') continue;
    for (const fieldName of domainFieldsForEntity(e.normalized)) {
      const norm = normalize(fieldName);
      out.push({ kind: 'field', name: fieldName, normalized: norm, dataType: inferFieldDataType(fieldName), provenance: prov('domain_inference', `domain:${e.normalized}`) });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Merge + confidence                                                 */
/* ------------------------------------------------------------------ */

/** Corroboration bonus: +5 per additional distinct source, capped so we never exceed 100. */
function scoreWithCorroboration(primary: Provenance, corroboration: Provenance[]): number {
  const bonus = Math.min(corroboration.length * 5, 100 - primary.confidence);
  return Math.min(100, primary.confidence + Math.max(0, bonus));
}

/**
 * Merge same-kind candidates sharing a normalized key. Strongest source (lowest
 * EVIDENCE_RANK) wins the primary provenance; the rest become corroboration and
 * lift confidence. Candidates whose strongest admitted source exceeds
 * `maxLevel` are dropped entirely.
 */
function mergeKind<T extends DiscoveredElement>(
  candidates: Candidate[],
  maxLevel: number,
  build: (c: Candidate, provenance: Provenance, corroboration: Provenance[]) => T,
): T[] {
  const groups = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const g = groups.get(c.normalized) ?? [];
    g.push(c);
    groups.set(c.normalized, g);
  }

  const result: T[] = [];
  for (const group of groups.values()) {
    // admitted sources only
    const admitted = group.filter((c) => EVIDENCE_RANK[c.provenance.source] <= maxLevel);
    if (admitted.length === 0) continue;
    admitted.sort((a, b) => EVIDENCE_RANK[a.provenance.source] - EVIDENCE_RANK[b.provenance.source]);

    const primaryCand = admitted[0];
    // dedup corroboration by source, excluding the primary source
    const seen = new Set<EvidenceSource>([primaryCand.provenance.source]);
    const corroboration: Provenance[] = [];
    for (const c of admitted.slice(1)) {
      if (seen.has(c.provenance.source)) continue;
      seen.add(c.provenance.source);
      corroboration.push(c.provenance);
    }
    const primary: Provenance = { ...primaryCand.provenance, confidence: scoreWithCorroboration(primaryCand.provenance, corroboration) };

    // prefer the richest kind-specific metadata across the admitted group
    const merged: Candidate = { ...primaryCand };
    for (const c of admitted) {
      if (c.required) merged.required = true;
      if (!merged.dataType || merged.dataType === 'unknown') if (c.dataType && c.dataType !== 'unknown') merged.dataType = c.dataType;
    }
    result.push(build(merged, primary, corroboration));
  }
  return result;
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Understand a requirement: deterministic Requirement + Repository → Business
 * Model, attributed and scored by the Evidence Hierarchy and filtered to the
 * profile's admitted evidence levels.
 */
export function understandRequirement(input: UnderstandingInput): BusinessModel {
  const { requirement, repository } = input;
  const profile = input.profile ?? DEFAULT_PROFILE;
  const maxLevel = profile.maxEvidenceLevel;

  // 1. collect from every source
  const repoCands = collectRepository(repository);
  const reqCands = collectRequirement(requirement);

  // fields known so far (from L1+L2) seed the KB rules; entities seed domain inference
  const knownFields = [...repoCands, ...reqCands].filter((c) => c.kind === 'field');
  const knownEntities = [...repoCands, ...reqCands].filter((c) => c.kind === 'entity');
  const kbCands = collectKnowledgeBase(knownFields);
  const domainCands = maxLevel >= EVIDENCE_RANK.domain_inference ? collectDomainInference(knownEntities) : [];

  const all = [...repoCands, ...reqCands, ...kbCands, ...domainCands];
  const byKind = (k: Kind) => all.filter((c) => c.kind === k);

  // 2/3. merge + filter per kind
  const entities = mergeKind<EntityModel>(byKind('entity'), maxLevel, (c, provenance, corroboration) => ({
    kind: 'entity', name: c.name, normalized: c.normalized, provenance, corroboration,
  }));
  const actions = mergeKind<ActionModel>(byKind('action'), maxLevel, (c, provenance, corroboration) => ({
    kind: 'action', name: c.name, normalized: c.normalized, verb: c.verb ?? 'other', provenance, corroboration,
  }));
  const fields = mergeKind<FieldModel>(byKind('field'), maxLevel, (c, provenance, corroboration) => ({
    kind: 'field', name: c.name, normalized: c.normalized, dataType: c.dataType ?? 'unknown', required: c.required, provenance, corroboration,
  }));
  const businessRules = mergeKind<BusinessRuleModel>(byKind('rule'), maxLevel, (c, provenance, corroboration) => ({
    kind: 'rule', name: c.name, normalized: c.normalized, ruleType: c.ruleType ?? 'other', appliesTo: c.appliesTo, provenance, corroboration,
  }));

  // 4. aggregate confidence + contributing levels
  const elements: DiscoveredElement[] = [...entities, ...actions, ...fields, ...businessRules];
  const confidence = elements.length
    ? Math.round(elements.reduce((s, e) => s + e.provenance.confidence, 0) / elements.length)
    : 0;

  const levelSet = new Set<EvidenceSource>();
  for (const e of elements) {
    levelSet.add(e.provenance.source);
    for (const c of e.corroboration) levelSet.add(c.source);
  }
  const evidenceLevels = [...levelSet].sort((a, b) => EVIDENCE_RANK[a] - EVIDENCE_RANK[b]);

  return {
    requirementId: requirement.id,
    entities,
    actions,
    fields,
    businessRules,
    confidence,
    evidenceLevels,
    profile,
  };
}
