# LevelUp AI QA Agent 🔧

Refined AI self-healing test automation MVP with modular architecture:

`Execution Engine → Artifact Collector → Failure Analyzer → Healing Orchestrator (Rule → Pattern → AI) → Validation Layer → Apply Fix → Re-run → SQLite → Git Commit → HTML Report`

## Refined Module Structure

```text
src/
├── core/
│   ├── execution-engine.ts
│   ├── artifact-collector.ts
│   ├── failure-analyzer.ts
│   └── healing-orchestrator.ts
├── engines/
│   ├── rule-engine.ts
│   ├── pattern-engine.ts
│   └── ai-engine.ts
├── validation/
│   └── validation-layer.ts
├── db/
│   └── sqlite.ts
├── ai/
│   └── openai-client.ts
├── github/
│   └── pr-creator.ts
├── reports/
│   └── html-report.ts
└── index.ts
```

## Healing Levels

1. **Rule Engine (L1, 0 token cost)**
   - Deterministic transformations for common broken locator shapes.
2. **Pattern Engine (L2, 0 token cost)**
   - SQLite lookup on previously successful fixes.
3. **AI Engine (L3, minimal token cost)**
   - GPT-4o-mini with small context window only when L1/L2 miss.

## Validation Layer

Before any fix is applied:
- TypeScript syntax validation
- Semantic locator requirement (`getByRole`, `getByLabel`, etc.)
- Security pattern blocklist (`eval`, `new Function`, etc.)
- Confidence threshold (> 0.8)
- Patch file generation (`.patch`) for reviewability

## SQLite Storage

Database file: `/home/ubuntu/healing_data.db`

Tables:
- `test_executions`
- `healing_actions`
- `learned_patterns`

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

## Environment

```env
OPENAI_API_KEY=...
GITHUB_TOKEN=...
DATABASE_PATH=/home/ubuntu/healing_data.db
LOG_LEVEL=info
```

## Run

```bash
npx ts-node src/index.ts --repo /home/ubuntu/github_repos/selfhealing_agent_poc --auto-commit
```

## Notes

- `.env` is gitignored (API keys are not committed).
- Reports and patch files are generated under `/home/ubuntu/healing_reports`.
- Built for future extension into flaky/API/assertion healing agents.
