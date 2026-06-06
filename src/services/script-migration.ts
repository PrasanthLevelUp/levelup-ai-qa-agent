/**
 * Migration Assistant (Feature D — bulk re-point scripts between crawls)
 * --------------------------------------------------------------------------
 * When an app is re-crawled (e.g. after a redesign), selectors shift en masse.
 * Rather than syncing one script at a time, the Migration Assistant diffs two
 * crawl signatures, proposes a `oldSelector → newSelector` element mapping
 * (heuristic by default, embedding-assisted when an OpenAI client is supplied),
 * lets a human override the suggestions, then applies the mapping across every
 * affected script in one batch and previews the diffs.
 *
 * Pure & deterministic except for the optional embedding path. The route layer
 * owns DB persistence and PR creation.
 */

import type { CrawlSignature } from './script-maintenance';
import { applyReplacements, concreteSelectorsFromLocator } from './script-sync';
import { parseScriptContent } from './script-file-parser';

/** A single proposed element mapping between the old and new crawl. */
export interface ElementMapping {
  oldSelector: string;
  /** Best-guess replacement; empty when no confident candidate was found. */
  newSelector: string;
  /** 0–100 confidence in the suggestion. */
  confidence: number;
  /** How the suggestion was derived. */
  method: 'exact' | 'value-token' | 'embedding' | 'none';
  /** Ranked alternative candidates the user can pick instead. */
  alternatives?: string[];
}

/** Per-script diff produced by applying a migration. */
export interface MigrationScriptDiff {
  scriptId: number;
  url: string;
  changed: boolean;
  replacements: Array<{ oldSelector: string; newSelector: string; occurrences: number }>;
  newScriptContent?: string;
}

/* -------------------------------------------------------------------------- */
/*  Selector similarity helpers                                               */
/* -------------------------------------------------------------------------- */

/** Extract the human-meaningful value out of a selector token. */
function selectorValue(sel: string): string {
  const m = sel.match(/["']([^"']+)["']|#([\w-]+)|\bname=([\w-]+)/);
  return (m ? m[1] || m[2] || m[3] : sel).toLowerCase();
}

/** Split a selector value into comparable tokens (camelCase, kebab, snake). */
function tokenize(value: string): string[] {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean);
}

