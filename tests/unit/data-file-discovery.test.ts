/**
 * Data File Discovery Tests (PR #122)
 *
 * Verifies that the Repository Context Engine correctly discovers test data files
 * in the data/ folder and that the Framework Auditor transforms them correctly.
 *
 * Tests the integration loop:
 *   Test Data Store (PR #119) → materializeTestData() writes data/*.json
 *   → Repo Intelligence scans data/ folder (this PR)
 *   → Framework Auditor reports discovered files
 *   → Script Generation references them
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// We'll test the discovery logic by scanning a temporary repository
async function runTests() {
  console.log('=== Data File Discovery Tests (PR #122) ===\n');

  // Import after console.log to avoid early initialization
  const { RepositoryContextEngine } = await import('../../src/context/repository-context-engine');
  const { auditFramework } = await import('../../src/script-gen/framework-auditor');

  let testRepoPath: string | null = null;

  try {
    // Create a temporary test repository
    testRepoPath = path.join(os.tmpdir(), `test-repo-data-discovery-${Date.now()}`);
    fs.mkdirSync(testRepoPath, { recursive: true });

    // Create a minimal package.json to make it a valid repo
    fs.writeFileSync(
      path.join(testRepoPath, 'package.json'),
      JSON.stringify({
        name: 'test-repo',
        dependencies: { '@playwright/test': '^1.40.0' },
      }),
      'utf-8'
    );

    // Test 1: No data/ directory
    console.log('Test 1: No data/ directory → empty dataFiles array');
    const engine = new RepositoryContextEngine();
    let result = engine.scan(testRepoPath);
    assert.strictEqual(
      result.profile.dataFiles.length,
      0,
      'dataFiles should be empty when data/ directory does not exist'
    );
    console.log('✅ PASS\n');

    // Test 2: Empty data/ directory
    console.log('Test 2: Empty data/ directory → empty dataFiles array');
    const dataDir = path.join(testRepoPath, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    result = engine.scan(testRepoPath);
    assert.strictEqual(
      result.profile.dataFiles.length,
      0,
      'dataFiles should be empty when data/ directory is empty'
    );
    console.log('✅ PASS\n');

    // Test 3: JSON array file with record count
    console.log('Test 3: JSON array file → discovered with record count');
    fs.writeFileSync(
      path.join(dataDir, 'valid_users.json'),
      JSON.stringify([
        { key: 'admin', value: { email: 'admin@test.com', password: 'secret' } },
        { key: 'user1', value: { email: 'user1@test.com', password: 'secret' } },
        { key: 'user2', value: { email: 'user2@test.com', password: 'secret' } },
      ]),
      'utf-8'
    );
    result = engine.scan(testRepoPath);
    assert.strictEqual(result.profile.dataFiles.length, 1, 'Should discover 1 JSON file');
    const validUsers = result.profile.dataFiles.find(df => df.name === 'valid_users');
    assert.ok(validUsers, 'valid_users file should be discovered');
    assert.strictEqual(validUsers!.type, 'json', 'File type should be json');
    assert.strictEqual(validUsers!.recordCount, 3, 'Should count 3 records in array');
    assert.strictEqual(validUsers!.path, 'data/valid_users.json', 'Path should be relative to repo root');
    console.log('✅ PASS\n');

    // Test 4: JSON object file with key count
    console.log('Test 4: JSON object file → discovered with key count as record count');
    fs.writeFileSync(
      path.join(dataDir, 'config.json'),
      JSON.stringify({
        apiUrl: 'https://api.test.com',
        timeout: 5000,
        retries: 3,
      }),
      'utf-8'
    );
    result = engine.scan(testRepoPath);
    assert.strictEqual(result.profile.dataFiles.length, 2, 'Should discover 2 JSON files');
    const config = result.profile.dataFiles.find(df => df.name === 'config');
    assert.ok(config, 'config file should be discovered');
    assert.strictEqual(config!.recordCount, 3, 'Should count 3 keys in object');
    console.log('✅ PASS\n');

    // Test 5: TypeScript file (no record count)
    console.log('Test 5: TypeScript file → discovered without record count');
    fs.writeFileSync(
      path.join(dataDir, 'test-data.ts'),
      `export const users = [{ email: 'test@test.com' }];`,
      'utf-8'
    );
    result = engine.scan(testRepoPath);
    assert.strictEqual(result.profile.dataFiles.length, 3, 'Should discover 3 files (2 JSON + 1 TS)');
    const tsFile = result.profile.dataFiles.find(df => df.name === 'test-data');
    assert.ok(tsFile, 'test-data.ts file should be discovered');
    assert.strictEqual(tsFile!.type, 'ts', 'File type should be ts');
    assert.strictEqual(tsFile!.recordCount, undefined, 'TS files should not have record count');
    console.log('✅ PASS\n');

    // Test 6: JavaScript file (no record count)
    console.log('Test 6: JavaScript file → discovered without record count');
    fs.writeFileSync(
      path.join(dataDir, 'fixtures.js'),
      `module.exports = { users: [] };`,
      'utf-8'
    );
    result = engine.scan(testRepoPath);
    assert.strictEqual(result.profile.dataFiles.length, 4, 'Should discover 4 files');
    const jsFile = result.profile.dataFiles.find(df => df.name === 'fixtures');
    assert.ok(jsFile, 'fixtures.js file should be discovered');
    assert.strictEqual(jsFile!.type, 'js', 'File type should be js');
    console.log('✅ PASS\n');

    // Test 7: CSV file (no record count)
    console.log('Test 7: CSV file → discovered without record count');
    fs.writeFileSync(
      path.join(dataDir, 'test-data.csv'),
      `email,password\ntest@test.com,secret\nuser@test.com,secret2`,
      'utf-8'
    );
    result = engine.scan(testRepoPath);
    assert.strictEqual(result.profile.dataFiles.length, 5, 'Should discover 5 files');
    const csvFile = result.profile.dataFiles.find(df => df.name === 'test-data');
    assert.ok(csvFile, 'test-data.csv file should be discovered');
    assert.strictEqual(csvFile!.type, 'csv', 'File type should be csv');
    console.log('✅ PASS\n');

    // Test 8: Invalid JSON file → still discovered but without count
    console.log('Test 8: Invalid JSON file → discovered without record count');
    fs.writeFileSync(
      path.join(dataDir, 'broken.json'),
      `{ invalid json syntax }`,
      'utf-8'
    );
    result = engine.scan(testRepoPath);
    assert.strictEqual(result.profile.dataFiles.length, 6, 'Should discover 6 files including broken JSON');
    const brokenFile = result.profile.dataFiles.find(df => df.name === 'broken');
    assert.ok(brokenFile, 'broken.json file should be discovered');
    assert.strictEqual(brokenFile!.type, 'json', 'File type should still be json');
    assert.strictEqual(brokenFile!.recordCount, undefined, 'Broken JSON should not have record count');
    console.log('✅ PASS\n');

    // Test 9: Non-data files in data/ → ignored
    console.log('Test 9: Non-data files in data/ directory → ignored');
    fs.writeFileSync(path.join(dataDir, 'README.md'), '# Data files', 'utf-8');
    fs.writeFileSync(path.join(dataDir, 'notes.txt'), 'Some notes', 'utf-8');
    result = engine.scan(testRepoPath);
    assert.strictEqual(
      result.profile.dataFiles.length,
      6,
      'Should still have 6 files (README.md and notes.txt ignored)'
    );
    console.log('✅ PASS\n');

    // Test 10: Framework Auditor transforms dataFiles correctly
    console.log('Test 10: Framework Auditor transforms profile.dataFiles to DataFileInfo');
    const audit = await auditFramework(
      result.profile,
      { type: 'test-script', targetUrl: 'https://test.com', testName: 'test' },
      { companyId: 1, projectId: 1, repositoryId: 1 }
    );
    assert.ok(audit.inventory.dataFiles, 'Audit inventory should have dataFiles field');
    assert.strictEqual(audit.inventory.dataFiles.length, 6, 'Audit should report 6 data files');
    
    const auditedUsers = audit.inventory.dataFiles.find(df => df.name === 'valid_users');
    assert.ok(auditedUsers, 'valid_users should be in audit');
    assert.strictEqual(auditedUsers!.type, 'json', 'Type should be preserved');
    assert.strictEqual(auditedUsers!.path, 'data/valid_users.json', 'Path should be preserved');
    assert.ok(
      auditedUsers!.purpose.includes('user credentials'),
      'Purpose should be inferred from filename (contains "user")'
    );
    assert.ok(
      auditedUsers!.purpose.includes('3 records'),
      'Purpose should include record count'
    );
    console.log('✅ PASS\n');

    // Test 11: Framework Auditor purpose inference
    console.log('Test 11: Framework Auditor infers purpose from filename');
    const auditedConfig = audit.inventory.dataFiles.find(df => df.name === 'config');
    assert.ok(
      auditedConfig && auditedConfig.purpose.includes('configuration'),
      'config file should be inferred as configuration'
    );
    const auditedFixtures = audit.inventory.dataFiles.find(df => df.name === 'fixtures');
    assert.ok(
      auditedFixtures && auditedFixtures.purpose === 'test data',
      'Generic files should be labeled as test data'
    );
    console.log('✅ PASS\n');

    console.log('=== All 11 tests passed! ===');
  } catch (err: any) {
    console.error('❌ Test failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    // Clean up
    if (testRepoPath) {
      try {
        fs.rmSync(testRepoPath, { recursive: true, force: true });
      } catch {
        /* cleanup errors are non-critical */
      }
    }
  }
}

runTests();
