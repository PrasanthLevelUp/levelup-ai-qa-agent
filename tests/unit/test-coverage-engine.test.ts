/**
 * Unit tests for AI Test Coverage Intelligence Engine (Test Case Lab)
 * 
 * Coverage areas:
 * - Coverage type goals verification
 * - Coverage type evaluation reconciliation
 * - Application profile context building
 * - Test data context building
 * - Enterprise knowledge integration
 * - Repository intelligence integration
 * - Source tagging and provenance
 * 
 * Run with: npx tsx tests/unit/test-coverage-engine.test.ts
 */

import {
  TestCoverageEngine,
  type RequirementInput,
  type CoverageType,
  type TestScenario,
  type TestCase,
  type KnowledgeContext,
  type CoverageTypeEvaluation,
  COVERAGE_TYPE_GOALS,
} from '../../src/engines/test-coverage-engine';

// Simple test framework
let testCount = 0;
let passedCount = 0;
let failedCount = 0;

function describe(name: string, fn: () => void) {
  console.log(`\n${name}`);
  fn();
}

function it(name: string, fn: () => void) {
  testCount++;
  try {
    fn();
    passedCount++;
    console.log(`  ✓ ${name}`);
  } catch (err: any) {
    failedCount++;
    console.log(`  ✗ ${name}`);
    console.log(`    Error: ${err.message}`);
  }
}

function expect(value: any) {
  return {
    toBe(expected: any) {
      if (value !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(value)}`);
      }
    },
    toEqual(expected: any) {
      if (JSON.stringify(value) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)} but got ${JSON.stringify(value)}`);
      }
    },
    toBeDefined() {
      if (value === undefined) {
        throw new Error('Expected value to be defined');
      }
    },
    toBeTruthy() {
      if (!value) {
        throw new Error(`Expected truthy value but got ${JSON.stringify(value)}`);
      }
    },
    toContain(substring: string) {
      if (!String(value).includes(substring)) {
        throw new Error(`Expected string to contain "${substring}"`);
      }
    },
    toBeGreaterThan(expected: number) {
      if (value <= expected) {
        throw new Error(`Expected ${value} to be greater than ${expected}`);
      }
    },
    toHaveLength(expected: number) {
      if (value.length !== expected) {
        throw new Error(`Expected length ${expected} but got ${value.length}`);
      }
    },
    not: {
      toBe(expected: any) {
        if (value === expected) {
          throw new Error(`Expected not ${JSON.stringify(expected)} but got ${JSON.stringify(value)}`);
        }
      },
      toContain(substring: string) {
        if (String(value).includes(substring)) {
          throw new Error(`Expected string not to contain "${substring}"`);
        }
      },
    },
  };
}

// Set up test environment
process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';

// ============================================================================
// Test Suites
// ============================================================================

describe('TestCoverageEngine - Coverage Type Goals', () => {
  it('should have semantic goals defined for all 16 coverage types', () => {
    const expectedTypes: CoverageType[] = [
      'positive', 'negative', 'edge_cases', 'boundary',
      'security', 'api', 'ui', 'mobile', 'accessibility',
      'performance', 'integration', 'regression',
      'cross_browser', 'data_validation', 'role_based', 'localization',
    ];

    expectedTypes.forEach(type => {
      expect(COVERAGE_TYPE_GOALS[type]).toBeDefined();
      expect(COVERAGE_TYPE_GOALS[type].label).toBeTruthy();
      expect(COVERAGE_TYPE_GOALS[type].goal).toBeTruthy();
      expect(COVERAGE_TYPE_GOALS[type].lookFor).toBeTruthy();
    });
  });

  it('should have distinct goals for each coverage type', () => {
    const goals = Object.values(COVERAGE_TYPE_GOALS).map(g => g.goal);
    const uniqueGoals = new Set(goals);
    expect(uniqueGoals.size).toBe(goals.length);
  });
});

