import type { CredentialPair, ScenarioTransformer } from '../types';

/**
 * Empty Fields — the field-emptiness IS the scenario: submit the form with both
 * credentials blank. Expects the app's "field is required" validation message.
 */
export class EmptyFieldsTransformer implements ScenarioTransformer {
  readonly kind = 'empty' as const;
  readonly coverageCategories = ['Negative', 'Validation'] as const;

  transformCredentials(): CredentialPair {
    return { username: `''`, password: `''` };
  }

  errorFragment(): string | null {
    return 'is required';
  }
}
