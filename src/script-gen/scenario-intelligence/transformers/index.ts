import type {
  ScenarioCaseInput,
  ScenarioClassification,
  ScenarioKind,
  ScenarioTransformer,
} from '../types';
import { EmptyFieldsTransformer } from './empty-fields.transformer';
import { WhitespaceTransformer } from './whitespace.transformer';
import { SpecialCharactersTransformer } from './special-characters.transformer';
import { BoundaryLengthTransformer } from './boundary-length.transformer';
import { InvalidCredentialsTransformer } from './invalid-credentials.transformer';
import { NormalTransformer } from './normal.transformer';

export {
  EmptyFieldsTransformer,
  WhitespaceTransformer,
  SpecialCharactersTransformer,
  BoundaryLengthTransformer,
  InvalidCredentialsTransformer,
  NormalTransformer,
};

/**
 * The transformer registry, sorted by detection precedence.
 *
 * The registry does not know anything about individual scenarios: it simply asks
 * each transformer, in order, whether it matches and returns the first that does
 * (the most specific, testable mutation wins). Each transformer declares its own
 * `priority` (lower = higher precedence), so precedence is self-documenting and
 * resilient to refactoring:
 *
 *   empty (1) → whitespace (2) → special-char (3) → max-length (4) → invalid (5) → normal (99)
 *
 * `normal` has the lowest precedence (highest priority number) and matches
 * unconditionally, so it is the guaranteed fallback. Adding a new scenario type
 * is a single-file change: implement a ScenarioTransformer that owns its own
 * `matches` and `priority`, instantiate it here, and the registry will slot it in
 * the right order. Nothing in the generator — and no central classifier — needs
 * to change.
 */
const TRANSFORMERS_UNSORTED: ScenarioTransformer[] = [
  new EmptyFieldsTransformer(),
  new WhitespaceTransformer(),
  new SpecialCharactersTransformer(),
  new BoundaryLengthTransformer(),
  new InvalidCredentialsTransformer(),
  new NormalTransformer(),
];

export const SCENARIO_TRANSFORMERS: readonly ScenarioTransformer[] =
  TRANSFORMERS_UNSORTED.slice().sort((a, b) => a.priority - b.priority);

/** By-kind index, derived from the registry, for direct lookup by scenario kind. */
const BY_KIND: Record<ScenarioKind, ScenarioTransformer> = SCENARIO_TRANSFORMERS.reduce(
  (acc, t) => {
    acc[t.kind] = t;
    return acc;
  },
  {} as Record<ScenarioKind, ScenarioTransformer>,
);

/**
 * Ask each transformer, in precedence order, whether it matches the case; return
 * the first match's classification together with the transformer that owns it.
 * `normal` guarantees a result, so this never returns null.
 */
export function classifyScenario(
  input: ScenarioCaseInput | undefined,
  steps: string[],
): { classification: ScenarioClassification; transformer: ScenarioTransformer } {
  for (const transformer of SCENARIO_TRANSFORMERS) {
    const classification = transformer.matches(input, steps);
    if (classification) return { classification, transformer };
  }
  // Unreachable: NormalTransformer always matches. Kept as a defensive fallback.
  const transformer = BY_KIND.normal;
  return { classification: { kind: 'normal' }, transformer };
}

/** Resolve a transformer for an already-known kind (falls back to the normal path). */
export function getScenarioTransformer(kind: ScenarioKind): ScenarioTransformer {
  return BY_KIND[kind] ?? BY_KIND.normal;
}