describe('TestCoverageEngine - Coverage Type Evaluation Reconciliation', () => {
  const engine = new TestCoverageEngine();

  it('should reconcile coverage type evaluations with actual output', () => {
    const selectedTypes: CoverageType[] = ['positive', 'negative', 'edge_cases'];
    
    const scenarios: TestScenario[] = [
      { scenario: 'Valid login', coverageType: 'positive', priority: 'P0', riskArea: 'auth' },
      { scenario: 'Invalid login', coverageType: 'negative', priority: 'P1', riskArea: 'auth' },
    ];

    const testCases: TestCase[] = [
      {
        title: 'Login with valid credentials',
        scenarioIndex: 0,
        preconditions: 'User not logged in',
        steps: ['Navigate to login', 'Enter valid credentials', 'Click login'],
        expectedResult: 'User logged in successfully',
        testData: 'valid_user@test.com',
        priority: 'P0',
        severity: 'critical',
        tags: ['positive', 'auth'],
        automationReady: true,
        automationComplexity: 'low',
        selectorAvailability: 'high',
        source: 'requirement',
        sourceEvidence: 'AC: standard user logs in',
      } as any,
      {
        title: 'Login with invalid password',
        scenarioIndex: 1,
        preconditions: 'User not logged in',
        steps: ['Navigate to login', 'Enter invalid password', 'Click login'],
        expectedResult: 'Error message displayed',
        testData: 'invalid_password',
        priority: 'P1',
        severity: 'major',
        tags: ['negative', 'auth'],
        automationReady: true,
        automationComplexity: 'low',
        selectorAvailability: 'high',
        source: 'requirement',
        sourceEvidence: 'AC: reject invalid credentials',
      } as any,
    ];

    // Use the private method via type assertion to test reconciliation logic
    const evaluations = (engine as any).buildCoverageTypeEvaluations(
      selectedTypes,
      scenarios,
      testCases,
      []
    );

    expect(evaluations).toHaveLength(3);
    
    // Positive coverage - has 1 scenario and 1 test case
    const positiveEval = evaluations.find((e: CoverageTypeEvaluation) => e.coverageType === 'positive');
    expect(positiveEval).toBeDefined();
    expect(positiveEval!.status).toBe('covered');
    expect(positiveEval!.scenarioCount).toBe(1);
    expect(positiveEval!.testCaseCount).toBe(1);

    // Negative coverage - has 1 scenario and 1 test case
    const negativeEval = evaluations.find((e: CoverageTypeEvaluation) => e.coverageType === 'negative');
    expect(negativeEval).toBeDefined();
    expect(negativeEval!.status).toBe('covered');
    expect(negativeEval!.scenarioCount).toBe(1);
    expect(negativeEval!.testCaseCount).toBe(1);

    // Edge cases - no scenarios or test cases
    const edgeCasesEval = evaluations.find((e: CoverageTypeEvaluation) => e.coverageType === 'edge_cases');
    expect(edgeCasesEval).toBeDefined();
    expect(edgeCasesEval!.status).toBe('not_applicable');
    expect(edgeCasesEval!.scenarioCount).toBe(0);
    expect(edgeCasesEval!.testCaseCount).toBe(0);
    expect(edgeCasesEval!.reason).toBeDefined();
  });

  it('should use model-provided reason when available', () => {
    const selectedTypes: CoverageType[] = ['localization'];
    const scenarios: TestScenario[] = [];
    const testCases: TestCase[] = [];
    
    const modelEvaluations: CoverageTypeEvaluation[] = [
      {
        coverageType: 'localization',
        status: 'not_applicable',
        scenarioCount: 0,
        testCaseCount: 0,
        reason: 'Requirement does not involve localized content or multi-language support',
      },
    ];

    const evaluations = (engine as any).buildCoverageTypeEvaluations(
      selectedTypes,
      scenarios,
      testCases,
      modelEvaluations
    );

    expect(evaluations).toHaveLength(1);
    expect(evaluations[0].status).toBe('not_applicable');
    expect(evaluations[0].reason).toBe('Requirement does not involve localized content or multi-language support');
  });

  it('should handle scenarioIndex linking correctly', () => {
    const selectedTypes: CoverageType[] = ['positive'];
    
    const scenarios: TestScenario[] = [
      { scenario: 'Scenario A', coverageType: 'positive', priority: 'P0', riskArea: 'feature' },
      { scenario: 'Scenario B', coverageType: 'positive', priority: 'P1', riskArea: 'feature' },
    ];

    const testCases: TestCase[] = [
      { title: 'Test 1', scenarioIndex: 0, steps: [], expectedResult: '', testData: '', priority: 'P0', severity: 'critical', tags: [], automationReady: true, automationComplexity: 'low', selectorAvailability: 'high', preconditions: '' } as any,
      { title: 'Test 2', scenarioIndex: 0, steps: [], expectedResult: '', testData: '', priority: 'P0', severity: 'critical', tags: [], automationReady: true, automationComplexity: 'low', selectorAvailability: 'high', preconditions: '' } as any,
      { title: 'Test 3', scenarioIndex: 1, steps: [], expectedResult: '', testData: '', priority: 'P1', severity: 'major', tags: [], automationReady: true, automationComplexity: 'low', selectorAvailability: 'high', preconditions: '' } as any,
    ];

    const evaluations = (engine as any).buildCoverageTypeEvaluations(
      selectedTypes,
      scenarios,
      testCases,
      []
    );

    expect(evaluations[0].status).toBe('covered');
    expect(evaluations[0].scenarioCount).toBe(2);
    expect(evaluations[0].testCaseCount).toBe(3);
  });
});

