# Test Suite

This directory contains unit and integration tests for the LevelUp AI QA Agent.

## Directory Structure

- `unit/` - Fast, isolated tests for individual components
- `integration/` - End-to-end tests that verify component interactions

## Running Tests

### Unit Tests
```bash
# Run all unit tests
npm run test:unit

# Run a specific unit test
npx tsx tests/unit/test-coverage-engine.test.ts
```

### Integration Tests
```bash
# Run all integration tests
npm run test:integration

# Run a specific integration test
npx tsx tests/integration/test-case-lab-pipeline.test.ts
```

## Test Coverage Engine Tests

### Unit Tests (`unit/test-coverage-engine.test.ts`)
Fast, isolated tests that verify:
- Coverage type goal definitions (all 16 types)
- Coverage type evaluation reconciliation
- Application profile context building
- Test data context building
- Repository intelligence integration
- Source tagging and provenance

**Runtime**: < 1 second
**No API calls**: These tests use mock data and test pure logic

### Integration Tests (`integration/test-case-lab-pipeline.test.ts`)
End-to-end tests that verify the full pipeline:
- Requirement analysis
- Test coverage generation (strict and expanded modes)
- Application profile grounding
- Test data grounding
- Semantic deduplication
- Coverage type evaluation completeness

**Runtime**: ~30 seconds per test
**API calls**: ⚠️ These tests make real LLM API calls to OpenAI
**Cost**: Approximately $0.10 per full test run

#### Running Integration Tests

**With a real API key**:
```bash
export OPENAI_API_KEY=your-key-here
npx tsx tests/integration/test-case-lab-pipeline.test.ts
```

**Without an API key** (will use mock key and tests will fail on API calls):
The tests will attempt to run but will fail when making actual LLM calls.

## Test Case Lab Quality Improvements

The Test Coverage Engine tests were added to verify the quality improvements from commit `38f5733`:

1. **Coverage Type Goals** - Semantic definitions for all 16 coverage types
2. **Coverage Type Evaluation** - Reconciliation of model output with actual scenarios/cases
3. **Grounded Generation** - App Profile, Test Data, and Knowledge integration
4. **Source Provenance** - Traceability via source tagging
5. **Semantic Deduplication** - Near-duplicate test case removal

These tests ensure that Test Case Lab generates comprehensive, grounded test coverage while preventing regressions.
