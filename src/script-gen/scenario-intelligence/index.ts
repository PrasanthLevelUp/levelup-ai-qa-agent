/**
 * Scenario Intelligence — public surface.
 *
 *   Test Case → ScenarioClassifier → ScenarioTransformer → Script Generation
 *
 * The generator uses the {@link ScenarioIntelligence} facade to classify a case
 * and obtain its transformer; each scenario type lives in its own transformer
 * under ./transformers, so the layer is extensible without generator changes.
 */
import { ScenarioClassifier } from './scenario-classifier';
import { getScenarioTransformer } from './transformers';
import type { ScenarioCaseInput, ScenarioClassification, ScenarioTransformer } from './types';

export * from './types';
export { ScenarioClassifier } from './scenario-classifier';
export {
  SCENARIO_TRANSFORMERS,
  getScenarioTransformer,
  EmptyFieldsTransformer,
  WhitespaceTransformer,
  SpecialCharactersTransformer,
  BoundaryLengthTransformer,
  InvalidCredentialsTransformer,
  NormalTransformer,
} from './transformers';

/** Thin facade tying the classifier to the transformer registry. */
export class ScenarioIntelligence {
  private readonly classifier = new ScenarioClassifier();

  /** Classify a test case's input-mutation intent. */
  classify(tc: ScenarioCaseInput | undefined, steps: string[]): ScenarioClassification {
    return this.classifier.classify(tc, steps);
  }

  /** Resolve the transformer for a classified kind. */
  transformer(classification: ScenarioClassification): ScenarioTransformer {
    return getScenarioTransformer(classification.kind);
  }

  /** Convenience: classify then resolve the transformer in one step. */
  resolve(
    tc: ScenarioCaseInput | undefined,
    steps: string[],
  ): { classification: ScenarioClassification; transformer: ScenarioTransformer } {
    const classification = this.classify(tc, steps);
    return { classification, transformer: getScenarioTransformer(classification.kind) };
  }
}