describe('TestCoverageEngine - Application Profile Context Building', () => {
  const engine = new TestCoverageEngine();

  it('should build empty block when no application profile provided', () => {
    const block = (engine as any).buildApplicationProfileBlock({});
    expect(block).toBe('');
  });

  it('should build comprehensive profile block when profile available', () => {
    const knowledge: KnowledgeContext = {
      applicationProfile: {
        baseUrl: 'https://www.saucedemo.com',
        name: 'SauceDemo',
        pageCount: 3,
        totalElements: 150,
        totalForms: 2,
        loginUrl: 'https://www.saucedemo.com',
        username: 'standard_user',
        pages: [
          { url: '/login', title: 'Login Page', pageType: 'auth', elementCount: 20, formCount: 1 },
          { url: '/inventory', title: 'Inventory', pageType: 'catalog', elementCount: 80, formCount: 0 },
        ],
        forms: [
          {
            page: '/login',
            action: '/login',
            method: 'POST',
            fields: [
              { name: 'username', type: 'text', required: true, selector: '#user-name', label: 'Username' },
              { name: 'password', type: 'password', required: true, selector: '#password', label: 'Password' },
            ],
            submitSelector: '#login-button',
          },
        ],
        keyElements: [
          { label: 'Add to cart', tag: 'button', selector: '.btn_inventory', role: 'button' },
          { label: 'Shopping cart', tag: 'a', selector: '.shopping_cart_link', role: 'link' },
        ],
      },
    };

    const block = (engine as any).buildApplicationProfileBlock(knowledge);

    expect(block).toContain('APPLICATION PROFILE');
    expect(block).toContain('SauceDemo');
    expect(block).toContain('https://www.saucedemo.com');
    expect(block).toContain('standard_user');
    expect(block).toContain('Login Page');
    expect(block).toContain('#user-name');
    expect(block).toContain('#password');
    expect(block).toContain('REAL selectors');
  });
});

describe('TestCoverageEngine - Test Data Context Building', () => {
  const engine = new TestCoverageEngine();

  it('should build empty block when no test data provided', () => {
    const block = (engine as any).buildTestDataBlock({});
    expect(block).toBe('');
  });

  it('should build test data block with dataset summaries', () => {
    const knowledge: KnowledgeContext = {
      testData: [
        {
          name: 'valid_users',
          environment: 'staging',
          recordCount: 5,
          sampleKeys: ['standard_user', 'locked_out_user', 'problem_user'],
        },
        {
          name: 'products',
          environment: 'staging',
          recordCount: 6,
          sampleKeys: ['backpack', 'bike_light', 'bolt_tshirt'],
        },
      ],
    };

    const block = (engine as any).buildTestDataBlock(knowledge);

    expect(block).toContain('AVAILABLE TEST DATA');
    expect(block).toContain('valid_users');
    expect(block).toContain('staging');
    expect(block).toContain('5 records');
    expect(block).toContain('standard_user');
    expect(block).toContain('products');
    expect(block).toContain('6 records');
    expect(block).toContain('backpack');
  });

  it('should limit dataset list to 12 items', () => {
    const knowledge: KnowledgeContext = {
      testData: Array.from({ length: 20 }, (_, i) => ({
        name: `dataset_${i}`,
        environment: 'test',
        recordCount: 10,
        sampleKeys: ['key1', 'key2'],
      })),
    };

    const block = (engine as any).buildTestDataBlock(knowledge);

    // Should only include first 12 datasets
    expect(block).toContain('dataset_0');
    expect(block).toContain('dataset_11');
    expect(block).not.toContain('dataset_12');
  });
});

describe('TestCoverageEngine - Repository Intelligence Context Building', () => {
  const engine = new TestCoverageEngine();

  it('should build empty block when no repository context provided', () => {
    const block = (engine as any).buildRepoIntelligenceBlock({});
    expect(block).toBe('');
  });

  it('should build comprehensive repo intelligence block', () => {
    const knowledge: KnowledgeContext = {
      repositoryContext: {
        repoId: 'repo-123',
        techStack: ['TypeScript', 'Playwright', 'React'],
        testingFrameworks: ['Playwright', 'Vitest'],
        patterns: ['Page Object Model', 'Fixtures'],
        summary: 'E-commerce application with authentication and checkout flows',
        architecture: { frontend: 'React', backend: 'Node.js' },
      },
    };

    const block = (engine as any).buildRepoIntelligenceBlock(knowledge);

    expect(block).toContain('REPOSITORY INTELLIGENCE');
    expect(block).toContain('E-commerce application');
    expect(block).toContain('TypeScript');
    expect(block).toContain('Playwright');
    expect(block).toContain('Page Object Model');
  });
});

