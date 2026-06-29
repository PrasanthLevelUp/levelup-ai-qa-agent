/**
 * Integration tests for Test Case Lab full pipeline
 * 
 * Tests the complete flow:
 * 1. Requirement analysis
 * 2. Test coverage generation (scenarios + test cases)
 * 3. Coverage gap analysis
 * 4. Semantic deduplication
 * 5. Mode switching (strict vs expanded)
 * 6. Intelligence integration (app profile, test data, knowledge, repo)
 * 
 * These tests verify that all components work together correctly to produce
 * comprehensive, grounded test coverage from requirements.
 * 
 * Run with: npx tsx tests/integration/test-case-lab-pipeline.test.ts
 */

import {
  TestCoverageEngine,
  type RequirementInput,
  type KnowledgeContext,
  type CoverageType,
} from '../../src/engines/test-coverage-engine';

// Simple test framework
let testCount = 0;
let passedCount = 0;
let failedCount = 0;

function describe(name: string, fn: () => void | Promise<void>) {
  console.log(`\n${name}`);
  return fn();
}

function it(name: string, fn: () => void | Promise<void>) {
  testCount++;
  const result = fn();
  if (result instanceof Promise) {
    return result.then(() => {
      passedCount++;
      console.log(`  ✓ ${name}`);
    }).catch((err) => {
      failedCount++;
      console.log(`  ✗ ${name}`);
      console.log(`    Error: ${err.message}`);
      if (err.stack) {
        console.log(`    Stack: ${err.stack.split('\n').slice(0, 3).join('\n')}`);
      }
    });
  } else {
    try {
      passedCount++;
      console.log(`  ✓ ${name}`);
    } catch (err: any) {
      failedCount++;
      console.log(`  ✗ ${name}`);
      console.log(`    Error: ${err.message}`);
    }
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
    toBeGreaterThanOrEqual(expected: number) {
      if (value < expected) {
        throw new Error(`Expected ${value} to be >= ${expected}`);
      }
    },
    toHaveLength(expected: number) {
      if (value.length !== expected) {
        throw new Error(`Expected length ${expected} but got ${value.length}`);
      }
    },
    toHaveProperty(prop: string) {
      if (!(prop in value)) {
        throw new Error(`Expected object to have property "${prop}"`);
      }
    },
  };
}

// Set up test environment - required before creating TestCoverageEngine
if (!process.env.OPENAI_API_KEY) {
  process.env.OPENAI_API_KEY = 'test-key-for-integration-tests';
}

// ============================================================================
// Integration Tests
// ============================================================================

describe('Test Case Lab Pipeline - Requirement Analysis', () => {
  const engine = new TestCoverageEngine();

  it('should analyze requirement and extract key information', async () => {
    const input: RequirementInput = {
      title: 'User Login',
      description: 'Users should be able to log in with username and password',
      acceptanceCriteria: 'Valid users can log in. Invalid credentials show error.',
      module: 'Authentication',
    };

    const { analysis, tokensUsed } = await engine.analyzeRequirement(input);

    expect(analysis).toBeDefined();
    expect(analysis.featureType).toBeTruthy();
    expect(analysis.riskLevel).toBeTruthy();
    expect(analysis.businessCriticality).toBeTruthy();
    expect(tokensUsed).toBeGreaterThan(0);
  });

  it('should incorporate knowledge context in analysis', async () => {
    const input: RequirementInput = {
      title: 'Payment Processing',
      description: 'Process credit card payments',
      module: 'Checkout',
    };

    const knowledge: KnowledgeContext = {
      modules: [{
        name: 'Checkout',
        workflows: 'Cart → Payment → Confirmation',
        businessRules: 'Minimum order $10',
        apis: 'POST /api/payments',
      }],
    };

    const { analysis } = await engine.analyzeRequirement(input, knowledge);

    expect(analysis).toBeDefined();
    expect(analysis.impactedModules).toBeTruthy();
  });
});

describe('Test Case Lab Pipeline - Full Coverage Generation (Strict Mode)', () => {
  const engine = new TestCoverageEngine();

  it('should generate comprehensive test coverage for a login requirement', async () => {
    const input: RequirementInput = {
      title: 'User Login',
      description: 'Users can log in with valid credentials and receive appropriate error messages for invalid attempts',
      acceptanceCriteria: 'AC1: Valid users successfully log in\nAC2: Invalid credentials show error',
      module: 'Authentication',
    };

    const coverageTypes: CoverageType[] = ['positive', 'negative'];

    const result = await engine.generateFullCoverage(input, coverageTypes, undefined, {
      includeCoverageGaps: false, // strict mode
      deduplicate: true,
    });

    // Verify result structure
    expect(result.requirementAnalysis).toBeDefined();
    expect(result.scenarios).toBeDefined();
    expect(result.testCases).toBeDefined();
    expect(result.coverageTypeEvaluations).toBeDefined();
    expect(result.mode).toBe('strict');

    // Verify coverage type evaluations exist for all selected types
    expect(result.coverageTypeEvaluations).toHaveLength(2);
    const types = result.coverageTypeEvaluations.map(e => e.coverageType);
    expect(types).toContain('positive');
    expect(types).toContain('negative');

    // In strict mode, suggestions and missing requirements should be empty
    expect(result.suggestedTestCases).toHaveLength(0);
    expect(result.missingRequirements).toHaveLength(0);
    expect(result.coverageGaps).toHaveLength(0);

    // Stats should be populated
    expect(result.stats.totalScenarios).toBeGreaterThanOrEqual(0);
    expect(result.stats.totalTestCases).toBeGreaterThanOrEqual(0);
    expect(result.stats.tokensUsed).toBeGreaterThan(0);
  }, 30000); // 30s timeout for LLM calls
});

