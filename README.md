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
│   │   └── job-queue.ts          # Job queue with PostgreSQL persistence
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
│   ├── pattern-engine.ts         # Level 2: Learned patterns (PostgreSQL)
│   ├── ai-engine.ts              # Level 3: OpenAI suggestions
│   ├── validation-engine.ts      # Pre-apply validation checks
│   ├── patch-engine.ts           # Unified diff patch generation
│   └── rerun-engine.ts           # Isolated test re-execution
├── db/
│   └── postgres.ts               # PostgreSQL database layer
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
curl http://localhost:8080/api/health
```

#### Queue Healing Job
```bash
POST /api/heal
curl -X POST http://localhost:8080/api/heal \
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
  http://localhost:8080/api/status/job_abc123
```

#### Get Report (JSON)
```bash
GET /api/reports/:jobId
curl -H "Authorization: Bearer levelup_dev_test_key_2026" \
  http://localhost:8080/api/reports/job_abc123
```

#### Get Report (HTML)
```bash
GET /api/reports/:jobId/html
curl -H "Authorization: Bearer levelup_dev_test_key_2026" \
  http://localhost:8080/api/reports/job_abc123/html
```

#### List Repositories
```bash
GET /api/repos
curl -H "Authorization: Bearer levelup_dev_test_key_2026" \
  http://localhost:8080/api/repos
```

#### Add Repository
```bash
POST /api/repos
curl -X POST http://localhost:8080/api/repos \
  -H "Authorization: Bearer levelup_dev_test_key_2026" \
  -H "Content-Type: application/json" \
  -d '{"name": "my-test-repo", "url": "https://github.com/user/repo", "branch": "main"}'
```

#### Delete Repository
```bash
DELETE /api/repos/:id
curl -X DELETE -H "Authorization: Bearer levelup_dev_test_key_2026" \
  http://localhost:8080/api/repos/repo_2
```

#### List All Jobs
```bash
GET /api/jobs
curl -H "Authorization: Bearer levelup_dev_test_key_2026" \
  http://localhost:8080/api/jobs
```

### GitHub Webhook Integration

```bash
POST /api/webhook/github
# No API key required (uses GitHub signature validation)
curl -X POST http://localhost:8080/api/webhook/github \
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
curl -X POST http://localhost:8080/api/repos \
  -H "Authorization: Bearer levelup_dev_test_key_2026" \
  -H "Content-Type: application/json" \
  -d '{"name":"new-repo","url":"https://github.com/user/repo","branch":"main"}'
```

## PostgreSQL Storage

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
PORT=8080                          # API server port
OPENAI_API_KEY=sk-proj-...         # OpenAI API key
GITHUB_TOKEN=ghp_...               # GitHub personal access token
DATABASE_URL=postgresql://user:password@host:5432/levelup_qa
REPORT_DIR=/home/ubuntu/healing_reports
LOG_LEVEL=info                     # debug, info, warn, error
GITHUB_WEBHOOK_SECRET=             # Optional webhook signature validation
ENABLE_CODE_CHUNKS=false           # Repo Intelligence: store code_chunks (Phase 2/RAG; off by default)

# ── Repository Intelligence Phase 2 (all OFF by default) ──
ENABLE_REPO_VECTOR_SEARCH=false    # pgvector migration + embedding generation + similarity search
ENABLE_REPO_RAG=false              # Inject retrieved few-shot examples into script generation (needs VECTOR_SEARCH)
ENABLE_REPO_WORKERS=false          # Async scans/embeddings via BullMQ (needs Redis)
ENABLE_REPO_WEBHOOKS=false         # Mount the GitHub push webhook for incremental re-scans
REDIS_URL=redis://localhost:6379   # Used only when ENABLE_REPO_WORKERS=true
REPO_WORKER_CONCURRENCY=2          # Max concurrent repo jobs per worker
REPO_WEBHOOK_BRANCHES=             # Comma-separated branch allow-list (default: repo default branch)
OPENAI_EMBEDDING_MODEL=text-embedding-3-small  # Embedding model (1536 dims)

# ── Repository Intelligence Phase 3 (all OFF by default) ──
ENABLE_METHOD_INTELLIGENCE=false   # Build the method index + call-dependency graph during scans
ENABLE_TRUE_REUSE=false            # Suggest existing helpers in generation (needs METHOD_INTELLIGENCE)
ENABLE_MULTI_LANGUAGE=false        # Java/Python/C# analysis via tree-sitter (optional native grammars)
```

