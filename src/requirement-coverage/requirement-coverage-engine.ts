/**
 * Requirement Coverage Engine.
 *
 * ONE responsibility: given a requirement and the repository's Coverage Model,
 * decide how well that requirement is already covered by existing tests and
 * report COVERED / PARTIAL / MISSING with the covered and missing behaviors.
 *
 * This is the comparison layer of Coverage Intelligence. It is deliberately
 * separate from:
 *   - the Repository Context Engine (which BUILDS the Coverage Model),
 *   - Generation Intelligence (which decides reuse/extend/generate),
 *   - the Reuse Engine (which finds reusable code),
 *   - the Script Generator (which writes missing tests).
 *
 * It is fully deterministic — no LLM, no embeddings, no network, no DB. Every
 * decision is traceable to the matching ladder below.
 *
 * Matching ladder (priority order — keyword is the LAST resort, never first):
 *   1. FLOW            — behavior matches a covered flow by name          (1.00)
 *   2. BUSINESS_ACTION — behavior matches via canonical action synonyms   (0.90)
 *   3. ASSERTION       — behavior keywords overlap the feature assertions (0.70)
 *   4. PAGE_OBJECT     — requirement page overlaps the feature page set   (0.60)
 *   5. KEYWORD         — token Jaccard overlap above threshold            (0.45)
 *   6. NONE            — no match
 */

import { CoverageModel } from '../context/types';
import {
  RequirementInput,
  RequirementCoverage,
  BehaviorMatch,
  CoverageMatchLevel,
  CoverageSlice,
} from './types';

/* ------------------------------------------------------------------ */
/*  Tunable weights & thresholds (documented, deterministic)          */
/* ------------------------------------------------------------------ */

const LEVEL_WEIGHT: Record<Exclude<CoverageMatchLevel, 'NONE'>, number> = {
  FLOW: 1.0,
  BUSINESS_ACTION: 0.9,
  ASSERTION: 0.7,
  PAGE_OBJECT: 0.6,
  KEYWORD: 0.45,
};

// Minimum feature-selection score below which no Coverage Model is considered a
// candidate for the requirement at all.
const MIN_FEATURE_SCORE = 0.1;
// Token-overlap (Jaccard) threshold for the KEYWORD ladder rung.
const KEYWORD_JACCARD_MIN = 0.34;
// Confidence assigned to an unmatched behavior when a candidate model existed
// but nothing matched (we are moderately sure it is genuinely missing).
const UNMATCHED_WITH_MODEL_CONF = 0.5;
// Confidence assigned to every behavior when NO candidate model existed at all
// (very sure the requirement is missing — the repo has nothing in this area).
const NO_MODEL_CONF = 0.9;

/* ------------------------------------------------------------------ */
/*  Tokenization & canonical business actions                          */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'for', 'and', 'or', 'with', 'as',
  'is', 'are', 'be', 'can', 'should', 'must', 'will', 'that', 'this', 'it',
  'user', 'users', 'able', 'via', 'when', 'then', 'given', 'test', 'verify',
  'verifies', 'check', 'checks', 'ensure', 'ensures', 'should', 'valid',
]);

/** Lowercase, split on non-alphanumerics, drop stopwords and tag tokens. */
function tokenize(text: string): Set<string> {
  if (!text) return new Set();
  const cleaned = text
    .replace(/@[\w:.-]+/g, ' ')   // @tc:TC1001, @smoke
    .replace(/\[[^\]]*\]/g, ' ')   // [TC-42]
    .toLowerCase();
  const tokens = cleaned
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 1 && !STOPWORDS.has(t) && !/^tc\d*$/.test(t));
  return new Set(tokens);
}

/**
 * Canonical business-action synonym map. Each canonical action maps to the
 * surface phrases/words that express it. Matching is phrase-aware (multi-word
 * phrases are checked as substrings) so "sign in" and "log in" both resolve to
 * the `login` action.
 */
const BUSINESS_ACTIONS: Record<string, string[]> = {
  login: ['login', 'log in', 'signin', 'sign in', 'authenticate', 'authentication', 'log on', 'logon'],
  logout: ['logout', 'log out', 'signout', 'sign out'],
  register: ['register', 'registration', 'signup', 'sign up', 'create account', 'create an account'],
  checkout: ['checkout', 'check out', 'purchase', 'pay', 'payment', 'place order', 'place an order'],
  search: ['search', 'find', 'query', 'filter', 'lookup'],
  add_to_cart: ['add to cart', 'add to basket', 'add item', 'add product'],
  remove_from_cart: ['remove from cart', 'remove item', 'delete from cart'],
  reset_password: ['reset password', 'forgot password', 'forgotten password', 'recover password'],
  sort: ['sort', 'order by', 'reorder'],
};

