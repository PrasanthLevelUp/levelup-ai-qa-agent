/**
 * Scenario Intelligence — public surface.
 *
 *   Test Case → ScenarioTransformer (self-matching) → Script Generation
 *
 * The generator uses the {@link ScenarioIntelligence} facade to classify a case
 * and obtain its transformer. Each scenario type lives in its own transformer
 * under ./transformers and owns its own detection (`matches`), so the layer is
 * extensible without a central classifier or any generator changes.
 */
import { classifyScenario, getScenarioTransformer } from './transformers';
import type { ScenarioCaseInput, ScenarioClassification, ScenarioTransformer } from './types';

export * from './types';
export {
  SCENARIO_TRANSFORMERS,
  classifyScenario,
  getScenarioTransformer,
  EmptyFieldsTransformer,
  WhitespaceTransformer,
  SpecialCharactersTransformer,
  BoundaryLengthTransformer,
  InvalidCredentialsTransformer,
  NormalTransformer,
} from './transformers';

/** Thin facade over the self-matching transformer registry. */
export class ScenarioIntelligence {
  /** Classify a test case's input-mutation intent (first matching transformer wins). */
  classify(tc: ScenarioCaseInput | undefined, steps: string[]): ScenarioClassification {
    return classifyScenario(tc, steps).classification;
  }

  /** Resolve the transformer for an already-known classification. */
  transformer(classification: ScenarioClassification): ScenarioTransformer {
    return getScenarioTransformer(classification.kind);
  }

  /** Convenience: classify then resolve the transformer in one step. */
  resolve(
    tc: ScenarioCaseInput | undefined,
    steps: string[],
  ): { classification: ScenarioClassification; transformer: ScenarioTransformer } {
    return classifyScenario(tc, steps);
  }
}
