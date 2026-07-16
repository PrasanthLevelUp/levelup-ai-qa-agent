/**
 * Validation Planner — obligation-driven.
 *
 * The engine discovers VALIDATION OBLIGATIONS from business risk, deduplicates
 * them by intent, sizes the plan dynamically from a risk profile, respects what
 * the repository already covers, and only at the very end projects the result
 * onto the Positive/Negative/Edge vocabulary for presentation.
 *
 * It does NOT optimize for a count, a ratio, or a field-per-field expansion. It
 * asks, per applicable risk dimension: "what must be validated here, and does it
 * provide NEW validation?" — the questions a senior QA lead asks. The number of
 * obligations emerges from the requirement's risk surface, not a target.
 *
 * Deterministic and LLM-free.
 */

import type {
  BusinessModel,
  BusinessRuleModel,
  EntityModel,
  EvidenceSource,
  FieldModel,
} from '../requirement-understanding/types';
import {
  authorizationTemplate,
  boundaryTemplates,
  businessRuleTemplate,
  inputValidationTemplates,
  DATA_INTEGRITY_CHECKS,
  FREE_TEXT_TYPES,
  SECURITY_PAYLOADS,
  type ObligationTemplate,
} from './validation-catalog';
import {
  DIMENSION_ORDER,
  DIMENSION_TO_FAMILY,
  type CoveragePresentation,
  type ObligationTarget,
  type PlanMetrics,
  type RiskProfile,
  type ValidationDimension,
  type ValidationObligation,
  type ValidationPlan,
  type ValidationPlanOptions,
} from './types';

type Opts = Required<ValidationPlanOptions>;

const SOURCE_RANK: Record<EvidenceSource, number> = {
  repository: 1, requirement: 2, knowledge_base: 3, domain_inference: 4, llm_guess: 5,
};

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function titleize(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}
function isAssumption(source: EvidenceSource): boolean {
  return source !== 'repository' && source !== 'requirement';
}
function strongestSource(sources: EvidenceSource[]): EvidenceSource {
  return sources.reduce<EvidenceSource>((best, s) => (SOURCE_RANK[s] < SOURCE_RANK[best] ? s : best), 'domain_inference');
}

/* ------------------------------------------------------------------ */
/*  Risk profile — what drives dynamic sizing.                         */
/* ------------------------------------------------------------------ */

function buildRiskProfile(model: BusinessModel, opts: Opts, freeText: FieldModel[]): RiskProfile {
  const businessRuleCount = model.businessRules.length;
  const inputCount = model.fields.length;
  const securityExposureFields = freeText.length;
  const hasAuthorization = model.businessRules.some((r) => r.ruleType === 'permission');
  const externalDependencyCount = model.businessRules.filter((r) => r.ruleType === 'dependency').length;

  const applicable: ValidationDimension[] = [];
  if (model.entities[0]) applicable.push('functional');
  if (model.businessRules.some((r) => businessRuleTemplate(r.ruleType, 'x', 'x') !== null)) applicable.push('business_rule');
  if (inputCount > 0) applicable.push('input_validation');
  if (model.fields.some((f) => boundaryTemplates(f.dataType).length > 0)) applicable.push('boundary');
  if (hasAuthorization) applicable.push('authorization');
  if (opts.includeInputSafetyEdges && securityExposureFields > 0) {
    applicable.push('security', 'data_integrity');
  }

  // honest heuristic score over the risk signals → coarse label
  const score =
    businessRuleCount * 2 +
    inputCount +
    securityExposureFields * 2 +
    (hasAuthorization ? 3 : 0) +
    externalDependencyCount * 3;
  const complexity: RiskProfile['complexity'] = score <= 5 ? 'simple' : score <= 14 ? 'moderate' : 'complex';

  return {
    businessRuleCount,
    inputCount,
    securityExposureFields,
    hasAuthorization,
    externalDependencyCount,
    applicableDimensions: applicable,
    complexity,
  };
}

/* ------------------------------------------------------------------ */
/*  Binding a template to a concrete element → an obligation.          */
/* ------------------------------------------------------------------ */

