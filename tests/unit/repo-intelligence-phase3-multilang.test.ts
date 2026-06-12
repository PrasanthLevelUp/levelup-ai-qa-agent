/**
 * Repository Intelligence Phase 3 — REAL multi-language parsing (flags ON).
 *
 * This suite sets ENABLE_MULTI_LANGUAGE=true BEFORE importing any project
 * module, because the feature flag is evaluated once at features.ts import time
 * and then frozen. With the flag live, it verifies the MultiLanguageAnalyzer
 * actually parses Java / Python / C# via the tree-sitter grammars.
 *
 * If the optional native grammars are not installed, the analyzer reports
 * unavailable and the suite SKIPS its assertions (a missing optional native
 * dependency must not fail CI).
 *
 * Run with: npx tsx tests/unit/repo-intelligence-phase3-multilang.test.ts
 */

// Set the flag BEFORE any project module is imported. ES `import` statements
// are hoisted and evaluated before module-body code, so we use dynamic
// `import()` *inside* main() (after the assignment) to guarantee features.ts
// reads the enabled flag.
process.env.ENABLE_MULTI_LANGUAGE = 'true';

let passed = 0;
let failed = 0;
function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

async function main() {
  process.env.ENABLE_MULTI_LANGUAGE = 'true';
  const { FEATURE_FLAGS } = await import('../../src/config/features');
  const { MultiLanguageAnalyzer } = await import('../../src/context/multi-language-analyzer');

  console.log('\n=== MultiLanguageAnalyzer real parsing (ENABLE_MULTI_LANGUAGE=true) ===');
  assert(FEATURE_FLAGS.REPO_INTELLIGENCE.MULTI_LANGUAGE === true, 'MULTI_LANGUAGE flag is live in this process');

  const analyzer = new MultiLanguageAnalyzer();
  if (!analyzer.isAvailable('java')) {
    console.log('  ⏭️  SKIP — tree-sitter grammars not installed (optional native dependency)');
    console.log(`\n✅ ALL PASSED — ${passed} passed, ${failed} failed (multi-language parsing skipped)\n`);
    process.exit(failed === 0 ? 0 : 1);
  }

  const java = `package x;
import org.junit.jupiter.api.Test;
import org.openqa.selenium.WebDriver;
public class LoginPage extends BasePage {
  public void login(String user, String pass) { driver.click(); }
  @Test public void testLogin() { login("a","b"); }
}`;
  const jr = analyzer.analyzeSource(java, 'java');
  assert(jr.available, 'JAVA: analysis available');
  assert(jr.classes.some(c => c.name === 'LoginPage' && c.baseClass === 'BasePage'), 'JAVA: class + superclass extracted');
  assert(jr.methods.some(m => m.name === 'login' && m.className === 'LoginPage'), 'JAVA: method + enclosing class extracted');
  assert(jr.frameworks.includes('JUnit5'), 'JAVA: JUnit5 detected');
  assert(!jr.frameworks.includes('JUnit4'), 'JAVA: JUnit4 NOT falsely detected for jupiter imports');
  assert(jr.frameworks.includes('Selenium'), 'JAVA: Selenium detected');
  assert(jr.imports.length === 2, 'JAVA: two imports captured');

  const py = `import pytest
from selenium import webdriver
class LoginTests:
    def test_login(self, user):
        self.click()
def helper_login(driver):
    pass`;
  const pr = analyzer.analyzeSource(py, 'python');
  assert(pr.available, 'PYTHON: analysis available');
  assert(pr.classes.some(c => c.name === 'LoginTests'), 'PYTHON: class extracted');
  assert(pr.methods.some(m => m.name === 'helper_login' && m.className === null), 'PYTHON: standalone function (no class) extracted');
  assert(pr.methods.some(m => m.name === 'test_login' && m.className === 'LoginTests'), 'PYTHON: method inside class extracted');
  assert(pr.frameworks.includes('pytest'), 'PYTHON: pytest detected');
  assert(pr.frameworks.includes('Selenium'), 'PYTHON: selenium detected');

  const cs = `using NUnit.Framework;
using OpenQA.Selenium;
namespace App {
  public class LoginPage : BasePage {
    public void Login(string user) { }
    [Test] public void TestLogin() { }
  }
}`;
  const cr = analyzer.analyzeSource(cs, 'csharp');
  assert(cr.available, 'C#: analysis available');
  assert(cr.classes.some(c => c.name === 'LoginPage'), 'C#: class extracted');
  assert(cr.methods.some(m => m.name === 'Login'), 'C#: method extracted');
  assert(cr.frameworks.includes('NUnit'), 'C#: NUnit detected');
  assert(cr.frameworks.includes('Selenium'), 'C#: Selenium detected');

  console.log(`\n${failed === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test harness crashed:', err);
  process.exit(1);
});
