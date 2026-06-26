/**
 * Tests for the Execution Record mappers — translating the healing pipeline's
 * core outputs (EvidenceBundle, FailureDiagnosis) and Playwright artifact paths
 * into the canonical record's sub-types.
 */
import {
  artifactDescriptor,
  artifactsFromPaths,
  mapEvidenceToObservations,
  mapDiagnosisToRecord,
  buildHealingDecision,
} from '../../src/core/execution/execution-record-mappers';
import type { EvidenceBundle } from '../../src/core/evidence-collector';
import type { FailureDiagnosis } from '../../src/core/failure-classifier';

describe('execution-record-mappers', () => {
  describe('artifactDescriptor', () => {
    it('produces a storage-agnostic descriptor with an id + default local storage', () => {
      const d = artifactDescriptor('trace', '/tmp/trace.zip');
      expect(d.id).toMatch(/^art_/);
      expect(d.type).toBe('trace');
      expect(d.storage).toBe('local');
      expect(d.path).toBe('/tmp/trace.zip');
      expect(d.createdAt).toBeDefined();
    });

    it('honours an explicit storage backend (cloud-ready)', () => {
      const d = artifactDescriptor('video', 'bucket/key.webm', { storage: 's3', size: 1234 });
      expect(d.storage).toBe('s3');
      expect(d.size).toBe(1234);
    });
  });

  describe('artifactsFromPaths', () => {
    it('maps only present paths into descriptors', () => {
      const a = artifactsFromPaths({
        screenshotPath: '/tmp/shot.png',
        tracePath: null,
        videoPath: '/tmp/v.webm',
      });
      expect(a.screenshot?.type).toBe('screenshot');
      expect(a.trace).toBeUndefined();
      expect(a.video?.type).toBe('video');
    });

    it('returns an empty object when no paths are present', () => {
      expect(artifactsFromPaths({})).toEqual({});
    });
  });

  describe('mapEvidenceToObservations', () => {
    it('maps locator state, console + network errors and summary', () => {
      const evidence: EvidenceBundle = {
        locatorState: {
          exists: true,
          visible: true,
          enabled: true,
          receivesPointerEvents: false,
          clickable: false,
          interceptedBy: '.overlay',
          source: 'dom_snapshot',
          notes: ['covered by overlay'],
        },
        consoleErrors: ['boom'],
        networkErrors: [{ url: 'https://x/y', status: 500, detail: 'server error' }],
        artifacts: { screenshotPath: null, tracePath: null, videoPath: null, domSnapshotPresent: true },
        summary: ['element covered by overlay'],
      };
      const obs = mapEvidenceToObservations(evidence);
      expect(obs.locatorState?.interceptedBy).toBe('.overlay');
      expect(obs.locatorState?.source).toBe('dom_snapshot');
      expect(obs.consoleErrors).toEqual(['boom']);
      expect(obs.networkErrors?.[0]).toEqual({ url: 'https://x/y', status: 500, detail: 'server error' });
      expect(obs.summary).toEqual(['element covered by overlay']);
    });

    it('tolerates a null locator state', () => {
      const evidence: EvidenceBundle = {
        locatorState: null,
        consoleErrors: [],
        networkErrors: [],
        artifacts: { screenshotPath: null, tracePath: null, videoPath: null, domSnapshotPresent: false },
        summary: [],
      };
      expect(mapEvidenceToObservations(evidence).locatorState).toBeNull();
    });
  });

  describe('mapDiagnosisToRecord', () => {
    it('projects the classifier verdict onto the record diagnosis section', () => {
      const diag = {
        category: 'broken_locator',
        confidence: 0.9,
        locator: '#login',
        locatorResolvedFromPageObject: true,
        file: 'a.spec.ts',
        line: 12,
        action: 'click',
        waitingFor: null,
        expected: null,
        actual: null,
        rootCause: 'selector changed',
        recommendedAction: 'swap locator',
        recommendedStrategy: 'locator_swap',
        evidenceBased: true,
        healableByLocatorSwap: true,
        evidence: [],
      } as unknown as FailureDiagnosis;
      const rec = mapDiagnosisToRecord(diag);
      expect(rec.category).toBe('broken_locator');
      expect(rec.recommendedStrategy).toBe('locator_swap');
      expect(rec.healableByLocatorSwap).toBe(true);
      expect(rec.evidenceBased).toBe(true);
      expect(rec.locator).toBe('#login');
    });
  });

  describe('buildHealingDecision', () => {
    it('captures applied strategy, broken/new locators and report-only flag', () => {
      const h = buildHealingDecision({
        remedy: 'locator_swap',
        attemptedStrategies: ['rule_based', 'ai'],
        appliedStrategy: 'ai',
        source: 'ai',
        brokenLocator: '#old',
        newLocator: '#new',
        candidatesConsidered: 3,
        reportOnly: false,
        rationale: 'healed via AI',
      });
      expect(h.appliedStrategy).toBe('ai');
      expect(h.attemptedStrategies).toEqual(['rule_based', 'ai']);
      expect(h.brokenLocator).toBe('#old');
      expect(h.newLocator).toBe('#new');
      expect(h.candidatesConsidered).toBe(3);
    });

    it('defaults applied/new to null when nothing was applied', () => {
      const h = buildHealingDecision({ reportOnly: true, rationale: 'not healable' });
      expect(h.appliedStrategy).toBeNull();
      expect(h.newLocator).toBeNull();
      expect(h.reportOnly).toBe(true);
    });
  });
});
