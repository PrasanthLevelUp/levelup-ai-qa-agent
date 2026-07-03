import type {
  CredentialPair,
  ScenarioCaseInput,
  ScenarioClassification,
  ScenarioTransformer,
} from '../types';
import { buildHaystack } from '../detection';

/**
 * Empty Fields — the field-emptiness IS the scenario: submit the form with both
 * credentials blank. Expects the app's "field is required" validation message.
 */
export class EmptyFieldsTransformer implements ScenarioTransformer {
  readonly kind = 'empty' as const;
  readonly coverageCategories = ['Negative', 'Validation'] as const;

  matches(input: ScenarioCaseInput | undefined, steps: string[]): ScenarioClassification | null {
    const hay = buildHaystack(input, steps);
    return /\bempty\b|\bblank\b|leave.*(empty|blank)|without\s+(a\s+)?(username|password|credential)/.test(hay)
      ? { kind: this.kind }
      : null;
  }

  transformCredentials(): CredentialPair {
    return { username: `''`, password: `''` };
  }

  errorFragment(): string | null {
    return 'is required';
  }
}
