/**
 * Validation Planner.
 *
 * Consumes a BusinessModel (from the Requirement Understanding Engine) and
 * enumerates the validation points a balanced suite must cover — deterministic,
 * no LLM. This is the component that turns
 *
 *     11 Positive / 1 Negative / 0 Edge   (GPT guessing coverage)
 *
 * into an intended, explainable mix like
 *
 *     Positive: 4 · Negative: 8 · Edge: 9 · Advanced: 1   (knowledge deciding coverage)
 *
 * The Scenario Planner will expand exactly one scenario per point; GPT only
 * writes the prose. Discovery of *what to test* now lives here, in knowledge.
 */

import type {
  BusinessModel,
  FieldModel,
  BusinessRuleModel,
} from '../requirement-understanding/types';
import { coverageFamily, type CoverageFamily } from '../engines/generation-quality-engine';
import {
  templatesForField,
  templatesForRule,
  type ValidationTemplate,
} from './validation-catalog';
import type {
  PlannedCoverageMix,
  ValidationCategory,
  ValidationPlan,
  ValidationPlanOptions,
  ValidationPoint,
  ValidationTarget,
} from './types';

/** Map a validation category onto the coverage type string the family fn knows. */
const CATEGORY_TO_TYPE: Record<ValidationCategory, string> = {
  positive: 'positive',
  negative: 'negative',
  boundary: 'boundary',
  edge: 'edge',
  permission: 'role_based',
};

function familyOf(category: ValidationCategory): CoverageFamily {
  return coverageFamily(CATEGORY_TO_TYPE[category]);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

/** Build a ValidationPoint from a template bound to a concrete element. */
function toPoint(
  tpl: ValidationTemplate,
  opts: {
    target: ValidationTarget;
    appliesTo: string;
    displayName: string;
    source: ValidationPoint['source'];
    assumption: boolean;
  },
): ValidationPoint {
  return {
    id: `${slug(opts.appliesTo)}:${tpl.category}:${tpl.key}`,
    category: tpl.category,
    family: familyOf(tpl.category),
    title: tpl.title(opts.displayName),
    target: opts.target,
    appliesTo: opts.appliesTo,
    rationale: tpl.rationale,
    source: opts.source,
    assumption: opts.assumption,
  };
}

/** A target is an assumption unless it rests on observed/stated fact. */
function isAssumption(source: ValidationPoint['source']): boolean {
  return source !== 'repository' && source !== 'requirement';
}

function planFieldPoints(field: FieldModel, opts: Required<ValidationPlanOptions>): ValidationPoint[] {
  const required = field.required === true;
  const templates = templatesForField(field.dataType, required, opts.includeInputSafetyEdges);
  const fieldSourceAssumed = isAssumption(field.provenance.source);

  let points = templates.map((tpl) => {
    const p = toPoint(tpl, {
      target: 'field',
      appliesTo: field.normalized,
      displayName: field.name,
      source: field.provenance.source,
      assumption: false, // set precisely below
    });
    // A check is an assumption when its target field is assumption-sourced, OR
    // when it is a boundary/edge best-practice the requirement never spelled out
    // (positive/negative on a stated field are grounded expectations).
    p.assumption = fieldSourceAssumed || p.category === 'boundary' || p.category === 'edge';
    return p;
  });

  // optional cap on edge points per field, keeping the strongest-sourced first
  if (opts.maxEdgePerField > 0) {
    const edges = points.filter((p) => p.family === 'edge');
    if (edges.length > opts.maxEdgePerField) {
      const keep = new Set(edges.slice(0, opts.maxEdgePerField).map((p) => p.id));
      points = points.filter((p) => p.family !== 'edge' || keep.has(p.id));
    }
  }
  return points;
}

function planRulePoints(rule: BusinessRuleModel): ValidationPoint[] {
  const targetName = rule.appliesTo ?? rule.normalized;
  const displayName = rule.appliesTo ? titleize(rule.appliesTo) : rule.name;
  const templates = templatesForRule(rule.ruleType, displayName);
  return templates.map((tpl) =>
    toPoint(tpl, {
      target: 'rule',
      appliesTo: targetName,
      displayName,
      source: rule.provenance.source,
      // a rule violation the requirement stated is grounded; otherwise assumption.
      assumption: isAssumption(rule.provenance.source),
    }),
  );
}

function titleize(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Entity/action happy path: one grounded positive for the primary action. */
function planEntityPositive(model: BusinessModel): ValidationPoint | null {
  const entity = model.entities[0];
  if (!entity) return null;
  const action = model.actions[0];
  const verb = action ? action.name : 'Use';
  const src = entity.provenance.source;
  return {
    id: `${slug(entity.normalized)}:positive:happy-path`,
    category: 'positive',
    family: 'positive',
    title: `Successfully ${verb} ${entity.name} with valid data`,
    target: 'entity',
    appliesTo: entity.normalized,
    rationale: 'The primary success path for the requirement must be verified.',
    source: src,
    assumption: isAssumption(src),
  };
}

function summarize(points: ValidationPoint[]): PlannedCoverageMix {
  const mix: PlannedCoverageMix = { positive: 0, negative: 0, edge: 0, advanced: 0, total: points.length, label: '' };
  for (const p of points) mix[p.family] += 1;
  mix.label = `Positive: ${mix.positive} · Negative: ${mix.negative} · Edge: ${mix.edge} · Advanced: ${mix.advanced}`;
  return mix;
}

/**
 * Plan the validations for a Business Model.
 *
 * Deterministic: same model + options → identical plan. De-duplicates points
 * that a field-type template and a rule template both imply (e.g. a `mandatory`
 * rule and a `required` field both want the empty-rejection negative), keeping
 * the strongest-sourced instance.
 */
export function planValidations(model: BusinessModel, options: ValidationPlanOptions = {}): ValidationPlan {
  const opts: Required<ValidationPlanOptions> = {
    includeInputSafetyEdges: options.includeInputSafetyEdges ?? true,
    maxEdgePerField: options.maxEdgePerField ?? 0,
  };

  const raw: ValidationPoint[] = [];
  const entityPositive = planEntityPositive(model);
  if (entityPositive) raw.push(entityPositive);
  for (const field of model.fields) raw.push(...planFieldPoints(field, opts));
  for (const rule of model.businessRules) raw.push(...planRulePoints(rule));

  // de-dupe by id; on collision keep the strongest-sourced (repository <
  // requirement < …) and the grounded (non-assumption) instance.
  const byId = new Map<string, ValidationPoint>();
  const rank: Record<ValidationPoint['source'], number> = {
    repository: 1, requirement: 2, knowledge_base: 3, domain_inference: 4, llm_guess: 5,
  };
  for (const p of raw) {
    const existing = byId.get(p.id);
    if (!existing) { byId.set(p.id, p); continue; }
    const better = rank[p.source] < rank[existing.source] ? p : existing;
    const merged = { ...better, assumption: better.assumption && p.assumption };
    byId.set(p.id, merged);
  }

  const points = [...byId.values()].sort((a, b) => {
    const order: CoverageFamily[] = ['positive', 'negative', 'edge', 'advanced'];
    const fa = order.indexOf(a.family) - order.indexOf(b.family);
    return fa !== 0 ? fa : a.id.localeCompare(b.id);
  });

  return {
    requirementId: model.requirementId,
    entity: model.entities[0]?.name ?? null,
    points,
    mix: summarize(points),
  };
}