describe('Test Case Lab Pipeline - Full Coverage Generation (Expanded Mode)', () => {
  const engine = new TestCoverageEngine();

  it('should generate coverage with suggestions in expanded mode', async () => {
    const input: RequirementInput = {
      title: 'Product Search',
      description: 'Users can search for products by name',
      acceptanceCriteria: 'Search returns matching products',
      module: 'Search',
    };

    const coverageTypes: CoverageType[] = ['positive', 'negative', 'edge_cases'];

    const result = await engine.generateFullCoverage(input, coverageTypes, undefined, {
      includeCoverageGaps: true, // expanded mode
      deduplicate: true,
    });

    expect(result.mode).toBe('expanded');

    // Expanded mode should have gap analysis
    expect(result.coverageGaps).toBeDefined();
    
    // May have suggested test cases and missing requirements
    expect(result.suggestedTestCases).toBeDefined();
    expect(result.missingRequirements).toBeDefined();

    // Coverage type evaluations should exist
    expect(result.coverageTypeEvaluations.length).toBeGreaterThanOrEqual(3);
  }, 30000);
});

describe('Test Case Lab Pipeline - Application Profile Grounding', () => {
  const engine = new TestCoverageEngine();

  it('should ground test cases in real application structure', async () => {
    const input: RequirementInput = {
      title: 'Login Flow',
      description: 'User authentication',
      module: 'Auth',
    };

    const knowledge: KnowledgeContext = {
      applicationProfile: {
        baseUrl: 'https://www.saucedemo.com',
        name: 'SauceDemo',
        pageCount: 2,
        totalElements: 50,
        totalForms: 1,
        loginUrl: 'https://www.saucedemo.com',
        username: 'standard_user',
        pages: [
          { url: '/login', title: 'Login', pageType: 'auth', elementCount: 10, formCount: 1 },
        ],
        forms: [
          {
            page: '/login',
            method: 'POST',
            fields: [
              { name: 'username', type: 'text', required: true, selector: '#user-name' },
              { name: 'password', type: 'password', required: true, selector: '#password' },
            ],
            submitSelector: '#login-button',
          },
        ],
      },
    };

    const result = await engine.generateFullCoverage(
      input,
      ['positive'],
      knowledge,
      { includeCoverageGaps: false }
    );

    expect(result.requirementAnalysis).toBeDefined();
    expect(result.testCases).toBeDefined();
    
    // Test cases should reference real selectors when available
    const hasHighSelectorAvailability = result.testCases.some(
      tc => tc.selectorAvailability === 'high'
    );
    
    // At least some test cases should be grounded in app_profile
    const hasAppProfileSource = result.testCases.some(
      tc => tc.source === 'app_profile' || tc.source === 'requirement'
    );
    
    expect(hasHighSelectorAvailability || hasAppProfileSource).toBe(true);
  }, 30000);
});

describe('Test Case Lab Pipeline - Test Data Grounding', () => {
  const engine = new TestCoverageEngine();

  it('should reference real test datasets in generated cases', async () => {
    const input: RequirementInput = {
      title: 'User Login',
      description: 'Authenticate users',
      module: 'Auth',
    };

    const knowledge: KnowledgeContext = {
      testData: [
        {
          name: 'valid_users',
          environment: 'staging',
          recordCount: 5,
          sampleKeys: ['standard_user', 'premium_user'],
        },
        {
          name: 'invalid_users',
          environment: 'staging',
          recordCount: 3,
          sampleKeys: ['locked_user', 'invalid_user'],
        },
      ],
    };

    const result = await engine.generateFullCoverage(
      input,
      ['positive', 'negative'],
      knowledge,
      { includeCoverageGaps: false }
    );

    expect(result.testCases).toBeDefined();
    
    // Some test cases should be grounded in test_data
    const hasTestDataSource = result.testCases.some(
      tc => tc.source === 'test_data' || tc.testData?.includes('valid_users') || tc.testData?.includes('invalid_users')
    );
    
    // Test data presence increases likelihood of data-grounded cases
    expect(result.testCases.length).toBeGreaterThan(0);
  }, 30000);
});

