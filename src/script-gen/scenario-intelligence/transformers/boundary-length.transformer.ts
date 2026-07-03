import type {
  CredentialPair,
  CredentialResolver,
  ScenarioCaseInput,
  ScenarioClassification,
  ScenarioTransformer,
} from '../types';
import { buildHaystack } from '../detection';

/**
 * Boundary (Max Length) — drive a maximum-length username (default 256 chars via
 * `'A'.repeat(n)`) with a valid password, exercising the field's length limit.
 * The expected message is app-specific, so no text is guessed.
 */
export class BoundaryLengthTransformer implements ScenarioTransformer {
  readonly kind = 'maxlength' as const;
  readonly priority = 4;
  readonly coverageCategories = ['Negative', 'Boundary'] as const;

  matches(input: ScenarioCaseInput | undefined, steps: string[]): ScenarioClassification | null {
    const hay = buildHaystack(input, steps);
    if (!/max(?:imum)?[\s-]*length|too\s+long|very\s+long|exceed\w*\s+length|\blong\b.*(user|name)/.test(hay)) {
      return null;
    }
    const num = hay.match(/\b(\d{2,4})\b/);
    const length = num ? Math.min(parseInt(num[1]!, 10), 4096) : 256;
    return { kind: this.kind, length };
  }

  transformCredentials(c: ScenarioClassification, r: CredentialResolver): CredentialPair {
    const base = r.base();
    return { username: `'A'.repeat(${c.length ?? 256})`, password: base.password };
  }

  errorFragment(): string | null {
    return ''; // ambiguous mutation — assert the error surface only
  }
}
