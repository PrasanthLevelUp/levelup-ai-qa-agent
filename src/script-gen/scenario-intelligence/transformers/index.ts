import type { ScenarioKind, ScenarioTransformer } from '../types';
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
 * The scenario-kind → transformer registry. Adding a new scenario type is a
 * two-line change: implement a ScenarioTransformer and register it here (plus a
 * classifier rule). Nothing in the generator needs to change.
 */
export const SCENARIO_TRANSFORMERS: Record<ScenarioKind, ScenarioTransformer> = {
  empty: new EmptyFieldsTransformer(),
  whitespace: new WhitespaceTransformer(),
  special: new SpecialCharactersTransformer(),
  maxlength: new BoundaryLengthTransformer(),
  invalid: new InvalidCredentialsTransformer(),
  normal: new NormalTransformer(),
};

/** Resolve a transformer for a classified kind (falls back to the normal path). */
export function getScenarioTransformer(kind: ScenarioKind): ScenarioTransformer {
  return SCENARIO_TRANSFORMERS[kind] ?? SCENARIO_TRANSFORMERS.normal;
}
