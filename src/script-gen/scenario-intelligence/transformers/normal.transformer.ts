import type { CredentialPair, CredentialResolver, ScenarioTransformer } from '../types';

/**
 * Normal — no input mutation. Honour an explicit empty/negative literal the
 * writer emitted, otherwise bind to the resolved data record (the positive
 * path). This transformer never dictates coverage or an error message: the
 * generator decides those from the Expected Result (a "normal"-input case can
 * still be negative, e.g. a valid-credential locked-account attempt).
 */
export class NormalTransformer implements ScenarioTransformer {
  readonly kind = 'normal' as const;
  readonly coverageCategories = [] as const;

  transformCredentials(_c: unknown, r: CredentialResolver): CredentialPair {
    if (r.authoredBothEmpty) {
      return { username: `''`, password: `''` };
    }
    if (r.authoredUsername) {
      return { username: r.authoredUsername, password: r.validCounterpart().password ?? r.envPassword() };
    }
    if (r.authoredPassword) {
      return { username: r.validCounterpart().username ?? r.envUsername(), password: r.authoredPassword };
    }
    return r.base();
  }

  errorFragment(): string | null {
    return null; // defer to the Expected Result text (locked out / do not match / …)
  }
}
