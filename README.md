# LevelUp AI QA Agent 🔧

AI-powered self-healing test automation agent. Runs Playwright tests, detects failures, and autonomously fixes broken locators using a cost-optimized 3-tier healing strategy.

## Architecture

```
GitHub Push → Run Playwright → Failure? → Extract Locator
    → Level 1: Rule-based fix (0 tokens)
    → Level 2: DB pattern match (0 tokens)
    → Level 3: OpenAI reasoning (minimal tokens)
    → Patch Code → Re-run → Create PR → Report
```

## Module Responsibility

| Module | File | Purpose |
|--------|------|---------|
| Execution Engine | `src/core/execution-engine.ts` | Run Playwright tests, capture results |
| Failure Analyzer | `src/core/failure-analyzer.ts` | Parse failures, extract locators |
| Locator Healer | `src/core/locator-healer.ts` | Rule-based + DB pattern healing |
| OpenAI Client | `src/ai/openai-client.ts` | AI reasoning (Level 3 only) |
| DB Layer | `src/db/postgres.ts` | Healing history, pattern storage |
| PR Creator | `src/github/pr-creator.ts` | Git commit + GitHub PR |
| HTML Report | `src/reports/html-report.ts` | Comprehensive healing reports |
| Orchestrator | `src/index.ts` | End-to-end flow coordinator |

## Healing Strategy (Cost-Optimized)

**Level 1 — Rule-Based (0 AI tokens):** Converts broken locators to semantic alternatives using pattern matching. Tries `getByRole` > `getByLabel` > `getByText` > `getByTestId` > CSS.

**Level 2 — Database Patterns (0 AI tokens):** Checks PostgreSQL for previously successful fixes. If the same locator broke before and was healed, applies the stored solution instantly.

**Level 3 — AI Reasoning (minimal tokens):** Only when L1 + L2 fail. Sends minimal context (error + failed line + small DOM snippet) to GPT-4o-mini. Stores the fix in DB for future reuse.

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env  # Fill in your credentials
```

## Usage

```bash
# Full orchestration
npx ts-node src/index.ts --repo /path/to/test-repo --github-token <token>

# Individual modules
npx ts-node src/core/execution-engine.ts /path/to/test-repo
npx ts-node src/core/failure-analyzer.ts test-results.json /path/to/test-repo
npx ts-node src/core/locator-healer.ts rule <failure-context.json>
npx ts-node src/core/locator-healer.ts db-lookup <failure-context.json>
```

## Database Schema

```sql
test_executions  — logs every test run (pass/fail/healed)
healing_actions  — tracks each healing attempt with strategy + tokens
learned_patterns — stores successful fixes for future reuse
```

## License

ISC