describe('TestCoverageEngine - Source Tagging and Provenance', () => {
  it('should support all valid source types', () => {
    const validSources = ['requirement', 'knowledge', 'test_data', 'app_profile', 'gap_analysis', 'assumption'];
    
    validSources.forEach(source => {
      const testCase: TestCase = {
        title: 'Test',
        preconditions: '',
        steps: [],
        expectedResult: '',
        testData: '',
        priority: 'P0',
        severity: 'critical',
        tags: [],
        automationReady: true,
        automationComplexity: 'low',
        selectorAvailability: 'high',
        source: source as any,
        sourceEvidence: 'Evidence',
      };

      expect(testCase.source).toBe(source);
    });
  });

  it('should include sourceEvidence for traceability', () => {
    const testCase: TestCase = {
      title: 'Login with valid credentials',
      preconditions: '',
      steps: [],
      expectedResult: '',
      testData: '',
      priority: 'P0',
      severity: 'critical',
      tags: [],
      automationReady: true,
      automationComplexity: 'low',
      selectorAvailability: 'high',
      source: 'requirement',
      sourceEvidence: 'AC: standard user logs in successfully',
    };

    expect(testCase.source).toBe('requirement');
    expect(testCase.sourceEvidence).toContain('AC:');
  });
});

describe('TestCoverageEngine - Enterprise Output Schema (objective + riskArea)', () => {
  const engine = new TestCoverageEngine();

  it('should accept scenario-level objective and reconcile coverage with it present', () => {
    const selectedTypes: CoverageType[] = ['positive', 'negative'];

    // Scenarios now carry the senior-QA "objective" (what the scenario proves).
    const scenarios: TestScenario[] = [
      { scenario: 'Valid login', objective: 'Prove a valid user reaches the dashboard', coverageType: 'positive', priority: 'P0', riskArea: 'Authentication' },
      { scenario: 'Locked account login', objective: 'Prove a locked account is rejected with the locked message', coverageType: 'negative', priority: 'P1', riskArea: 'Unauthorized access' },
    ];

    const testCases: TestCase[] = [
      {
        title: 'Valid credentials reach dashboard',
        objective: 'Verify a standard user logging in with valid credentials lands on the dashboard',
        scenarioIndex: 0,
        riskArea: 'Authentication',
        preconditions: 'Standard user exists',
        steps: ['Open login', 'Enter valid creds', 'Submit'],
        expectedResult: 'Dashboard shown',
        testData: 'standard_user',
        priority: 'P0', severity: 'critical', tags: ['positive'],
        automationReady: true, automationComplexity: 'low', selectorAvailability: 'high',
        source: 'requirement', sourceEvidence: 'AC: valid login',
      } as any,
      {
        title: 'Locked account shows locked message',
        objective: 'Verify a locked account with correct password is rejected with the locked message',
        scenarioIndex: 1,
        riskArea: 'Unauthorized access',
        preconditions: 'Locked account exists',
        steps: ['Open login', 'Enter locked-user creds', 'Submit'],
        expectedResult: 'Account-locked message shown',
        testData: 'locked_user',
        priority: 'P1', severity: 'major', tags: ['negative'],
        automationReady: true, automationComplexity: 'low', selectorAvailability: 'high',
        source: 'knowledge', sourceEvidence: 'Auth rule: lockout',
      } as any,
    ];

    // The enterprise fields are optional metadata — they must not break the
    // per-type reconciliation that proves every selected type is accounted for.
    const evaluations = (engine as any).buildCoverageTypeEvaluations(
      selectedTypes, scenarios, testCases, []
    );

    expect(evaluations).toHaveLength(2);
    const positive = evaluations.find((e: CoverageTypeEvaluation) => e.coverageType === 'positive');
    const negative = evaluations.find((e: CoverageTypeEvaluation) => e.coverageType === 'negative');
    expect(positive!.status).toBe('covered');
    expect(negative!.status).toBe('covered');
    // Objective is carried on the scenario without disturbing the linkage.
    expect(scenarios[0].objective).toContain('dashboard');
    expect(testCases[1].riskArea).toBe('Unauthorized access');
  });

  it('should treat objective and riskArea as optional (back-compat)', () => {
    // A case omitting the new enterprise fields is still a valid TestCase.
    const legacy: TestCase = {
      title: 'Legacy case without enterprise fields',
      preconditions: '', steps: [], expectedResult: '', testData: '',
      priority: 'P2', severity: 'minor', tags: [],
      automationReady: false, automationComplexity: 'medium', selectorAvailability: 'unknown',
    };
    expect(legacy.objective).toBe(undefined);
    expect(legacy.riskArea).toBe(undefined);
    expect(legacy.title).toContain('Legacy');
  });
});

