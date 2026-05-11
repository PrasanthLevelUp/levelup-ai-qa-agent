# LevelUp AI QA Agent v2.1 (Core-Hardened)

AI-powered self-healing test automation agent with REST API, multi-repo support, and hardened healing pipeline.

## What's New in v2.1

- **Security**: API keys moved from JSON config to environment variables
- **7-Check Validation**: syntax, semantic, security, exists, unique, visible, interactable
- **AST-Based Patching**: Surgical code changes using ts-morph (preserves formatting)
- **Strategy Selector**: Confidence-based routing with token budget management
- **37 Rule Engine Strategies**: Expanded from ~20 to 37 deterministic rules
- **90%+ Success Rate**: Verified with 11 integration test scenarios

## Architecture

```
src/
├── ai/
│   └── openai-client.ts          # OpenAI API integration
├── api/
│   ├── server.ts                 # Express REST API server
│   ├── middleware/
│   │   ├── auth.ts               # API key auth (reads from env vars)
│   │   └── error-handler.ts      # Global error handler
│   ├── routes/
│   │   ├── heal.ts               # POST /api/heal
│   │   ├── status.ts             # GET /api/status/:jobId
│   │   ├── reports.ts            # GET /api/reports/:jobId
│   │   ├── repos.ts              # CRUD /api/repos
│   │   └── webhook.ts            # POST /api/webhook/github
│   ├── queue/
│   │   └── job-queue.ts          # Job queue with SQLite persistence
│   └── services/
│       └── repo-manager.ts       # Multi-repo configuration
├── config/
│   └── repos.json                # Repository configurations
├── core/
│   ├── execution-engine.ts       # Async test execution (spawn-based)
│   ├── artifact-collector.ts     # Orchestrates artifact collection
│   ├── healing-strategy-selector.ts  # NEW: Confidence-based routing
│   ├── failure-analyzer.ts       # Failure classification
│   ├── healing-orchestrator.ts   # Coordinates healing engines
│   ├── locator-extractor.ts      # Parses failed locators
│   ├── error-normalizer.ts       # Standardizes error messages
│   └── code-context-extractor.ts # Extracts code context around failures
├── engines/
│   ├── rule-engine.ts            # Level 1: Deterministic rules
│   ├── pattern-engine.ts         # Level 2: Learned patterns (SQLite)
│   ├── ai-engine.ts              # Level 3: OpenAI suggestions
│   ├── validation-engine.ts      # Pre-apply validation checks
│   ├── patch-engine.ts           # Unified diff patch generation
│   └── rerun-engine.ts           # Isolated test re-execution
├── db/
│   └── sqlite.ts                 # SQLite database layer
├── github/
│   └── pr-creator.ts             # Git operations & PR creation
├── reports/
│   └── html-report.ts            # HTML report generator
├── utils/
│   ├── logger.ts                 # Structured JSON logging
│   └── file-utils.ts             # File backup/restore utilities
├── validation/
│   └── validation-layer.ts       # Safety gate for fixes
└── index.ts                      # Entry point (CLI + API modes)
```

## Healing Levels

| Level | Engine         | AI Tokens | Description                              |
|-------|---------------|-----------|------------------------------------------|
| 1     | Rule Engine    | 0         | Deterministic strategies (ID→role, etc.) |
| 2     | Pattern Engine | 0         | Previously learned fixes from database   |
| 3     | AI Engine      | ~150-200  | OpenAI semantic locator suggestions      |

## Validation Checks

Before applying any fix, the system validates:
- **Confidence threshold**: Must be > 0.8
- **Semantic locator**: Must use getByRole/getByLabel/getByText etc.
- **Security check**: No eval(), dangerous patterns
- **Syntax validation**: TypeScript compiler check
- **Non-empty check**: Locator must be non-empty

## REST API

### Authentication

All API endpoints (except `/api/health` and `/api/webhook`) require Bearer token:

```bash
-H "Authorization: Bearer levelup_dev_test_key_2026"
```

### Endpoints

#### Health Check
```bash
GET /api/health
# No auth required
curl http://localhost:3000/api/health
```

#### Queue Healing Job
```bash
POST /api/heal
curl -X POST http://localhost:3000/api/heal \
  -H "Authorization: Bearer levelup_dev_test_key_2026" \
  -H "Content-Type: application/json" \
  -d '{"repository": "repo_1", "branch": "main"}'
```

Response:
```json
{
  "jobId": "job_abc123",
  "status": "pending",
  "message": "Healing job queued"
}
```

#### Check Job Status
```bash
GET /api/status/:jobId
curl -H "Authorization: Bearer levelup_dev_test_key_2026" \
  http://localhost:3000/api/status/job_abc123
```

#### Get Report (JSON)
```bash
GET /api/reports/:jobId
curl -H "Authorization: Bearer levelup_dev_test_key_2026" \
  http://localhost:3000/api/reports/job_abc123
```

