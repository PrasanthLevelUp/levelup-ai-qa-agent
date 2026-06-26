import { playwrightArtifactFlags } from '../../src/core/execution-engine';

/**
 * Regression: Playwright Test exposes ONLY `--trace` as an artifact CLI flag.
 * `--screenshot` / `--video` are `use:` config options, NOT CLI options — passing
 * them makes the CLI exit with "unknown option" BEFORE any test runs, so every
 * healing rerun fails with no results JSON and the heal is silently reverted
 * ("Report only"). These tests lock in that we never emit those invalid flags.
 */
describe('playwrightArtifactFlags — only valid Playwright CLI flags', () => {
  const profiles: Array<'fast' | 'standard' | 'healing' | 'debug'> = [
    'fast',
    'standard',
    'healing',
    'debug',
  ];

  it.each(profiles)('profile %s never emits --screenshot or --video', (profile) => {
    for (const collect of [true, false]) {
      for (const healing of [true, false]) {
        const flags = playwrightArtifactFlags(profile as any, collect, healing);
        expect(flags).not.toMatch(/--screenshot/);
        expect(flags).not.toMatch(/--video/);
        // Every token must be a --trace flag (the only valid artifact CLI flag).
        for (const tok of flags.split(/\s+/).filter(Boolean)) {
          expect(tok).toMatch(/^--trace=(on|off|on-first-retry|retain-on-failure)$/);
        }
      }
    }
  });

  it('upgrades a non-fast healing run to capture a trace', () => {
    // standard + collectHealingArtifacts + isHealingRun → effective "healing".
    expect(playwrightArtifactFlags('standard', true, true)).toBe('--trace=on-first-retry');
  });

  it('keeps fast lean even during a healing run', () => {
    expect(playwrightArtifactFlags('fast', true, true)).toBe('--trace=off');
  });
});
