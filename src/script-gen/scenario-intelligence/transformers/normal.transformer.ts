import type {
  CredentialPair,
  CredentialResolver,
  ScenarioCaseInput,
  ScenarioClassification,
  ScenarioTransformer,
} from '../types';

/**
 * Normal — no input mutation. Honour an explicit empty/negative literal the
 * writer emitted, otherwise bind to the resolved data record (the positive
 * path). This transformer never dictates coverage or an error message: the
 * generator decides those from the Expected Result (a "normal"-input case can
 * still be negative, e.g. a valid-credential locked-account attempt).
 */
export class NormalTransformer implements ScenarioTransformer {
  readonly kind = 'normal' as const;
  readonly priority = 99; // lowest precedence — catch-all fallback
  readonly coverageCategories = [] as const;

  /**
   * The catch-all. Normal is the fallback scenario, so it matches unconditionally
   * — the registry only consults it after every more-specific transformer has
   * declined, so a case reaches here precisely when no mutation applies.
   */
  matches(_input: ScenarioCaseInput | undefined, _steps: string[]): ScenarioClassification | null {
    return { kind: this.kind };
  }

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