## Repository Intelligence (Phase 1)

The Repository Intelligence engine scans a connected repo, runs AST analysis,
and produces a `RepositoryProfile` that enriches script generation, healing,
and RCA. Phase 1 hardened the following:

### Language Support
- **Currently supported:** JavaScript, TypeScript.
- Coming in a later phase: Python, Java, C#.
- A scan of an unsupported repo now **fails loudly** with HTTP `400`
  (`errorType: "UNSUPPORTED_LANGUAGE"`) instead of silently producing an empty
  profile. The detected language and the supported list are returned in the
  response.

### Code Chunks Storage
- Temporarily **disabled by default** until the RAG / vector-search retrieval
  path lands (Phase 2). Today `code_chunks` are only read by the read-only
  `/chunks` API and are not used in generation/healing/RCA, so extracting and
  storing them is pure overhead.
- Enable with: `ENABLE_CODE_CHUNKS=true` (see `src/config/features.ts`).

### Coding-Style Detection
- Now samples **up to 10 files** (preferring test files) and uses a
  **majority vote** for:
  - Semicolons usage
  - Quote style (single / double / mixed)
  - Indentation (2 spaces, 4 spaces, tabs)
- Previously inferred from the first 2 KB of a single file.

### Project Scoping
- `repository_contexts.project_id` links a profile to a specific project so the
  intelligence-fusion service can scope lookups by `(company_id, project_id)`,
  with a graceful fallback to company-wide (`project_id IS NULL`) profiles.
- Pass `projectId` in the `POST /api/repo-intelligence/scan` body to link a scan
  to a project.

## Repository Intelligence (Phase 2 — RAG, Workers, Webhooks, Few-Shot)

Phase 2 adds semantic retrieval, asynchronous scanning, and incremental
re-scans. **Every Phase 2 capability is gated behind a feature flag that is OFF
by default.** With no flags set (and no Redis / pgvector / embedding model
configured), behaviour is byte-for-byte identical to Phase 1 — scans run
synchronously, no Redis connection is opened, the pgvector migration is skipped,
and script generation produces the same prompt. Flip flags on incrementally as
the supporting infrastructure becomes available.

### 1. Vector Search & Embeddings (`ENABLE_REPO_VECTOR_SEARCH`)
- On startup, runs an **idempotent, non-fatal** migration that enables the
  `vector` extension and adds `embedding vector(1536)`, `embedding_model`,
  `embedded_at`, and `token_count` columns (plus an `ivfflat` cosine index) to
  `code_chunks`. If the database lacks the `vector` extension, the migration is
  skipped and the system continues with vector search disabled.
- Embeddings are generated via the existing `OpenAIClient`
  (`OPENAI_EMBEDDING_MODEL`, default `text-embedding-3-small`, 1536 dims) and
  stored per chunk. Requires `OPENAI_API_KEY`; without it, embedding is a no-op.
- New DB helpers: `getUnembeddedChunks`, `updateChunkEmbedding`,
  `getEmbeddingStats`, `searchSimilarChunks` (cosine `<=>`).

### 2. RAG / Few-Shot Learning (`ENABLE_REPO_RAG` + `ENABLE_REPO_VECTOR_SEARCH`)
- When both flags are on, script generation retrieves the most semantically
  similar **existing tests** from the repo's embedded chunks and injects them
  into the prompt as concrete few-shot examples, so generated tests match the
  repo's real style and helpers.
- Pass `repoContextId` in the generation config to scope retrieval. If retrieval
  is disabled or finds nothing, the prompt is unchanged (empty block).

### 3. Background Workers (`ENABLE_REPO_WORKERS`, needs Redis)
- `POST /api/repo-intelligence/scan` with `{ "async": true }` enqueues a BullMQ
  job and returns `202` with a `jobId` and `statusUrl` instead of blocking.
- Poll progress at `GET /api/repo-intelligence/scan/status/:jobId`.
- Worker handles `scan`, `rescan`, and `embed` jobs. Unsupported-language errors
  fail fast (non-retryable); transient errors are retried. Concurrency via
  `REPO_WORKER_CONCURRENCY`. When the flag is off, no Redis connection is opened
  and the synchronous path is used.

### 4. GitHub Push Webhooks (`ENABLE_REPO_WEBHOOKS`)
- Mounts `POST /api/repo-intel-webhook/github`, validating the
  `x-hub-signature-256` HMAC against `GITHUB_WEBHOOK_SECRET` (constant-time, no
  throw on length mismatch).