/** Jaccard token overlap of two selector values (0–1). */
function tokenSimilarity(a: string, b: string): number {
  const sa = new Set(tokenize(selectorValue(a)));
  const sb = new Set(tokenize(selectorValue(b)));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/* -------------------------------------------------------------------------- */
/*  Mapping suggestion                                                        */
/* -------------------------------------------------------------------------- */

/** An optional embedding provider (matches OpenAIClient's surface). */
export interface EmbeddingProvider {
  batchGenerateEmbeddings(texts: string[]): Promise<number[][]>;
  cosineSimilarity(a: number[], b: number[]): number;
}

/**
 * Suggest element mappings between two crawl signatures.
 *
 * Strategy per removed selector:
 *   1. exact     — same selector exists in new crawl (no real change).
 *   2. value-token — highest Jaccard token overlap among *added* selectors.
 *   3. embedding — (optional) cosine similarity of selector-value embeddings,
 *                  used to break ties / rescue low token-overlap cases.
 */
export async function suggestMappings(
  oldSig: CrawlSignature | null,
  newSig: CrawlSignature | null,
  embedder?: EmbeddingProvider | null,
): Promise<ElementMapping[]> {
  const oldSelectors = oldSig?.allSelectors ?? [];
  const newSelectors = newSig?.allSelectors ?? [];
  const newSet = new Set(newSelectors);

  // Selectors only present in the old crawl need a replacement.
  const removed = oldSelectors.filter((s) => !newSet.has(s));
  // Candidates to map onto: selectors added in the new crawl.
  const oldSet = new Set(oldSelectors);
  const added = newSelectors.filter((s) => !oldSet.has(s));

  // Selectors that survived unchanged map to themselves (exact).
  const mappings: ElementMapping[] = oldSelectors
    .filter((s) => newSet.has(s))
    .map((s) => ({ oldSelector: s, newSelector: s, confidence: 100, method: 'exact' as const }));

  // Optional embeddings for the changed sets.
  let oldEmb: number[][] | null = null;
  let addedEmb: number[][] | null = null;
  if (embedder && removed.length && added.length) {
    try {
      oldEmb = await embedder.batchGenerateEmbeddings(removed.map(selectorValue));
      addedEmb = await embedder.batchGenerateEmbeddings(added.map(selectorValue));
    } catch {
      oldEmb = null;
      addedEmb = null;
    }
  }

  removed.forEach((oldSel, i) => {
    // Rank added candidates by token similarity (and embeddings if available).
    const scored = added.map((newSel, j) => {
      const tok = tokenSimilarity(oldSel, newSel);
      let emb = 0;
      if (oldEmb && addedEmb && oldEmb[i] && addedEmb[j]) {
        emb = Math.max(0, embedder!.cosineSimilarity(oldEmb[i], addedEmb[j]));
      }
      // Blend: token overlap is the dominant signal, embeddings refine ties.
      const score = oldEmb ? 0.6 * tok + 0.4 * emb : tok;
      return { newSel, score, tok, emb };
    });
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    if (best && best.score > 0.15) {
      mappings.push({
        oldSelector: oldSel,
        newSelector: best.newSel,
        confidence: Math.round(Math.min(99, best.score * 100)),
        method: oldEmb && best.emb >= best.tok ? 'embedding' : 'value-token',
        alternatives: scored.slice(1, 4).filter((s) => s.score > 0.1).map((s) => s.newSel),
      });
    } else {
      mappings.push({ oldSelector: oldSel, newSelector: '', confidence: 0, method: 'none' });
    }
  });

  return mappings;
}

/**
 * Merge user overrides (`{ oldSelector: newSelector }`) onto a base mapping
 * set. Overrides win and are marked as 100% confident / manual.
 */
export function applyOverrides(
  mappings: ElementMapping[],
  overrides: Record<string, string>,
): ElementMapping[] {
  const byOld = new Map(mappings.map((m) => [m.oldSelector, { ...m }]));
  for (const [oldSel, newSel] of Object.entries(overrides || {})) {
    const existing = byOld.get(oldSel);
    if (existing) {
      existing.newSelector = newSel;
      existing.confidence = 100;
      existing.method = 'exact';
    } else {
      byOld.set(oldSel, { oldSelector: oldSel, newSelector: newSel, confidence: 100, method: 'exact' });
    }
  }
  return Array.from(byOld.values());
}

/* -------------------------------------------------------------------------- */
/*  Batch apply                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Translate a selector→selector mapping into the concrete locator string
 * replacements needed inside a script, then apply them. Only mappings whose
 * `oldSelector` actually appears in the script (as a concrete locator selector)
 * produce a replacement.
 */
export function applyMigrationToScript(
  script: { id: number; url: string; script_content?: string | null; files_generated?: unknown },
  mappings: ElementMapping[],
  apply = false,
): MigrationScriptDiff {
  const files = parseScriptContent(script.script_content, script.files_generated);
  // Build a selector→selector map of only the meaningful (non-empty) mappings.
  const selMap: Record<string, string> = {};
  for (const m of mappings) {
    if (m.newSelector && m.newSelector !== m.oldSelector) selMap[m.oldSelector] = m.newSelector;
  }

  const replacements: MigrationScriptDiff['replacements'] = [];
  const rewritten = files.map((f) => {
    const { newContent, counts } = applyReplacements(f.content, selMap);
    for (const [oldSel, n] of Object.entries(counts)) {
      if (n > 0) {
        const existing = replacements.find((r) => r.oldSelector === oldSel);
        if (existing) existing.occurrences += n;
        else replacements.push({ oldSelector: oldSel, newSelector: selMap[oldSel], occurrences: n });
      }
    }
    return { ...f, content: newContent };
  });

  const changed = replacements.length > 0;
  const diff: MigrationScriptDiff = { scriptId: script.id, url: script.url, changed, replacements };
  if (changed && apply) {
    diff.newScriptContent = rewritten.map((f) => `// === ${f.path} ===\n${f.content}`).join('\n\n');
  }
  return diff;
}

/** Which scripts (by stored content) reference any of the removed selectors. */
export function findAffectedScripts(
  scripts: Array<{ id: number; url: string; script_content?: string | null; files_generated?: unknown }>,
  removedSelectors: string[],
): number[] {
  const affected: number[] = [];
  for (const s of scripts) {
    const files = parseScriptContent(s.script_content, s.files_generated);
    const blob = files.map((f) => f.content).join('\n');
    const concrete = new Set<string>();
    for (const sel of (blob.match(/page\s*\.\s*\w+\([^)]*\)/g) || [])) {
      concreteSelectorsFromLocator(sel).forEach((c) => concrete.add(c));
    }
    if (removedSelectors.some((rs) => concrete.has(rs))) affected.push(s.id);
  }
  return affected;
}