function bind(
  tpl: ObligationTemplate,
  dimension: ValidationDimension,
  o: {
    elementKey: string;
    displayName: string;
    target: ObligationTarget;
    appliesTo: string;
    appliesToFields?: string[];
    source: EvidenceSource;
    assumption: boolean;
  },
): ValidationObligation {
  const concept = tpl.concept(o.elementKey);
  return {
    id: `${concept}::${tpl.intent}`,
    concept,
    intent: tpl.intent,
    dimension,
    statement: tpl.statement(o.displayName),
    riskAddressed: tpl.risk,
    target: o.target,
    appliesTo: o.appliesTo,
    appliesToFields: o.appliesToFields,
    source: o.source,
    assumption: o.assumption,
    status: 'gap',
  };
}

/* ------------------------------------------------------------------ */
/*  Dimension discoverers — each yields obligations only when it applies. */
/* ------------------------------------------------------------------ */

interface Ctx {
  model: BusinessModel;
  opts: Opts;
  freeText: FieldModel[];
}
type Discoverer = { dimension: ValidationDimension; discover(ctx: Ctx): ValidationObligation[] };

const functionalDiscoverer: Discoverer = {
  dimension: 'functional',
  discover({ model }) {
    const entity = model.entities[0];
    if (!entity) return [];
    const verb = model.actions[0]?.name ?? 'Use';
    const key = entity.normalized;
    const src = entity.provenance.source;
    const out: ValidationObligation[] = [{
      id: `${key}-capability::complete-happy-path`,
      concept: `${key}-capability`,
      intent: 'complete-happy-path',
      dimension: 'functional',
      statement: `Successfully ${verb} ${entity.name} with valid data`,
      riskAddressed: 'If the primary success path fails, the feature delivers no value.',
      target: 'capability',
      appliesTo: key,
      source: src,
      assumption: isAssumption(src),
      status: 'gap',
    }];
    // A minimal-required path is a genuinely DIFFERENT validation only when some
    // fields are optional — otherwise it is the same happy path (no new intent).
    const hasRequired = model.fields.some((f) => f.required === true);
    const hasOptional = model.fields.some((f) => f.required !== true);
    if (hasRequired && hasOptional) {
      out.push({
        id: `${key}-capability::complete-minimal-required`,
        concept: `${key}-capability`,
        intent: 'complete-minimal-required',
        dimension: 'functional',
        statement: `Successfully ${verb} ${entity.name} with only the mandatory fields`,
        riskAddressed: 'Optional fields must be omittable; the minimal valid path can regress independently.',
        target: 'capability',
        appliesTo: key,
        source: src,
        assumption: true,
        status: 'gap',
      });
    }
    return out;
  },
};

const businessRuleDiscoverer: Discoverer = {
  dimension: 'business_rule',
  discover({ model }) {
    const out: ValidationObligation[] = [];
    for (const rule of model.businessRules) {
      const key = rule.appliesTo ?? rule.normalized;
      const displayName = rule.appliesTo ? titleize(rule.appliesTo) : rule.name;
      const tpl = businessRuleTemplate(rule.ruleType, key, displayName);
      if (!tpl) continue;
      out.push(bind(tpl, 'business_rule', {
        elementKey: key, displayName, target: 'rule', appliesTo: key,
        source: rule.provenance.source, assumption: isAssumption(rule.provenance.source),
      }));
    }
    return out;
  },
};

const inputValidationDiscoverer: Discoverer = {
  dimension: 'input_validation',
  discover({ model }) {
    const out: ValidationObligation[] = [];
    for (const field of model.fields) {
      const templates = inputValidationTemplates(field.dataType, field.required === true);
      for (const tpl of templates) {
        out.push(bind(tpl, 'input_validation', {
          elementKey: field.normalized, displayName: field.name, target: 'field', appliesTo: field.normalized,
          source: field.provenance.source, assumption: isAssumption(field.provenance.source),
        }));
      }
    }
    return out;
  },
};

