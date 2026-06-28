/**
 * Healing Advisor pipeline tests
 * ==============================
 * Verify the plugin architecture:
 *  - the default registry partitions advisors into grounded vs. fallback (AI),
 *  - collectRankedCandidates() collects from ANY injected advisor (extensible),
 *  - the AI (fallback) advisor is consulted ONLY when grounded candidates are
 *    thin — i.e. OpenAI is not called on every heal.
 */
import { HealingOrchestrator } from '../../src/core/healing-orchestrator';
import { RuleEngine } from '../../src/engines/rule-engine';
import { PatternEngine } from '../../src/engines/pattern-engine';
import { AIEngine } from '../../src/engines/ai-engine';
import { buildDefaultAdvisors } from '../../src/core/advisors';
import type {
  HealingAdvisor,
  AdvisorContext,
  AdvisorProposal,
  AdvisorCandidate,
} from '../../src/core/advisors';
import type { FailureDetails } from '../../src/core/failure-analyzer';

function makeFailure(overrides: Partial<FailureDetails> = {}): FailureDetails {
  return {
    testName: 'login works',
    failureType: 'locator',
    failedLocator: "page.getByRole('button', { name: 'Sign In' })",
    errorMessage: 'locator not found',
    errorPattern: 'not found',
    filePath: 'tests/login.spec.ts',
    lineNumber: 12,
    failedLineCode: "await page.getByRole('button', { name: 'Sign In' }).click();",
    surroundingCode: '',
    screenshotPath: null,
    url: null,
    timestamp: new Date().toISOString(),
    isTimingIssue: false,
    ...overrides,
  };
}

/** A trivial grounded advisor that emits a fixed candidate. */
function groundedAdvisor(
  name: string,
  candidate: Partial<AdvisorCandidate> & { newLocator: string },
): HealingAdvisor {
  return {
    name,
    source: 'rule',
    tier: 'grounded',
    async propose(): Promise<AdvisorProposal> {
      return {
        candidates: [
          {
            strategy: 'rule_based',
            source: 'rule',
            confidence: 0.95,
            tokensUsed: 0,
            reasoning: `[${name}]`,
            addExplicitWait: false,
            ...candidate,
          },
        ],
      };
    },
  };
}

function makeOrchestrator(advisors: HealingAdvisor[]): HealingOrchestrator {
  return new HealingOrchestrator(
    new RuleEngine(),
    new PatternEngine(),
    new AIEngine(),
    undefined,
    undefined,
    undefined,
    undefined,
    advisors,
  );
}

describe('buildDefaultAdvisors registry', () => {
  const advisors = buildDefaultAdvisors({
    patternEngine: new PatternEngine(),
    ruleEngine: new RuleEngine(),
    aiEngine: new AIEngine(),
    domExtractor: new (require('../../src/engines/dom-candidate-extractor').DOMCandidateExtractor)(),
    domMemory: new (require('../../src/services/dom-memory-query').DOMMemoryQuery)(),
  });

  it('registers all six default intelligence sources', () => {
    expect(advisors).toHaveLength(6);
    expect(advisors.map((a) => a.name)).toEqual([
      'Learned Pattern',
      'App Profile',
      'DOM Memory',
      'DOM Candidate',
      'Rule Engine',
      'AI',
    ]);
  });

  it('marks ONLY the AI advisor as fallback (gated); the rest are grounded', () => {
    const fallback = advisors.filter((a) => a.tier === 'fallback');
    expect(fallback).toHaveLength(1);
    expect(fallback[0].name).toBe('AI');
    expect(advisors.filter((a) => a.tier === 'grounded')).toHaveLength(5);
  });
});

