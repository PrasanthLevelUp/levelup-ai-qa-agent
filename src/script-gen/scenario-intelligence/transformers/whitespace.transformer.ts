import type { CredentialPair, CredentialResolver, ScenarioTransformer } from '../types';
import { wrapWhitespace } from '../expressions';

/**
 * Whitespace — wrap the REAL username value with leading/trailing spaces while
 * keeping the password valid, so the test exercises the app's trimming/validation
 * behaviour. The expected message is app-specific, so no text is guessed.
 */
export class WhitespaceTransformer implements ScenarioTransformer {
  readonly kind = 'whitespace' as const;
  readonly coverageCategories = ['Negative', 'Boundary'] as const;

  transformCredentials(_c: unknown, r: CredentialResolver): CredentialPair {
    const base = r.base();
    return { username: wrapWhitespace(base.username), password: base.password };
  }

  errorFragment(): string | null {
    return ''; // ambiguous mutation — assert the error surface only
  }
}
