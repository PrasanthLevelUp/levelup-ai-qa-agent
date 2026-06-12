/**
 * Unit tests for Repository Intelligence Phase 2 (RAG, workers, webhooks,
 * few-shot learning).
 *
 * These tests exercise the *gating* and *pure-function* behaviour of the new
 * code WITHOUT any live infrastructure (no Postgres, no pgvector, no Redis, no
 * OpenAI). The whole point of Phase 2 is that every new behaviour is gated
 * behind a feature flag that defaults OFF, so with a clean environment:
 *
 *   - all four new flags read false,
 *   - the embedding / RAG services report disabled and return empty results,
 *   - the BullMQ queue is never constructed (getRepoQueue() === null),
 *   - pure helpers (signature validation, repo-id derivation, vector literal,
 *     remote-url detection) behave correctly.
 *
 * Run with: npx tsx tests/unit/repo-intelligence-phase2.test.ts
 */

/* Ensure a clean, flags-off environment regardless of the shell. */
for (const k of [
  'ENABLE_REPO_RAG',
  'ENABLE_REPO_VECTOR_SEARCH',
  'ENABLE_REPO_WORKERS',
  'ENABLE_REPO_WEBHOOKS',
  'OPENAI_API_KEY',
]) {
  delete process.env[k];
}

import { FEATURE_FLAGS, isRagRetrievalEnabled } from '../../src/config/features';
import { toVectorLiteral, isPgVectorAvailable } from '../../src/db/postgres';
import { isRemoteUrl } from '../../src/services/repo-scan-service';
import {
  validateSignature,
  candidateRepoIds,
} from '../../src/api/routes/repo-intel-webhook';
import { workersEnabled, getRepoQueue } from '../../src/jobs/queue-config';
import { getEmbeddingService } from '../../src/services/embedding-service';
import { getRAGService, ragFlagsEnabled } from '../../src/services/rag-service';
import * as crypto from 'crypto';

