/**
 * Validation Planner — taxonomy-driven.
 *
 * Consumes a BusinessModel (from the Requirement Understanding Engine) and
 * enumerates the validation points a balanced suite must cover — deterministic,
 * no LLM. This is the component that turns
 *
 *     11 Positive / 1 Negative / 0 Edge   (GPT guessing coverage)
 *
 * into an intended, explainable mix — because it decides coverage the way an
 * experienced QA lead does.
 *
 * The old shape iterated FIELDS and emitted validations per field, which made
 * the suite size (and the positive count in particular) a function of how many
 * fields a form had. This walks the QA TAXONOMY instead:
 *
 *     Category → applicable Rules/Fields → Validation Point
 *
 * so positives belong to the CAPABILITY (one or two per action, regardless of
 * field count) and cross-field concerns (security, data integrity) are a few
 * category-level points that list the fields they touch, not one-per-field.
 *
 * The Scenario Planner will expand exactly one scenario per point; GPT only
 * writes the prose. Discovery of *what to test* lives here, in knowledge.
 */

import type {
  BusinessModel,
  BusinessRuleModel,
  EntityModel,
  FieldModel,
} from '../requirement-understanding/types';
import type { CoverageFamily } from '../engines/generation-quality-engine';
import {
  boundaryTemplates,
  businessRuleTemplate,
  inputValidationTemplates,
  permissionTemplate,
  DATA_INTEGRITY_CHECKS,
  FREE_TEXT_TYPES,
  SECURITY_PAYLOADS,
  type ValidationTemplate,
} from './validation-catalog';
import {
  TAXONOMY_ORDER,
  type PlannedCoverageMix,
  type ValidationCategory,
  type ValidationPlan,
  type ValidationPlanOptions,
  type ValidationPoint,
  type ValidationTarget,
} from './types';
import type { EvidenceSource } from '../requirement-understanding/types';