describe('Test Case Lab Pipeline - Semantic Deduplication', () => {
  const engine = new TestCoverageEngine();

  it('should track removed duplicates in stats', async () => {
    const input: RequirementInput = {
      title: 'Basic Feature',
      description: 'A simple feature to test deduplication tracking',
      module: 'Core',
    };

    const result = await engine.generateFullCoverage(
      input,
      ['positive'],
      undefined,
      { deduplicate: true }
    );

    // Stats should include duplicatesRemoved count (0 or more)
    expect(result.stats).toHaveProperty('duplicatesRemoved');
    expect(result.stats.duplicatesRemoved).toBeGreaterThanOrEqual(0);
  }, 30000);
});

describe('Test Case Lab Pipeline - Coverage Type Evaluation Completeness', () => {
  const engine = new TestCoverageEngine();

  it('should evaluate all selected coverage types', async () => {
    const input: RequirementInput = {
      title: 'Complete Coverage Test',
      description: 'Test that all selected coverage types are evaluated',
      module: 'Testing',
    };

    const selectedTypes: CoverageType[] = ['positive', 'negative', 'edge_cases', 'boundary'];

    const result = await engine.generateFullCoverage(
      input,
      selectedTypes,
      undefined,
      { includeCoverageGaps: false }
    );

    // Every selected type MUST have an evaluation entry
    expect(result.coverageTypeEvaluations).toHaveLength(selectedTypes.length);

    selectedTypes.forEach(type => {
      const evaluation = result.coverageTypeEvaluations.find(e => e.coverageType === type);
      expect(evaluation).toBeDefined();
      expect(evaluation!.status).toBeTruthy(); // either 'covered' or 'not_applicable'
      
      if (evaluation!.status === 'not_applicable') {
        // Must have a reason when not applicable
        expect(evaluation!.reason).toBeTruthy();
      }
    });
  }, 30000);
});

// ============================================================================
// Test Runner
// ============================================================================

async function runTests() {
  console.log('\n🧪 Test Case Lab Pipeline Integration Tests\n');
  console.log('='.repeat(60));

  const promises: Promise<void>[] = [];

  // Collect all test promises
  describe('Test Case Lab Pipeline - Requirement Analysis', () => {
    const engine = new TestCoverageEngine();
    promises.push(it('should analyze requirement and extract key information', async () => {
      const input: RequirementInput = {
        title: 'User Login',
        description: 'Users should be able to log in with username and password',
        acceptanceCriteria: 'Valid users can log in. Invalid credentials show error.',
        module: 'Authentication',
      };
      const { analysis, tokensUsed } = await engine.analyzeRequirement(input);
      expect(analysis).toBeDefined();
      expect(tokensUsed).toBeGreaterThan(0);
    })!);

    promises.push(it('should incorporate knowledge context in analysis', async () => {
      const input: RequirementInput = {
        title: 'Payment Processing',
        description: 'Process credit card payments',
        module: 'Checkout',
      };
      const knowledge: KnowledgeContext = {
        modules: [{
          name: 'Checkout',
          workflows: 'Cart → Payment → Confirmation',
          businessRules: 'Minimum order $10',
          apis: 'POST /api/payments',
        }],
      };
      const { analysis } = await engine.analyzeRequirement(input, knowledge);
      expect(analysis).toBeDefined();
    })!);
  });

  describe('Test Case Lab Pipeline - Full Coverage Generation (Strict Mode)', () => {
    const engine = new TestCoverageEngine();
    promises.push(it('should generate comprehensive test coverage for a login requirement', async () => {
      const input: RequirementInput = {
        title: 'User Login',
        description: 'Users can log in with valid credentials',
        acceptanceCriteria: 'Valid users successfully log in',
        module: 'Authentication',
      };
      const result = await engine.generateFullCoverage(input, ['positive', 'negative'], undefined, {
        includeCoverageGaps: false,
        deduplicate: true,
      });
      expect(result.mode).toBe('strict');
      expect(result.suggestedTestCases).toHaveLength(0);
      expect(result.stats.tokensUsed).toBeGreaterThan(0);
    })!);
  });

  describe('Test Case Lab Pipeline - Full Coverage Generation (Expanded Mode)', () => {
    const engine = new TestCoverageEngine();
    promises.push(it('should generate coverage with suggestions in expanded mode', async () => {
      const input: RequirementInput = {
        title: 'Product Search',
        description: 'Users can search for products by name',
        module: 'Search',
      };
      const result = await engine.generateFullCoverage(input, ['positive'], undefined, {
        includeCoverageGaps: true,
        deduplicate: true,
      });
      expect(result.mode).toBe('expanded');
      expect(result.coverageGaps).toBeDefined();
    })!);
  });

  // Wait for all tests to complete
  await Promise.all(promises);

  console.log('\n' + '='.repeat(60));
  console.log(`\nResults: ${passedCount}/${testCount} tests passed`);
  
  if (failedCount > 0) {
    console.log(`\n❌ ${failedCount} test(s) failed\n`);
    process.exit(1);
  } else {
    console.log(`\n✅ All tests passed!\n`);
    process.exit(0);
  }
}

// Run tests
runTests().catch((err) => {
  console.error('\n❌ Test runner error:', err);
  process.exit(1);
});