describe('collectRankedCandidates — advisor pipeline', () => {
  const prevMin = process.env.HEALING_RANK_MIN_GROUNDED;
  const prevConf = process.env.HEALING_RANK_AI_SKIP_CONFIDENCE;
  beforeEach(() => {
    process.env.HEALING_RANK_MIN_GROUNDED = '2';
    process.env.HEALING_RANK_AI_SKIP_CONFIDENCE = '0.8';
  });
  afterAll(() => {
    process.env.HEALING_RANK_MIN_GROUNDED = prevMin;
    process.env.HEALING_RANK_AI_SKIP_CONFIDENCE = prevConf;
  });

  it('collects candidates from any injected advisor and ranks them best-first', async () => {
    const orch = makeOrchestrator([
      groundedAdvisor('Adv A', {
        newLocator: "page.getByLabel('Username')",
        confidence: 0.75,
      }),
      groundedAdvisor('Adv B', {
        newLocator: "page.getByText('Sign In')",
        confidence: 0.95,
      }),
    ]);
    const result = await orch.collectRankedCandidates(makeFailure());
    expect(result.candidates.length).toBeGreaterThanOrEqual(2);
    // Higher-confidence candidate should rank ahead of the lower one.
    expect(result.candidates[0].confidence).toBeGreaterThanOrEqual(
      result.candidates[result.candidates.length - 1].confidence,
    );
  });

  it('is fully extensible: a brand-new advisor contributes with no orchestrator change', async () => {
    const knowledgeGraph: HealingAdvisor = groundedAdvisor('Knowledge Graph', {
      newLocator: "page.getByLabel('Username')",
      confidence: 0.9,
    });
    const orch = makeOrchestrator([knowledgeGraph]);
    const result = await orch.collectRankedCandidates(makeFailure());
    expect(result.candidates.some((c) => c.newLocator.includes('Username'))).toBe(true);
  });

  it('does NOT consult the AI (fallback) advisor when grounded candidates are sufficient', async () => {
    const aiPropose = jest.fn(async (): Promise<AdvisorProposal> => ({ candidates: [] }));
    const aiAdvisor: HealingAdvisor = { name: 'AI', source: 'ai', tier: 'fallback', propose: aiPropose };
    const orch = makeOrchestrator([
      groundedAdvisor('Adv A', { newLocator: "page.getByRole('button', { name: 'Sign In' })", confidence: 0.95 }),
      groundedAdvisor('Adv B', { newLocator: "page.getByText('Sign In')", confidence: 0.92 }),
      aiAdvisor,
    ]);
    await orch.collectRankedCandidates(makeFailure());
    expect(aiPropose).not.toHaveBeenCalled();
  });

  it('DOES consult the AI (fallback) advisor when grounded candidates are thin', async () => {
    const aiPropose = jest.fn(
      async (_ctx: AdvisorContext): Promise<AdvisorProposal> => ({
        candidates: [
          {
            newLocator: "page.getByRole('button', { name: 'Login' })",
            strategy: 'ai_reasoning',
            source: 'ai',
            confidence: 0.88,
            tokensUsed: 120,
            reasoning: '[AI]',
            addExplicitWait: false,
          },
        ],
      }),
    );
    const aiAdvisor: HealingAdvisor = { name: 'AI', source: 'ai', tier: 'fallback', propose: aiPropose };
    const orch = makeOrchestrator([
      // Single low-confidence grounded candidate → groundedCount (>=0.8) is 0 < 2.
      groundedAdvisor('Adv A', { newLocator: "page.getByText('Sign In')", confidence: 0.3 }),
      aiAdvisor,
    ]);
    const result = await orch.collectRankedCandidates(makeFailure());
    expect(aiPropose).toHaveBeenCalledTimes(1);
    expect(result.candidates.some((c) => c.source === 'ai')).toBe(true);
  });

  it('does NOT consult the AI (fallback) advisor when there is no failed locator to anchor on', async () => {
    // A framework-level crash never reaches an element, so failedLocator is null.
    // The AI has nothing to ground on and would only fabricate an unrelated
    // candidate (the historic "login button" guess), so it must be skipped.
    const aiPropose = jest.fn(
      async (_ctx: AdvisorContext): Promise<AdvisorProposal> => ({
        candidates: [
          {
            newLocator: "page.getByRole('button', { name: 'Login' })",
            strategy: 'ai_reasoning',
            source: 'ai',
            confidence: 0.88,
            tokensUsed: 120,
            reasoning: '[AI fabricated]',
            addExplicitWait: false,
          },
        ],
      }),
    );
    const aiAdvisor: HealingAdvisor = { name: 'AI', source: 'ai', tier: 'fallback', propose: aiPropose };
    const orch = makeOrchestrator([
      // Thin grounded candidates (groundedCount < 2) — normally the AI gate opens.
      groundedAdvisor('Adv A', { newLocator: "page.getByText('Sign In')", confidence: 0.3 }),
      aiAdvisor,
    ]);
    const result = await orch.collectRankedCandidates(
      makeFailure({ failedLocator: '', failureType: 'unknown', errorPattern: 'target closed' }),
    );
    expect(aiPropose).not.toHaveBeenCalled();
    expect(result.candidates.some((c) => c.source === 'ai')).toBe(false);
    // The decision trail must honestly record why the AI was skipped.
    expect(
      result.decisionTrail.some(
        (e) => e.layer === 'AI Reasoning' && e.outcome === 'skipped' && /no failed locator/i.test(e.reasoning ?? ''),
      ),
    ).toBe(true);
  });
});
