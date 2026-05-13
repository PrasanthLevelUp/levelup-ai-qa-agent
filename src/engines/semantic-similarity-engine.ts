/**
 * Semantic Similarity Engine
 * Provides intelligent string similarity scoring for locator healing.
 * Compares attributes, labels, placeholders, roles, nearby DOM context.
 *
 * Key insight: When input[name="user"] fails, we need to find input[name="username"]
 * by understanding that "user" and "username" are semantically related.
 *
 * Comparison dimensions:
 * 1. Attribute value similarity (Levenshtein, substring, common prefix)
 * 2. Semantic word matching (user ↔ username, email ↔ mail, pwd ↔ password)
 * 3. DOM structural similarity (same parent, same position)
 * 4. Label/placeholder proximity
 */

import { logger } from '../utils/logger';

const MOD = 'semantic-similarity';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface SimilarityResult {
  score: number; // 0.0 to 1.0
  breakdown: SimilarityBreakdown;
  reasoning: string;
}

export interface SimilarityBreakdown {
  stringDistance: number;
  substringMatch: number;
  semanticMatch: number;
  commonPrefix: number;
  attributeTypeBonus: number;
  contextBonus: number;
}

/* -------------------------------------------------------------------------- */
/*  Semantic Word Mappings                                                    */
/* -------------------------------------------------------------------------- */

/** Known semantic equivalences in web forms */
const SEMANTIC_GROUPS: string[][] = [
  ['user', 'username', 'usr', 'user_name', 'userName', 'login', 'loginName', 'login_name', 'uname'],
  ['pass', 'password', 'pwd', 'passwd', 'pass_word', 'passWord', 'secret'],
  ['email', 'mail', 'e-mail', 'emailAddress', 'email_address', 'userEmail', 'user_email'],
  ['phone', 'tel', 'telephone', 'mobile', 'cell', 'phoneNumber', 'phone_number'],
  ['first', 'firstName', 'first_name', 'fname', 'givenName', 'given_name'],
  ['last', 'lastName', 'last_name', 'lname', 'surname', 'familyName', 'family_name'],
  ['name', 'fullName', 'full_name', 'displayName', 'display_name'],
  ['addr', 'address', 'street', 'streetAddress', 'street_address'],
  ['city', 'town', 'municipality'],
  ['state', 'province', 'region'],
  ['zip', 'zipcode', 'zipCode', 'zip_code', 'postal', 'postalCode', 'postal_code'],
  ['country', 'nation', 'countryCode', 'country_code'],
  ['search', 'query', 'q', 'searchQuery', 'search_query', 'keyword'],
  ['submit', 'login', 'signin', 'sign-in', 'signIn', 'log-in', 'logIn'],
  ['cancel', 'close', 'dismiss', 'back', 'return'],
  ['save', 'update', 'apply', 'confirm', 'ok'],
  ['delete', 'remove', 'destroy', 'trash'],
  ['msg', 'message', 'comment', 'text', 'body', 'content', 'description'],
  ['btn', 'button', 'cta'],
  ['img', 'image', 'photo', 'picture', 'avatar', 'icon'],
  ['nav', 'navigation', 'menu', 'sidebar'],
  ['hdr', 'header', 'heading', 'title'],
  ['ftr', 'footer', 'bottom'],
];

/** Build a lookup map for fast semantic matching */
const SEMANTIC_MAP = new Map<string, number>();
SEMANTIC_GROUPS.forEach((group, groupIdx) => {
  group.forEach((word) => {
    SEMANTIC_MAP.set(word.toLowerCase(), groupIdx);
  });
});

/* -------------------------------------------------------------------------- */
/*  Core Similarity Functions                                                 */
/* -------------------------------------------------------------------------- */

/** Levenshtein distance */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Normalized Levenshtein similarity (0..1) */
function normalizedLevenshtein(a: string, b: string): number {
  if (a === b) return 1.0;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  return 1 - levenshtein(a, b) / maxLen;
}

/** Common prefix ratio */
function commonPrefixRatio(a: string, b: string): number {
  let i = 0;
  const min = Math.min(a.length, b.length);
  while (i < min && a[i] === b[i]) i++;
  if (i === 0) return 0;
  return i / Math.max(a.length, b.length);
}

/** Substring containment score */
function substringScore(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  if (bl.includes(al)) return al.length / bl.length; // "user" in "username" = 4/8 = 0.5
  if (al.includes(bl)) return bl.length / al.length;
  return 0;
}

