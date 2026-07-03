import type {
  CredentialPair,
  CredentialResolver,
  ScenarioCaseInput,
  ScenarioClassification,
  ScenarioTransformer,
} from '../types';
import { buildHaystack } from '../detection';
import { wrapWhitespace } from '../expressions';

/**
 * Whitespace — wrap the REAL username value with leading/trailing spaces while
 * keeping the password valid, so the test exercises the app's trimming/validation
 * behaviour. The expected message is app-specific, so no text is guessed.
 */
export class WhitespaceTransformer implements ScenarioTransformer {
  readonly kind = 'whitespace' as const;
  readonly priority = 2;
  readonly coverageCategories = ['Negative', 'Boundary'] as const;

  matches(input: ScenarioCaseInput | undefined, steps: string[]): ScenarioClassification | null {
    const hay = buildHaystack(input, steps);
    return /leading|trailing|whitespace|\bspaces?\b/.test(hay) ? { kind: this.kind } : null;
  }

  transformCredentials(_c: unknown, r: CredentialResolver): CredentialPair {
    const base = r.base();
    return { username: wrapWhitespace(base.username), password: base.password };
  }

  errorFragment(): string | null {
    return ''; // ambiguous mutation — assert the error surface only
  }
}