const boundaryDiscoverer: Discoverer = {
  dimension: 'boundary',
  discover({ model, opts }) {
    const out: ValidationObligation[] = [];
    for (const field of model.fields) {
      let templates = boundaryTemplates(field.dataType);
      if (opts.maxBoundaryPerField > 0 && templates.length > opts.maxBoundaryPerField) {
        templates = templates.slice(0, opts.maxBoundaryPerField);
      }
      for (const tpl of templates) {
        out.push(bind(tpl, 'boundary', {
          elementKey: field.normalized, displayName: field.name, target: 'field', appliesTo: field.normalized,
          source: field.provenance.source, assumption: true, // a specific limit is a best-practice inference
        }));
      }
    }
    return out;
  },
};

const authorizationDiscoverer: Discoverer = {
  dimension: 'authorization',
  discover({ model }) {
    const out: ValidationObligation[] = [];
    for (const rule of model.businessRules) {
      if (rule.ruleType !== 'permission') continue;
      const entity = model.entities[0];
      const key = rule.appliesTo ?? entity?.normalized ?? rule.normalized;
      const displayName = rule.appliesTo ? titleize(rule.appliesTo) : entity ? entity.name : rule.name;
      out.push(bind(authorizationTemplate(key, displayName), 'authorization', {
        elementKey: key, displayName, target: 'rule', appliesTo: key,
        source: rule.provenance.source, assumption: isAssumption(rule.provenance.source),
      }));
    }
    return out;
  },
};

/** One field-agnostic obligation across every free-text input. */
function grouped(tpl: ObligationTemplate, dimension: ValidationDimension, freeText: FieldModel[]): ValidationObligation {
  const fields = freeText.map((f) => f.normalized);
  const concept = tpl.concept('');
  return {
    id: `${concept}::${tpl.intent}`,
    concept,
    intent: tpl.intent,
    dimension,
    statement: tpl.statement(''),
    riskAddressed: tpl.risk,
    target: 'field',
    appliesTo: fields[0] ?? concept,
    appliesToFields: fields,
    source: strongestSource(freeText.map((f) => f.provenance.source)),
    assumption: true,
    status: 'gap',
  };
}

const securityDiscoverer: Discoverer = {
  dimension: 'security',
  discover({ opts, freeText }) {
    if (!opts.includeInputSafetyEdges || freeText.length === 0) return [];
    return SECURITY_PAYLOADS.map((t) => grouped(t, 'security', freeText));
  },
};

const dataIntegrityDiscoverer: Discoverer = {
  dimension: 'data_integrity',
  discover({ opts, freeText }) {
    if (!opts.includeInputSafetyEdges || freeText.length === 0) return [];
    return DATA_INTEGRITY_CHECKS.map((t) => grouped(t, 'data_integrity', freeText));
  },
};

const DISCOVERERS: Discoverer[] = [
  functionalDiscoverer,
  businessRuleDiscoverer,
  inputValidationDiscoverer,
  boundaryDiscoverer,
  authorizationDiscoverer,
  securityDiscoverer,
  dataIntegrityDiscoverer,
];

const DIM_INDEX: Record<ValidationDimension, number> = DIMENSION_ORDER.reduce(
  (acc, d, i) => { acc[d] = i; return acc; },
  {} as Record<ValidationDimension, number>,
);

/**
 * Is a discovered business rule explained by at least one obligation? Used for
 * the businessRuleCoverage metric — precise per rule kind, so a rule whose
 * empty-rejection collapsed into a field obligation still counts as addressed.
 */
function ruleAddressed(rule: BusinessRuleModel, obligations: ValidationObligation[]): boolean {
  const key = rule.appliesTo ?? rule.normalized;
  const has = (pred: (o: ValidationObligation) => boolean) => obligations.some(pred);
  switch (rule.ruleType) {
    case 'unique':
      return has((o) => o.concept === `${key}-uniqueness` && o.intent === 'reject-duplicate');
    case 'dependency':
      return has((o) => o.concept === `${key}-prerequisite`);
    case 'mandatory':
      return has((o) => o.concept === key && o.intent === 'reject-empty');
    case 'permission':
      // authorization obligations anchor to the entity when the rule names no
      // explicit target, so match on the dimension (and the target when named).
      return has((o) => o.dimension === 'authorization' && (rule.appliesTo ? o.appliesTo === key : true));
    case 'range':
    case 'length':
      return has((o) => o.dimension === 'boundary' && o.appliesTo === key);
    case 'format':
      return has((o) => o.dimension === 'input_validation' && o.appliesTo === key);
    default:
      // 'other' rules carry no enforceable single validation — not counted against coverage.
      return true;
  }
}

