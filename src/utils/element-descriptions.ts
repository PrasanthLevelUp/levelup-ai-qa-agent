/**
 * Element-description extraction (shared intelligence helper)
 * ===========================================================
 *
 * The Locator Resolution Service needs a flat list of UI element descriptions
 * (e.g. "Login button", "email input", "Submit") so it can walk the priority
 * cascade and produce a locator + confidence for each. Those descriptions are
 * derived from, in order of preference:
 *   1. The structured test-case steps (when generating from a test case).
 *   2. The free-text generation instructions (the url-based / legacy flow).
 *
 * Step shapes vary across the platform (plain strings, objects with
 * `action`/`step`/`description`/`text`/`element`, or JSON-encoded strings), so
 * this helper normalises all of them defensively. It always returns a
 * de-duplicated array of trimmed, non-empty strings, and never throws — locator
 * resolution is strictly best-effort and must never break generation.
 *
 * Shared between the URL/crawl-based Script Gen route and the Test-Case-Lab
 * `TestToScriptEngine` so both ground their locators in the same way.
 */

export function extractElementDescriptions(
  testCase: any | null | undefined,
  instructions: string | null | undefined,
  maxItems = 50,
): string[] {
  const out: string[] = [];

  const pushText = (val: unknown): void => {
    if (val == null) return;
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (trimmed) out.push(trimmed);
    } else if (typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      const candidate =
        obj.action ?? obj.step ?? obj.description ?? obj.text ?? obj.element ?? obj.name ?? obj.title;
      if (typeof candidate === 'string') pushText(candidate);
    }
  };

  // 1. Prefer structured test-case steps when available.
  try {
    let steps: unknown = testCase?.steps;
    if (typeof steps === 'string') {
      // Steps may arrive as a JSON-encoded string.
      try { steps = JSON.parse(steps); } catch { /* leave as raw string */ }
    }
    if (Array.isArray(steps)) {
      for (const s of steps) pushText(s);
    } else if (typeof steps === 'string' && steps.trim()) {
      // Newline / numbered-list separated free text.
      for (const line of steps.split(/\r?\n/)) pushText(line);
    }
  } catch { /* non-fatal */ }

  // 2. Fall back to (or augment with) the free-text instructions.
  if (typeof instructions === 'string' && instructions.trim()) {
    for (const line of instructions.split(/\r?\n|(?<=[.;])\s+/)) {
      const trimmed = line.trim();
      // Skip very short fragments that won't resolve to a meaningful element.
      if (trimmed.length >= 3) out.push(trimmed);
    }
  }

  // De-duplicate (case-insensitive) while preserving order.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const item of out) {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
  }
  // Cap to a sane number to bound locator-resolution work.
  return deduped.slice(0, maxItems);
}
