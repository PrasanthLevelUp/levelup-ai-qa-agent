import type { CredentialPair, CredentialResolver, ScenarioTransformer } from '../types';

/**
 * Invalid Credentials — honour an explicit invalid literal the step-writer
 * emitted (pairing it with a valid counterpart for the OTHER field so only one
 * side is invalid); otherwise fall back to a clearly-invalid pair. Expects the
 * app's "username and password do not match" message.
 */
export class InvalidCredentialsTransformer implements ScenarioTransformer {
  readonly kind = 'invalid' as const;
  readonly coverageCategories = ['Negative'] as const;

  transformCredentials(_c: unknown, r: CredentialResolver): CredentialPair {
    if (r.authoredUsername) {
      return { username: r.authoredUsername, password: r.validCounterpart().password ?? r.envPassword() };
    }
    if (r.authoredPassword) {
      return { username: r.validCounterpart().username ?? r.envUsername(), password: r.authoredPassword };
    }
    return { username: `'invalid_user'`, password: `'wrong_password'` };
  }

  errorFragment(): string | null {
    return 'do not match';
  }
}