#### Get Report (HTML)
```bash
GET /api/reports/:jobId/html
curl -H "Authorization: Bearer levelup_dev_test_key_2026" \
  http://localhost:3000/api/reports/job_abc123/html
```

#### List Repositories
```bash
GET /api/repos
curl -H "Authorization: Bearer levelup_dev_test_key_2026" \
  http://localhost:3000/api/repos
```

#### Add Repository
```bash
POST /api/repos
curl -X POST http://localhost:3000/api/repos \
  -H "Authorization: Bearer levelup_dev_test_key_2026" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-test-repo", "url": "https://github.com/user/repo", "branch": "main"}'
```

#### Delete Repository
```bash
DELETE /api/repos/:id
curl -X DELETE -H "Authorization: Bearer levelup_dev_test_key_2026" \
  http://localhost:3000/api/repos/repo_2
```

#### List All Jobs
```bash
GET /api/jobs
curl -H "Authorization: Bearer levelup_dev_test_key_2026" \
  http://localhost:3000/api/jobs
```

### GitHub Webhook Integration

```bash
POST /api/webhook/github
# No API key required (uses GitHub signature validation)
curl -X POST http://localhost:3000/api/webhook/github \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: push" \
  -d '{"ref":"refs/heads/main","repository":{"clone_url":"https://github.com/user/repo"},"after":"abc123"}'
```

**GitHub Actions Setup:**
Add a webhook in your GitHub repository settings:
- **Payload URL**: `https://your-server/api/webhook/github`
- **Content type**: `application/json`
- **Events**: Push events, Workflow runs

## Multi-Repo Configuration

Edit `src/config/repos.json`:
```json
{
  "repositories": [
    {
      "id": "repo_1",
      "name": "selfhealing_agent_poc",
      "url": "https://github.com/PrasanthLevelUp/selfhealing_agent_poc",
      "branch": "main",
      "localPath": "/home/ubuntu/github_repos/selfhealing_agent_poc",
      "enabled": true
    }
  ]
}
```

Or use the API:
```bash
curl -X POST http://localhost:3000/api/repos \
  -H "Authorization: Bearer levelup_dev_test_key_2026" \
  -H "Content-Type: application/json" \
  -d '{"name":"new-repo","url":"https://github.com/user/repo","branch":"main"}'
```

## SQLite Storage

Database: `/home/ubuntu/healing_data.db`

Tables:
- `test_executions` — Test run history
- `healing_actions` — Healing attempts and results
- `learned_patterns` — Successful fix patterns for reuse
- `healing_jobs` — API job queue persistence

## Setup

```bash
# Clone
git clone https://github.com/PrasanthLevelUp/levelup-ai-qa-agent.git
cd levelup-ai-qa-agent

# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your API keys

# Build
npm run build
```

## Environment Variables

```env
MODE=api                           # 'api' or 'cli'
PORT=3000                          # API server port
OPENAI_API_KEY=sk-proj-...         # OpenAI API key
GITHUB_TOKEN=ghp_...               # GitHub personal access token
DATABASE_PATH=/home/ubuntu/healing_data.db
REPORT_DIR=/home/ubuntu/healing_reports
LOG_LEVEL=info                     # debug, info, warn, error
GITHUB_WEBHOOK_SECRET=             # Optional webhook signature validation
```

## Running

### API Mode (REST Server)
```bash
# Development
npm run start:api

# Production
MODE=api npm start
```

### CLI Mode (Direct Execution)
```bash
# Development
npm run start:cli

# With arguments
npx ts-node src/index.ts --repo /path/to/test/repo --auto-commit
```

## Key Features

### Level 1 Refinements
- **Async Execution Engine**: Non-blocking test execution with spawn
- **Modular Artifact Collection**: Specialized extractors for locators, errors, and code context
- **Enhanced Rule Engine**: 20+ deterministic strategies for ID, class, input, button, link, heading, and XPath selectors
- **Validation Engine**: Multi-check validation (syntax, semantic, security, confidence)
- **Patch Engine**: Proper unified diff generation with metadata
- **Rerun Engine**: Isolated test re-execution to verify fixes
- **Refined Orchestrator**: Clean flow with validation at each step

### REST API
- **Express Server**: CORS-enabled, JSON body parsing, error handling
- **API Key Auth**: Bearer token authentication
- **Multi-Repo Support**: Configure and manage multiple test repositories
- **Job Queue**: SQLite-backed job queue with status tracking
- **Webhook Handler**: GitHub Actions integration for automated healing
- **Comprehensive Reports**: JSON and HTML report endpoints

## Notes

- `.env` is excluded from version control
- Reports are generated in `REPORT_DIR` directory
- API keys are stored in `src/config/api-keys.json`
- The job queue persists jobs across server restarts via SQLite
