/**
 * Focused tests for the centralized auth config (src/config/auth.ts).
 *
 * The secret is resolved at MODULE LOAD, so each scenario is exercised in a
 * fresh child process with a different environment, loading the config via a
 * temporary probe file (a real .ts import — reliable under tsx). Run with:
 *   npx tsx tests/unit/auth-config.test.ts
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const CONFIG = path.resolve(__dirname, '../../src/config/auth.ts');
// Probe files live INSIDE the repo so Node resolves node_modules (e.g.
// jsonwebtoken) via the normal upward lookup; /tmp has no node_modules.
const TMP = fs.mkdtempSync(path.resolve(__dirname, '../../.authcfg-tmp-'));
let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

function runProbe(body: string, env: Record<string, string | undefined>) {
  const file = path.join(TMP, `probe-${Math.random().toString(36).slice(2)}.ts`);
  fs.writeFileSync(file, body);
  const res = spawnSync('npx', ['tsx', file], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  let parsed: any = {};
  try { parsed = JSON.parse((res.stdout || '').trim()); } catch { /* leave empty */ }
  return { parsed, stderr: res.stderr || '', status: res.status };
}

// Probe that simply loads the config and reports its exported values.
const LOAD_BODY = `
import * as cfg from ${JSON.stringify(CONFIG)};
process.stdout.write(JSON.stringify({ ok: true, secret: cfg.JWT_SECRET, cookie: cfg.COOKIE_NAME, expiry: cfg.JWT_EXPIRY }));
`;

console.log('auth-config: production fail-fast');
{
  const unset = runProbe(LOAD_BODY, { NODE_ENV: 'production', JWT_SECRET: undefined });
  check('throws (non-zero exit) when JWT_SECRET unset in production', unset.parsed.ok !== true && unset.status !== 0, JSON.stringify(unset));
  check('error mentions JWT_SECRET', /JWT_SECRET/.test(unset.stderr), unset.stderr.slice(0, 160));

  const short = runProbe(LOAD_BODY, { NODE_ENV: 'production', JWT_SECRET: 'tooshort' });
  check('throws when JWT_SECRET too short in production', short.parsed.ok !== true && short.status !== 0, JSON.stringify(short));

  const strong = 'a'.repeat(48);
  const good = runProbe(LOAD_BODY, { NODE_ENV: 'production', JWT_SECRET: strong });
  check('boots when a strong JWT_SECRET is set in production', good.parsed.ok === true, JSON.stringify(good.parsed));
  check('uses the configured secret verbatim', good.parsed.secret === strong, good.parsed.secret);
}

console.log('auth-config: development fallback');
{
  const dev = runProbe(LOAD_BODY, { NODE_ENV: 'development', JWT_SECRET: undefined });
  check('does NOT throw in development without JWT_SECRET', dev.parsed.ok === true, JSON.stringify(dev.parsed));
  check('returns a non-empty dev fallback secret', !!dev.parsed.secret && dev.parsed.secret.length > 0);
  check('logs a loud warning about the insecure fallback', /WARNING/.test(dev.stderr) && /JWT_SECRET/.test(dev.stderr), dev.stderr.slice(0, 160));
  check('exports the expected cookie name', dev.parsed.cookie === 'levelup_session', dev.parsed.cookie);
}

console.log('auth-config: sign/verify round-trip with one shared secret');
{
  const strong = 'b'.repeat(48);
  const body = `
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from ${JSON.stringify(CONFIG)};
const token = jwt.sign({ userId: 1 }, JWT_SECRET, { expiresIn: '24h' });
const decoded: any = jwt.verify(token, JWT_SECRET);
let mismatchRejected = false;
try { jwt.verify(jwt.sign({ userId: 1 }, 'a-different-secret'), JWT_SECRET); }
catch { mismatchRejected = true; }
process.stdout.write(JSON.stringify({ ok: true, userId: decoded.userId, mismatchRejected }));
`;
  const rt = runProbe(body, { NODE_ENV: 'production', JWT_SECRET: strong });
  check('token signed and verified with the shared secret', rt.parsed.ok === true && rt.parsed.userId === 1, JSON.stringify(rt.parsed) + rt.stderr.slice(0, 120));
  check('token signed with a different secret is rejected', rt.parsed.mismatchRejected === true, JSON.stringify(rt.parsed));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\nauth-config: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