type Opts = Required<ValidationPlanOptions>;

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function titleize(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** A target is an assumption unless it rests on observed/stated fact. */
function isAssumption(source: EvidenceSource): boolean {
  return source !== 'repository' && source !== 'requirement';
}

/** Strongest (lowest-rank) evidence source among a set, for grouped points. */
const SOURCE_RANK: Record<EvidenceSource, number> = {
  repository: 1, requirement: 2, knowledge_base: 3, domain_inference: 4, llm_guess: 5,
};
function strongestSource(sources: EvidenceSource[]): EvidenceSource {
  return sources.reduce((best, s) => (SOURCE_RANK[s] < SOURCE_RANK[best] ? s : best), 'domain_inference' as EvidenceSource);
}

/* ------------------------------------------------------------------ */
/*  A category planner: given the model, discover its points.          */
/* ------------------------------------------------------------------ */

interface CategoryContext {
  model: BusinessModel;
  opts: Opts;
  /** The free-text fields, computed once and shared by security/data-integrity. */
  freeTextFields: FieldModel[];
}

interface CategoryPlanner {
  category: ValidationCategory;
  discover(ctx: CategoryContext): ValidationPoint[];
}

/** Bind a per-field / per-rule template to a concrete element. */
function bindTemplate(
  tpl: ValidationTemplate,
  category: ValidationCategory,
  o: { target: ValidationTarget; appliesTo: string; displayName: string; source: EvidenceSource; assumption: boolean },
): ValidationPoint {
  return {
    id: `${slug(o.appliesTo)}:${category}:${tpl.key}`,
    category,
    family: tpl.family,
    title: tpl.title(o.displayName),
    target: o.target,
    appliesTo: o.appliesTo,
    rationale: tpl.rationale,
    source: o.source,
    assumption: o.assumption,
  };
}

/* ---- functional: happy paths, bounded by capability, not fields ---- */
const functionalPlanner: CategoryPlanner = {
  category: 'functional',
  discover({ model }) {
    const entity = model.entities[0];
    if (!entity) return [];
    const action = model.actions[0];
    const verb = action ? action.name : 'Use';
    const src = entity.provenance.source;
    const points: ValidationPoint[] = [
      {
        id: `${slug(entity.normalized)}:functional:happy-path`,
        category: 'functional',
        family: 'positive',
        title: `Successfully ${verb} ${entity.name} with all valid data`,
        target: 'entity',
        appliesTo: entity.normalized,
        rationale: 'The primary success path for the requirement must be verified.',
        source: src,
        assumption: isAssumption(src),
      },
    ];
    // A second, distinct positive ONLY when there is a real distinction to draw:
    // some fields are optional, so "created with only the mandatory fields" is a
    // genuinely different path — not just another field permutation.
    const hasRequired = model.fields.some((f) => f.required === true);
    const hasOptional = model.fields.some((f) => f.required !== true);
    if (hasRequired && hasOptional) {
      points.push({
        id: `${slug(entity.normalized)}:functional:minimal-required`,
        category: 'functional',
        family: 'positive',
        title: `Successfully ${verb} ${entity.name} with only the mandatory fields`,
        target: 'entity',
        appliesTo: entity.normalized,
        rationale: 'Optional fields must be omittable; the minimal valid path is a distinct success case.',
        source: src,
        assumption: true, // "which fields are optional" is a shape inference, not a stated case
      });
    }
    return points;
  },
};

/* ---- business_rule: violations of discovered domain rules ---- */
const businessRulePlanner: CategoryPlanner = {
  category: 'business_rule',
  discover({ model }) {
    const out: ValidationPoint[] = [];
    for (const rule of model.businessRules) {
      const displayName = rule.appliesTo ? titleize(rule.appliesTo) : rule.name;
      const tpl = businessRuleTemplate(rule.ruleType, displayName);
      if (!tpl) continue;
      out.push(
        bindTemplate(tpl, 'business_rule', {
          target: 'rule',
          appliesTo: rule.appliesTo ?? rule.normalized,
          displayName,
          source: rule.provenance.source,
          assumption: isAssumption(rule.provenance.source),
        }),
      );
    }
    return out;
  },
};

/* ---- input_validation: per-field rejection of invalid input ---- */
const inputValidationPlanner: CategoryPlanner = {
  category: 'input_validation',
  discover({ model }) {
    const out: ValidationPoint[] = [];
    for (const field of model.fields) {
      const required = field.required === true;
      const templates = inputValidationTemplates(field.dataType, required);
      const fieldAssumed = isAssumption(field.provenance.source);
      for (const tpl of templates) {
        out.push(
          bindTemplate(tpl, 'input_validation', {
            target: 'field',
            appliesTo: field.normalized,
            displayName: field.name,
            source: field.provenance.source,
            // rejecting invalid input on a STATED field is a grounded expectation.
            assumption: fieldAssumed,
          }),
        );
      }
    }
    return out;
  },
};

/* ---- boundary: per-field limits (capped by maxEdgePerField) ---- */
const boundaryPlanner: CategoryPlanner = {
  category: 'boundary',
  discover({ model, opts }) {
    const out: ValidationPoint[] = [];
    for (const field of model.fields) {
      let templates = boundaryTemplates(field.dataType);
      if (opts.maxEdgePerField > 0 && templates.length > opts.maxEdgePerField) {
        templates = templates.slice(0, opts.maxEdgePerField);
      }
      for (const tpl of templates) {
        out.push(
          bindTemplate(tpl, 'boundary', {
            target: 'field',
            appliesTo: field.normalized,
            displayName: field.name,
            source: field.provenance.source,
            // a specific limit the requirement never spelled out is a best practice.
            assumption: true,
          }),
        );
      }
    }
    return out;
  },
};

/* ---- permission: authorization on the action ---- */
const permissionPlanner: CategoryPlanner = {
  category: 'permission',
  discover({ model }) {
    const out: ValidationPoint[] = [];
    for (const rule of model.businessRules) {
      if (rule.ruleType !== 'permission') continue;
      const displayName = rule.appliesTo
        ? titleize(rule.appliesTo)
        : model.entities[0]
          ? model.entities[0].name
          : rule.name;
      const anchor = rule.appliesTo ?? model.entities[0]?.normalized ?? rule.normalized;
      out.push(
        bindTemplate(permissionTemplate(displayName), 'permission', {
          target: 'rule',
          appliesTo: anchor,
          displayName,
          source: rule.provenance.source,
          assumption: isAssumption(rule.provenance.source),
        }),
      );
    }
    return out;
  },
};

/** Build a category-level point that spans every free-text field. */
function groupedPoint(
  tpl: ValidationTemplate,
  category: ValidationCategory,
  freeText: FieldModel[],
): ValidationPoint {
  const fieldNames = freeText.map((f) => f.normalized);
  return {
    id: `${category}:${tpl.key}`,
    category,
    family: tpl.family,
    title: tpl.title(''),
    target: 'field',
    appliesTo: fieldNames[0] ?? category,
    appliesToFields: fieldNames,
    rationale: tpl.rationale,
    source: strongestSource(freeText.map((f) => f.provenance.source)),
    assumption: true, // safety/integrity checks are best practice, never stated per field
  };
}

/* ---- security: injection/script across free-text fields (grouped) ---- */
const securityPlanner: CategoryPlanner = {
  category: 'security',
  discover({ opts, freeTextFields }) {
    if (!opts.includeInputSafetyEdges || freeTextFields.length === 0) return [];
    return SECURITY_PAYLOADS.map((tpl) => groupedPoint(tpl, 'security', freeTextFields));
  },
};

/* ---- data_integrity: unicode/emoji/whitespace across free-text (grouped) ---- */
const dataIntegrityPlanner: CategoryPlanner = {
  category: 'data_integrity',
  discover({ opts, freeTextFields }) {
    if (!opts.includeInputSafetyEdges || freeTextFields.length === 0) return [];
    return DATA_INTEGRITY_CHECKS.map((tpl) => groupedPoint(tpl, 'data_integrity', freeTextFields));
  },
};

/**
 * The taxonomy registry. Reserved categories (integration, recovery,
 * accessibility, localization, performance) are intentionally absent here: they
 * are declared in TAXONOMY_ORDER for ordering/extensibility, and adding one is a
 * matter of registering a planner — never of touching field logic.
 */
const PLANNERS: CategoryPlanner[] = [
  functionalPlanner,
  businessRulePlanner,
  inputValidationPlanner,
  boundaryPlanner,
  permissionPlanner,
  securityPlanner,
  dataIntegrityPlanner,
];

function summarize(points: ValidationPoint[]): PlannedCoverageMix {
  const mix: PlannedCoverageMix = {
    positive: 0, negative: 0, edge: 0, advanced: 0, total: points.length, label: '', byCategory: {},
  };
  for (const p of points) {
    mix[p.family] += 1;
    mix.byCategory[p.category] = (mix.byCategory[p.category] ?? 0) + 1;
  }
  mix.label = `Positive: ${mix.positive} · Negative: ${mix.negative} · Edge: ${mix.edge} · Advanced: ${mix.advanced}`;
  return mix;
}

const CATEGORY_INDEX: Record<ValidationCategory, number> = TAXONOMY_ORDER.reduce(
  (acc, cat, i) => { acc[cat] = i; return acc; },
  {} as Record<ValidationCategory, number>,
);

/**
 * Plan the validations for a Business Model.
 *
 * Deterministic: same model + options → identical plan. Walks the QA taxonomy
 * top-down and lets each category discover the rules/fields it applies to.
 * De-duplicates points two categories could both imply, keeping the
 * strongest-sourced, grounded instance. Points are grouped in taxonomy order so
 * the plan reads like a QA lead's test plan.
 */
export function planValidations(model: BusinessModel, options: ValidationPlanOptions = {}): ValidationPlan {
  const opts: Opts = {
    includeInputSafetyEdges: options.includeInputSafetyEdges ?? true,
    maxEdgePerField: options.maxEdgePerField ?? 0,
  };

  const ctx: CategoryContext = {
    model,
    opts,
    freeTextFields: model.fields.filter((f) => FREE_TEXT_TYPES.has(f.dataType)),
  };

  const raw: ValidationPoint[] = [];
  for (const planner of PLANNERS) raw.push(...planner.discover(ctx));

  // de-dupe by id; on collision keep the strongest-sourced and grounded instance.
  const byId = new Map<string, ValidationPoint>();
  for (const p of raw) {
    const existing = byId.get(p.id);
    if (!existing) { byId.set(p.id, p); continue; }
    const better = SOURCE_RANK[p.source] < SOURCE_RANK[existing.source] ? p : existing;
    byId.set(p.id, { ...better, assumption: better.assumption && p.assumption });
  }

  const order: CoverageFamily[] = ['positive', 'negative', 'edge', 'advanced'];
  const points = [...byId.values()].sort((a, b) => {
    const byCat = CATEGORY_INDEX[a.category] - CATEGORY_INDEX[b.category];
    if (byCat !== 0) return byCat;
    const byFam = order.indexOf(a.family) - order.indexOf(b.family);
    return byFam !== 0 ? byFam : a.id.localeCompare(b.id);
  });

  return {
    requirementId: model.requirementId,
    entity: model.entities[0]?.name ?? null,
    points,
    mix: summarize(points),
  };
}

// re-exported for consumers that only need the entity/field types alongside the plan
export type { BusinessModel, EntityModel, FieldModel, BusinessRuleModel };
