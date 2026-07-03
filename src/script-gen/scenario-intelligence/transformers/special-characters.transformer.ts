import type {
  CredentialPair,
  CredentialResolver,
  ScenarioClassification,
  ScenarioTransformer,
} from '../types';
import { prependSpecialChar } from '../expressions';

/**
 * Special Characters — use the explicit special-character value authored in the
 * step when present (e.g. '@locked_user'); otherwise prepend a special char to
 * the real username. Password stays valid so only the special-char input varies.
 */
export class SpecialCharactersTransformer implements ScenarioTransformer {
  readonly kind = 'special' as const;
  readonly coverageCategories = ['Negative', 'Boundary'] as const;

  transformCredentials(c: ScenarioClassification, r: CredentialResolver): CredentialPair {
    const base = r.base();
    const username = c.literal ? `'${r.escape(c.literal)}'` : prependSpecialChar(base.username);
    return { username, password: base.password };
  }

  errorFragment(): string | null {
    return ''; // ambiguous mutation — assert the error surface only
  }
}