/** Semantic group matching */
function semanticGroupMatch(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();

  // Direct group match
  const groupA = SEMANTIC_MAP.get(al);
  const groupB = SEMANTIC_MAP.get(bl);
  if (groupA !== undefined && groupB !== undefined && groupA === groupB) {
    return 0.85; // Same semantic group
  }

  // Partial word matching: split camelCase and snake_case
  const wordsA = splitWords(al);
  const wordsB = splitWords(bl);

  // Check if any word from A matches any word from B's semantic group
  for (const wa of wordsA) {
    const gA = SEMANTIC_MAP.get(wa);
    if (gA === undefined) continue;
    for (const wb of wordsB) {
      const gB = SEMANTIC_MAP.get(wb);
      if (gB !== undefined && gA === gB) return 0.75;
    }
  }

  // Word overlap
  const overlap = wordsA.filter((w) => wordsB.includes(w));
  if (overlap.length > 0) {
    return overlap.length / Math.max(wordsA.length, wordsB.length) * 0.6;
  }

  return 0;
}

/** Split string into words (camelCase, snake_case, kebab-case) */
function splitWords(str: string): string[] {
  return str
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[-_]+/g, '_')
    .toLowerCase()
    .split('_')
    .filter((w) => w.length > 0);
}

/* -------------------------------------------------------------------------- */
/*  Semantic Similarity Engine                                                */
/* -------------------------------------------------------------------------- */

export class SemanticSimilarityEngine {
  /**
   * Calculate comprehensive similarity between two attribute values.
   */
  compare(
    failedValue: string,
    candidateValue: string,
    context?: {
      sameTag?: boolean;
      sameAttributeType?: boolean;
      nearbyLabel?: string;
    },
  ): SimilarityResult {
    const a = failedValue.toLowerCase();
    const b = candidateValue.toLowerCase();

    // Calculate individual scores
    const stringDistance = normalizedLevenshtein(a, b);
    const substringMatch = substringScore(a, b);
    const semanticMatch = semanticGroupMatch(a, b);
    const commonPrefix = commonPrefixRatio(a, b);

    // Bonuses
    const attributeTypeBonus = context?.sameAttributeType ? 0.15 : 0;
    const tagBonus = context?.sameTag ? 0.05 : 0;
    const labelBonus = context?.nearbyLabel
      ? stringSimilaritySimple(failedValue, context.nearbyLabel) * 0.10
      : 0;
    const contextBonus = tagBonus + labelBonus;

    // Weighted composite score
    const rawScore =
      stringDistance * 0.25 +
      substringMatch * 0.25 +
      semanticMatch * 0.25 +
      commonPrefix * 0.10 +
      attributeTypeBonus +
      contextBonus;

    const score = Math.min(1.0, Math.round(rawScore * 100) / 100);

    const breakdown: SimilarityBreakdown = {
      stringDistance: Math.round(stringDistance * 100) / 100,
      substringMatch: Math.round(substringMatch * 100) / 100,
      semanticMatch: Math.round(semanticMatch * 100) / 100,
      commonPrefix: Math.round(commonPrefix * 100) / 100,
      attributeTypeBonus: Math.round(attributeTypeBonus * 100) / 100,
      contextBonus: Math.round(contextBonus * 100) / 100,
    };

    // Build reasoning
    const reasons: string[] = [];
    if (semanticMatch > 0.5) reasons.push(`semantic group match (${semanticMatch.toFixed(2)})`);
    if (substringMatch > 0.3) reasons.push(`substring "${a}" in "${b}" (${substringMatch.toFixed(2)})`);
    if (stringDistance > 0.6) reasons.push(`string similarity (${stringDistance.toFixed(2)})`);
    if (commonPrefix > 0.5) reasons.push(`common prefix (${commonPrefix.toFixed(2)})`);
    if (attributeTypeBonus > 0) reasons.push('same attribute type bonus');
    const reasoning = reasons.length > 0
      ? `"${failedValue}" → "${candidateValue}": ${reasons.join(', ')}`
      : `"${failedValue}" → "${candidateValue}": low similarity`;

    logger.debug(MOD, 'Similarity computed', {
      failed: failedValue,
      candidate: candidateValue,
      score,
      breakdown,
    });

    return { score, breakdown, reasoning };
  }

  /**
   * Rank multiple candidates by similarity to the failed value.
   */
  rankCandidates(
    failedValue: string,
    candidates: Array<{ value: string; selector: string; tag?: string; attribute?: string }>,
    failedAttribute?: string,
  ): Array<{ value: string; selector: string; similarity: SimilarityResult }> {
    return candidates
      .map((c) => ({
        ...c,
        similarity: this.compare(failedValue, c.value, {
          sameAttributeType: c.attribute === failedAttribute,
          sameTag: true,
        }),
      }))
      .filter((c) => c.similarity.score > 0.3)
      .sort((a, b) => b.similarity.score - a.similarity.score);
  }
}

/** Simple string similarity helper */
function stringSimilaritySimple(a: string, b: string): number {
  return normalizedLevenshtein(a.toLowerCase(), b.toLowerCase());
}