// ============================================================================
// Phase 2 — Intelligence Orchestrator integration (Test Case Lab)
// ============================================================================

// Async test collector — the orchestrated block builder is async and the flag
// is read at call time, so these run in the async runner below.
const asyncTests: Array<{ name: string; fn: () => Promise<void> }> = [];
function itAsync(name: string, fn: () => Promise<void>) {
  asyncTests.push({ name, fn });
}

describe('TestCoverageEngine - deriveIntent (Phase 2)', () => {
  const engine = new TestCoverageEngine();

  it('should derive intent from title + business flow', () => {
    const intent = (engine as any).deriveIntent({
      title: 'User Login',
      businessFlow: 'authenticate with email and password',
    });
    expect(intent).toContain('User Login');
    expect(intent).toContain('authenticate');
  });

  it('should fall back to acceptance criteria then description', () => {
    const fromAc = (engine as any).deriveIntent({ title: '', acceptanceCriteria: 'reset password via email' });
    expect(fromAc).toContain('reset password');
    const fromDesc = (engine as any).deriveIntent({ title: '', description: 'checkout with saved card' });
    expect(fromDesc).toContain('checkout');
  });

  it('should cap the intent to at most 12 words', () => {
    const long = Array.from({ length: 30 }, (_, i) => `w${i}`).join(' ');
    const intent = (engine as any).deriveIntent({ title: long });
    expect(intent.split(/\s+/).length).toBe(12);
  });

  it('should return empty string when no signals present', () => {
    const intent = (engine as any).deriveIntent({ title: '' });
    expect(intent).toBe('');
  });
});

describe('TestCoverageEngine - Orchestrated block gating (Phase 2)', () => {
  const engine = new TestCoverageEngine();

  // With the flag OFF (default in the unit-test env) the orchestrated block must
  // be empty and carry NO Intelligence Score, so the legacy flat-block path is
  // byte-for-byte preserved. This is the core "additive / flag-gated" guarantee.
  itAsync('returns an empty block and no score when the flag is disabled', async () => {
    delete process.env.ENABLE_INTELLIGENCE_ORCHESTRATOR;
    const result = await (engine as any).buildOrchestratedIntelligenceBlock(
      { title: 'User Login', businessFlow: 'authenticate' },
      { orchestratorScope: { companyId: 1, projectId: 2 } },
    );
    expect(result.block).toBe('');
    expect(result.intelligenceScore).toBe(undefined);
  });

  // Even with the flag ON, a missing scope (no companyId) must short-circuit to
  // an empty block — the engine never calls the orchestrator without a scope.
  itAsync('returns an empty block when no orchestrator scope is provided', async () => {
    process.env.ENABLE_INTELLIGENCE_ORCHESTRATOR = 'true';
    const result = await (engine as any).buildOrchestratedIntelligenceBlock(
      { title: 'User Login', businessFlow: 'authenticate' },
      {},
    );
    expect(result.block).toBe('');
    expect(result.intelligenceScore).toBe(undefined);
    delete process.env.ENABLE_INTELLIGENCE_ORCHESTRATOR;
  });
});

// ============================================================================
// Test Runner
// ============================================================================

console.log('\n🧪 Test Coverage Engine Unit Tests\n');
console.log('='.repeat(60));

(async () => {
  // Run async (Phase 2) tests after the synchronous describe blocks above.
  for (const t of asyncTests) {
    testCount++;
    try {
      await t.fn();
      passedCount++;
      console.log(`  ✓ ${t.name}`);
    } catch (err: any) {
      failedCount++;
      console.log(`  ✗ ${t.name}`);
      console.log(`    Error: ${err.message}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`\nResults: ${passedCount}/${testCount} tests passed`);

  if (failedCount > 0) {
    console.log(`\n❌ ${failedCount} test(s) failed\n`);
    process.exit(1);
  } else {
    console.log(`\n✅ All tests passed!\n`);
    process.exit(0);
  }
})();
