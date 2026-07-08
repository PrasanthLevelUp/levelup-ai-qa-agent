# LevelUp AI Benchmarks

Objective measurement of Script Composer improvements across sprints.

## Philosophy

Benchmarks provide **evidence that the product is improving**, not just that code was shipped. Each sprint updates the benchmark apps with new measurements, creating a transparent record of progress.

## Benchmark Apps

| App | Framework | Coverage | Why |
|-----|-----------|----------|-----|
| **SauceDemo** | Playwright | Login, cart, checkout | Simple e-commerce; good page-object structure |
| **OrangeHRM** | Playwright | Employee management | Complex enterprise patterns |
| **OpenCart** | Mixed | Product catalog | Real-world mixed conventions |

## Key Metrics

| Metric | Definition | Target Direction |
|--------|------------|------------------|
| **Ready-to-run %** | Tests that execute without syntax/runtime errors | ↑ Higher |
| **Reuse rate %** | Steps implemented via existing repo code vs generated | ↑ Higher |
| **Assertions/test** | Average meaningful assertions per generated test | ↑ Higher |
| **Manual edits** | Changes required before the test is production-ready | ↓ Lower |
| **Reuse-at-#1 %** | Discovery steps where the #1 ranked candidate is reusable code | ↑ Higher |

## Sprint Tracking

Each sprint adds one commit per benchmark app updating the metrics table. The historical record lives in git — `git log benchmarks/saucedemo.md` shows every sprint's improvement.

## Running Measurements

```bash
# Discovery measurement (Candidate Resolution quality)
npx ts-node tools/measure-discovery.ts

# Script generation measurement (end-to-end quality — TBD Sprint 3+)
# Will compare generated scripts against benchmark apps' existing test suites
```