/* ------------------------------------------------------------------ */
/*  Tiny assertion harness (matches sibling tsx tests)                 */
/* ------------------------------------------------------------------ */
let passed = 0;
let failed = 0;
function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}
function assertEqual(actual: any, expected: any, msg: string) {
  assert(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

async function main() {
  /* ================================================================== */
  /*  Feature flags default OFF                                          */
  /* ================================================================== */
  console.log('\n=== Feature flags default OFF ===');
  const RI = FEATURE_FLAGS.REPO_INTELLIGENCE;
  assertEqual(RI.RAG_ENABLED, false, 'RAG_ENABLED defaults false');
  assertEqual(RI.VECTOR_SEARCH, false, 'VECTOR_SEARCH defaults false');
  assertEqual(RI.BACKGROUND_WORKERS, false, 'BACKGROUND_WORKERS defaults false');
  assertEqual(RI.GITHUB_WEBHOOKS, false, 'GITHUB_WEBHOOKS defaults false');
  assertEqual(isRagRetrievalEnabled(), false, 'isRagRetrievalEnabled() false by default');
  assertEqual(ragFlagsEnabled(), false, 'ragFlagsEnabled() false by default');

  /* ================================================================== */
  /*  toVectorLiteral — pgvector text format                            */
  /* ================================================================== */
  console.log('\n=== toVectorLiteral ===');
  assertEqual(toVectorLiteral([1, 2, 3]), '[1,2,3]', 'formats as bracketed CSV');
  assertEqual(toVectorLiteral([]), '[]', 'empty vector → []');
  assertEqual(toVectorLiteral([0.5, -0.25]), '[0.5,-0.25]', 'preserves floats/sign');

  /* ================================================================== */
  /*  isPgVectorAvailable — false until migration runs                  */
  /* ================================================================== */
  console.log('\n=== isPgVectorAvailable ===');
  assertEqual(isPgVectorAvailable(), false, 'pgvector unavailable before any DB init');

  /* ================================================================== */
  /*  isRemoteUrl                                                        */
  /* ================================================================== */
  console.log('\n=== isRemoteUrl ===');
  assertEqual(isRemoteUrl('https://github.com/o/r.git'), true, 'https → remote');
  assertEqual(isRemoteUrl('http://example.com/r'), true, 'http → remote');
  assertEqual(isRemoteUrl('git@github.com:o/r.git'), true, 'git@ ssh → remote');
  assertEqual(isRemoteUrl('/home/ubuntu/local/repo'), false, 'abs path → local');
  assertEqual(isRemoteUrl('./relative'), false, 'relative path → local');

  /* ================================================================== */
  /*  validateSignature — HMAC SHA-256                                   */
  /* ================================================================== */
  console.log('\n=== validateSignature ===');
  const secret = 'test-secret';
  const body = JSON.stringify({ hello: 'world' });
  const goodSig = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  assertEqual(validateSignature(body, goodSig, secret), true, 'valid signature accepted');
  assertEqual(validateSignature(body, goodSig, 'wrong-secret'), false, 'wrong secret rejected');
  assertEqual(validateSignature(body, undefined, secret), false, 'missing signature rejected');
  assertEqual(validateSignature(body, 'sha256=deadbeef', secret), false, 'length mismatch rejected (no throw)');
  assertEqual(validateSignature('{"tampered":true}', goodSig, secret), false, 'tampered body rejected');

  /* ================================================================== */
  /*  candidateRepoIds — derive stored identifiers from payload          */
  /* ================================================================== */
  console.log('\n=== candidateRepoIds ===');
  assertEqual(candidateRepoIds(null).length, 0, 'null repository → []');
  assertEqual(candidateRepoIds(undefined).length, 0, 'undefined repository → []');
  const ids = candidateRepoIds({
    full_name: 'octo/repo',
    html_url: 'https://github.com/octo/repo',
    clone_url: 'https://github.com/octo/repo.git',
    ssh_url: 'git@github.com:octo/repo.git',
  });
  assert(ids.includes('octo/repo'), 'includes full_name');
  assert(ids.includes('https://github.com/octo/repo'), 'includes html_url');
  assert(ids.includes('https://github.com/octo/repo.git'), 'includes clone_url + html_url.git variant');
  assert(ids.includes('git@github.com:octo/repo.git'), 'includes ssh_url');

  /* ================================================================== */
  /*  BullMQ queue — never constructed when workers disabled             */
  /* ================================================================== */
  console.log('\n=== BullMQ queue gating ===');
  assertEqual(workersEnabled(), false, 'workersEnabled() false by default');
  assertEqual(getRepoQueue(), null, 'getRepoQueue() returns null when disabled (no Redis opened)');

  /* ================================================================== */
  /*  EmbeddingService — disabled without VECTOR_SEARCH + API key        */
  /* ================================================================== */
  console.log('\n=== EmbeddingService gating ===');
  const emb = getEmbeddingService();
  assertEqual(emb.isEnabled(), false, 'EmbeddingService disabled by default');
  assertEqual(await emb.embed('some code'), null, 'embed() returns null when disabled (no API call)');
  const batch = await emb.embedBatch(['a', 'b']);
  assertEqual(Array.isArray(batch) && batch.length, 0, 'embedBatch() returns [] when disabled');

  /* ================================================================== */
  /*  RAGService — disabled, returns empty without touching DB/OpenAI    */
  /* ================================================================== */
  console.log('\n=== RAGService gating ===');
  const rag = getRAGService();
  assertEqual(rag.isEnabled(), false, 'RAGService disabled by default');
  const retrieved = await rag.retrieve(1, 'login flow');
  assertEqual(Array.isArray(retrieved) && retrieved.length, 0, 'retrieve() returns [] when disabled');
  const sims = await rag.findSimilarTests(1, 'checkout');
  assertEqual(Array.isArray(sims) && sims.length, 0, 'findSimilarTests() returns [] when disabled');
  const fewShot = await rag.buildFewShotBlock(1, 'verify login');
  assertEqual(fewShot.block, '', 'buildFewShotBlock() returns empty block when disabled');
  assertEqual(fewShot.examples.length, 0, 'buildFewShotBlock() returns no examples when disabled');

  /* ------------------------------------------------------------------ */
  console.log(`\n${failed === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test harness crashed:', err);
  process.exit(1);
});