/** Return the set of canonical business actions expressed by a piece of text. */
function canonicalActions(text: string): Set<string> {
  const lower = ` ${(text || '').toLowerCase()} `;
  const found = new Set<string>();
  for (const [action, phrases] of Object.entries(BUSINESS_ACTIONS)) {
    for (const phrase of phrases) {
      // word-boundary-ish containment: pad with spaces / punctuation tolerance
      const re = new RegExp(`(^|[^a-z])${phrase.replace(/\s+/g, '\\s+')}([^a-z]|$)`, 'i');
      if (re.test(lower)) {
        found.add(action);
        break;
      }
    }
  }
  return found;
}

/* ------------------------------------------------------------------ */
/*  Set helpers                                                        */
/* ------------------------------------------------------------------ */

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

function canonEq(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/* ------------------------------------------------------------------ */
/*  Feature (Coverage Model) selection                                 */
/* ------------------------------------------------------------------ */

/**
 * Score how well a Coverage Model matches the requirement, 0-1.
 * 1.0 when the requirement's declared feature canonically equals the model's;
 * otherwise the best keyword Jaccard between the requirement text and the
 * model's feature name + flow names.
 */
function featureMatchScore(req: RequirementInput, model: CoverageModel): number {
  if (req.feature && canonEq(req.feature, model.feature)) return 1.0;

  const reqTokens = tokenize(
    `${req.title} ${req.description || ''} ${(req.expectedFlows || []).join(' ')} ${req.feature || ''}`
  );
  const modelTokens = tokenize(
    `${model.feature} ${model.flows.map(f => f.name).join(' ')}`
  );
  return jaccard(reqTokens, modelTokens);
}

interface Candidate {
  model: CoverageModel;
  score: number;
}

function selectCandidate(req: RequirementInput, models: CoverageModel[]): Candidate | null {
  let best: Candidate | null = null;
  for (const model of models) {
    const score = featureMatchScore(req, model);
    if (!best || score > best.score || (score === best.score && model.feature.localeCompare(best.model.feature) < 0)) {
      best = { model, score };
    }
  }
  if (!best || best.score < MIN_FEATURE_SCORE) return null;
  return best;
}

/* ------------------------------------------------------------------ */
/*  Per-behavior matching down the ladder                              */
/* ------------------------------------------------------------------ */

function matchBehavior(behavior: string, model: CoverageModel): BehaviorMatch {
  const behTokens = tokenize(behavior);
  const behActions = canonicalActions(behavior);

  // 1. FLOW — behavior name equals / is a token-subset of a covered flow name.
  let bestKeyword: { flow: string; score: number } | null = null;
  for (const flow of model.flows) {
    if (canonEq(behavior, flow.name)) {
      return { behavior, level: 'FLOW', matchedFlow: flow.name, score: LEVEL_WEIGHT.FLOW };
    }
    const flowTokens = tokenize(flow.name);
    // token-subset: every meaningful behavior token appears in the flow name
    if (behTokens.size > 0) {
      let subset = true;
      for (const t of behTokens) if (!flowTokens.has(t)) { subset = false; break; }
      if (subset) {
        return { behavior, level: 'FLOW', matchedFlow: flow.name, score: LEVEL_WEIGHT.FLOW };
      }
    }
    // track best keyword overlap for the KEYWORD rung later
    const j = jaccard(behTokens, flowTokens);
    if (!bestKeyword || j > bestKeyword.score) bestKeyword = { flow: flow.name, score: j };
  }

  // 2. BUSINESS_ACTION — behavior's canonical action matches a covered flow's.
  if (behActions.size > 0) {
    for (const flow of model.flows) {
      const flowActions = canonicalActions(flow.name);
      if (intersects(behActions, flowActions)) {
        return { behavior, level: 'BUSINESS_ACTION', matchedFlow: flow.name, score: LEVEL_WEIGHT.BUSINESS_ACTION };
      }
    }
    // also consider the feature name itself expressing the action
    if (intersects(behActions, canonicalActions(model.feature))) {
      return { behavior, level: 'BUSINESS_ACTION', matchedFlow: null, score: LEVEL_WEIGHT.BUSINESS_ACTION };
    }
  }

  // 3. ASSERTION — behavior keywords overlap the feature's assertion matchers.
  const assertionTokens = tokenize(model.assertions.join(' '));
  if (behTokens.size > 0 && intersects(behTokens, assertionTokens)) {
    return { behavior, level: 'ASSERTION', matchedFlow: null, score: LEVEL_WEIGHT.ASSERTION };
  }

  // 4. PAGE_OBJECT — requirement page overlaps the feature's page/screen set.
  //    (Handled by the caller which knows req.pages; see assessRequirementCoverage.)

  // 5. KEYWORD — token Jaccard overlap above threshold (last resort).
  if (bestKeyword && bestKeyword.score >= KEYWORD_JACCARD_MIN) {
    return { behavior, level: 'KEYWORD', matchedFlow: bestKeyword.flow, score: LEVEL_WEIGHT.KEYWORD };
  }

  return { behavior, level: 'NONE', matchedFlow: null, score: 0 };
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Assess how well a single requirement is covered by the repository's Coverage
 * Model. Deterministic and side-effect free.
 */
export function assessRequirementCoverage(
  req: RequirementInput,
  models: CoverageModel[],
): RequirementCoverage {
  // Expected behaviors, each paired with its linked test case id(s) so the
  // verdict can be sliced back to exact test cases downstream (EXTEND) with NO
  // title matching. Priority: structured `behaviors` (carry ids) → `expectedFlows`
  // (ids empty) → the title as a single behavior (ids empty).
  const behaviorInputs: { label: string; testCaseIds: string[] }[] =
    (req.behaviors && req.behaviors.length > 0)
      ? req.behaviors
          .filter(b => b && typeof b.label === 'string' && b.label.trim())
          .map(b => ({ label: b.label, testCaseIds: b.testCaseIds ?? [] }))
      : (req.expectedFlows && req.expectedFlows.length > 0)
        ? req.expectedFlows.filter(b => b && b.trim()).map(label => ({ label, testCaseIds: [] }))
        : [{ label: req.title, testCaseIds: [] }];
  const behaviors = behaviorInputs.map(b => b.label);

  const candidate = selectCandidate(req, models);

  // No candidate model at all → everything is MISSING with high confidence.
  if (!candidate) {
    const matches: BehaviorMatch[] = behaviors.map(b => ({
      behavior: b, level: 'NONE' as CoverageMatchLevel, matchedFlow: null, score: 0,
    }));
    return {
      requirementId: req.id,
      status: 'MISSING',
      coverage: 0,
      coveredFlows: [],
      missingFlows: [...behaviors],
      coveredSlices: [],
      missingSlices: behaviorInputs.map(b => ({ flow: b.label, testCaseIds: b.testCaseIds })),
      confidence: Math.round(NO_MODEL_CONF * 100),
      matchedFeature: null,
      matches,
    };
  }

  const model = candidate.model;
  const reqPages = new Set((req.pages || []).map(p => p.trim().toLowerCase()).filter(Boolean));
  const modelPages = new Set(model.pageObjects.map(p => p.trim().toLowerCase()));

  const matches: BehaviorMatch[] = behaviors.map(behavior => {
    const m = matchBehavior(behavior, model);
    if (m.level !== 'NONE') return m;
    // PAGE_OBJECT rung: only reachable if ladder rungs 1-3 & 5 failed.
    if (reqPages.size > 0 && intersects(reqPages, modelPages)) {
      return { behavior, level: 'PAGE_OBJECT' as CoverageMatchLevel, matchedFlow: null, score: LEVEL_WEIGHT.PAGE_OBJECT };
    }
    return m;
  });

  const coveredFlows = matches.filter(m => m.level !== 'NONE').map(m => m.behavior);
  const missingFlows = matches.filter(m => m.level === 'NONE').map(m => m.behavior);

  // Bucket the SAME behaviors into slices carrying their test case id(s). matches
  // is `behaviors.map(...)` so it shares index order with behaviorInputs — zip by
  // index to keep each flow bound to the exact test case(s) the caller supplied.
  const coveredSlices: CoverageSlice[] = [];
  const missingSlices: CoverageSlice[] = [];
  matches.forEach((m, i) => {
    const slice: CoverageSlice = { flow: m.behavior, testCaseIds: behaviorInputs[i].testCaseIds };
    if (m.level !== 'NONE') coveredSlices.push(slice);
    else missingSlices.push(slice);
  });

  const total = behaviors.length;
  const coveredCount = coveredFlows.length;
  const coverage = total === 0 ? 0 : Math.round((coveredCount / total) * 100);

  let status: RequirementCoverage['status'];
  if (coveredCount === 0) status = 'MISSING';
  else if (coveredCount === total) status = 'COVERED';
  else status = 'PARTIAL';

  // Confidence = mean per-behavior confidence.
  //  - matched behavior → the ladder weight it matched at
  //  - unmatched but a candidate model existed → moderate (maybe just missing)
  //  - (no-model case handled above)
  const perBehaviorConf = matches.map(m =>
    m.level !== 'NONE' ? m.score : Math.max(candidate.score, UNMATCHED_WITH_MODEL_CONF),
  );
  const meanConf = perBehaviorConf.reduce((s, x) => s + x, 0) / (perBehaviorConf.length || 1);
  const confidence = Math.round(meanConf * 100);

  return {
    requirementId: req.id,
    status,
    coverage,
    coveredFlows,
    missingFlows,
    coveredSlices,
    missingSlices,
    confidence,
    matchedFeature: model.feature,
    matches,
  };
}
