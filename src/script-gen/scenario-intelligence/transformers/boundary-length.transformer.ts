import type {
  CredentialPair,
  CredentialResolver,
  ScenarioClassification,
  ScenarioTransformer,
} from '../types';

/**
 * Boundary (Max Length) — drive a maximum-length username (default 256 chars via
 * `'A'.repeat(n)`) with a valid password, exercising the field's length limit.
 * The expected message is app-specific, so no text is guessed.
 */
export class BoundaryLengthTransformer implements ScenarioTransformer {
  readonly kind = 'maxlength' as const;
  readonly coverageCategories = ['Negative', 'Boundary'] as const;

  transformCredentials(c: ScenarioClassification, r: CredentialResolver): CredentialPair {
    const base = r.base();
    return { username: `'A'.repeat(${c.length ?? 256})`, password: base.password };
  }

  errorFragment(): string | null {
    return ''; // ambiguous mutation — assert the error surface only
  }
}