/* ------------------------------------------------------------------ */
/*  Presentation projection — the ONLY place families exist.           */
/* ------------------------------------------------------------------ */

function project(obligations: ValidationObligation[]): CoveragePresentation {
  const p: CoveragePresentation = { positive: 0, negative: 0, edge: 0, advanced: 0, total: obligations.length, label: '', byDimension: {} };
  for (const o of obligations) {
    p[DIMENSION_TO_FAMILY[o.dimension]] += 1;
    p.byDimension[o.dimension] = (p.byDimension[o.dimension] ?? 0) + 1;
  }
  p.label = `Positive: ${p.positive} · Negative: ${p.negative} · Edge: ${p.edge} · Advanced: ${p.advanced}`;
  return p;
}

/* ------------------------------------------------------------------ */
/*  The planner.                                                       */
/* ------------------------------------------------------------------ */

export function planValidations(model: BusinessModel, options: ValidationPlanOptions = {}): ValidationPlan {
  const opts: Opts = {
    includeInputSafetyEdges: options.includeInputSafetyEdges ?? true,
    maxBoundaryPerField: options.maxBoundaryPerField ?? 0,
    alreadyCovered: options.alreadyCovered ?? [],
  };
  const freeText = model.fields.filter((f) => FREE_TEXT_TYPES.has(f.dataType));
  const ctx: Ctx = { model, opts, freeText };
  const riskProfile = buildRiskProfile(model, opts, freeText);

  // 1. discover raw obligations across applicable dimensions
  const raw: ValidationObligation[] = [];
  for (const d of DISCOVERERS) raw.push(...d.discover(ctx));

  // 2. dedup by intent signature (id). Two obligations that assert the same
  //    validation of the same concept are ONE obligation — keep the strongest-
  //    sourced, grounded instance, and count the collapse.
  const byId = new Map<string, ValidationObligation>();
  let duplicationEliminated = 0;
  for (const o of raw) {
    const existing = byId.get(o.id);
    if (!existing) { byId.set(o.id, o); continue; }
    duplicationEliminated += 1;
    const better = SOURCE_RANK[o.source] < SOURCE_RANK[existing.source] ? o : existing;
    byId.set(o.id, { ...better, assumption: better.assumption && o.assumption });
  }

  // 3. repository intelligence: mark obligations existing tests already satisfy.
  const covered = new Set(opts.alreadyCovered);
  let repositoryReuse = 0;
  for (const [id, o] of byId) {
    if (covered.has(id)) { byId.set(id, { ...o, status: 'covered' }); repositoryReuse += 1; }
  }

  // 4. order by dimension (QA reading order), then concept, then intent
  const obligations = [...byId.values()].sort((a, b) => {
    const byDim = DIM_INDEX[a.dimension] - DIM_INDEX[b.dimension];
    if (byDim !== 0) return byDim;
    return a.id.localeCompare(b.id);
  });

  // 5. metrics (count-free success measures) + presentation projection
  const producedDims = new Set(obligations.map((o) => o.dimension));
  const applicable = riskProfile.applicableDimensions;
  const dimensionCoverage = applicable.length === 0 ? 1 : applicable.filter((d) => producedDims.has(d)).length / applicable.length;

  const rulesAddressed = model.businessRules.filter((r) => ruleAddressed(r, obligations)).length;
  const businessRuleCoverage = riskProfile.businessRuleCount === 0 ? 1 : rulesAddressed / riskProfile.businessRuleCount;

  const metrics: PlanMetrics = {
    obligationsToGenerate: obligations.filter((o) => o.status === 'gap').length,
    dimensionCoverage,
    businessRuleCoverage,
    duplicationEliminated,
    repositoryReuse,
  };

  return {
    requirementId: model.requirementId,
    capability: model.entities[0]?.name ?? null,
    riskProfile,
    obligations,
    metrics,
    presentation: project(obligations),
  };
}

export type { BusinessModel, EntityModel, FieldModel, BusinessRuleModel };