- Only re-scans repositories already tracked in `repository_contexts` (matched
  against the payload's `full_name` / clone / ssh / html URLs). Branch filtering
  via `REPO_WEBHOOK_BRANCHES` (defaults to the repo's default branch).
- If workers are enabled the re-scan is enqueued; otherwise it runs inline,
  fire-and-forget. When the flag is off the route is not mounted, so no
  unauthenticated surface is exposed.

### Tests
```bash
# Gating + pure-function unit tests (no infra needed)
npx tsx tests/unit/repo-intelligence-phase2.test.ts
```
The real-infrastructure paths (BullMQ against Redis, and the pgvector similarity
search against Postgres) were additionally validated end-to-end during
development — see `repo_intelligence_phase2_implementation.md`.

## Repository Intelligence (Phase 3 — Method Intelligence, True Reuse, Multi-Language)

Phase 3 makes generation *reuse-aware* and extends analysis beyond TS/JS.
**Every Phase 3 capability is gated behind a feature flag that is OFF by
default.** With the flags unset, behaviour is identical to Phase 2 — no new
tables are created, no extra work runs during scans, and generation prompts are
unchanged.

### 1. Method Intelligence (`ENABLE_METHOD_INTELLIGENCE`)
During a scan, the `MethodIntelligenceService` (built on the existing **ts-morph**
analyzer) extracts every standalone function and class method — name,
parameters, return type, async-ness, JSDoc, the **full source code**, a
normalized SHA-256 `code_hash`, and the **list of methods each one calls**. It
persists them into two new tables and builds a caller→callee **dependency graph**:

- `repository_methods` — the searchable method index (classified as
  `helper` / `page_object_method` / `test` / `utility`).
- `method_dependencies` — the call graph (caller → callee, with call counts).

Fuzzy name search uses Postgres **`pg_trgm`** (`similarity()` + a GIN trigram
index). The migration is idempotent and non-fatal: if `pg_trgm` is unavailable
on a managed Postgres, the tables are still created (exact-hash dedup still
works) and search transparently degrades to an `ILIKE` fallback.

### 2. True Reuse Engine (`ENABLE_TRUE_REUSE`, needs `ENABLE_METHOD_INTELLIGENCE`)
Before the generator writes a new helper, the `TrueReuseEngine`:
- maps natural-language test steps to action keywords (login/click/fill/verify/…),
- searches the method index for matching existing helpers,
- scores candidates by name relevance × log(usage),
- injects an **"Existing Reusable Helpers"** block into the generation prompt so
  the model calls existing helpers instead of producing near-duplicates, and
- can flag exact duplicates by `code_hash`.

When disabled (or the index is empty) it returns empty results and the prompt is
unchanged.

### 3. Multi-Language Analysis (`ENABLE_MULTI_LANGUAGE`)
The `MultiLanguageAnalyzer` adds **Java / Python / C#** support via tree-sitter,
extracting classes, methods, imports and detecting the test framework in use
(JUnit/TestNG/Selenium, pytest/unittest/Playwright, NUnit/xUnit/MSTest, …).

The tree-sitter grammars are an **optional, lazily-loaded native dependency**:
they are `require()`d inside a try/catch, so the project compiles and runs
whether or not they are installed. If the grammars are missing the analyzer
reports `available: false` instead of throwing. Install them with:

```bash
npm install --legacy-peer-deps \
  tree-sitter tree-sitter-java tree-sitter-python tree-sitter-c-sharp@0.21.3
```

### Tests
```bash
# Gating + pure-function unit tests (no infra needed)
npx tsx tests/unit/repo-intelligence-phase3.test.ts

# Real multi-language parsing (skips automatically if grammars not installed)
npx tsx tests/unit/repo-intelligence-phase3-multilang.test.ts
```
The real-infrastructure path (method index + `pg_trgm` search + dependency graph
against a live Postgres) was additionally validated end-to-end during
development — see `repo_intelligence_phase3_implementation.md`.

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
- **Job Queue**: PostgreSQL-backed job queue with status tracking
- **Webhook Handler**: GitHub Actions integration for automated healing
- **Comprehensive Reports**: JSON and HTML report endpoints

## Notes

- `.env` is excluded from version control
- Reports are generated in `REPORT_DIR` directory
- API keys are stored in `src/config/api-keys.json`
- The job queue persists jobs across server restarts via PostgreSQL
