/* eslint-disable no-console */
/**
 * TOKEN BREAKDOWN DIAGNOSTIC (not shipped)
 * ========================================
 * Answers the ONE question the user asked first: "where are we using tokens?"
 *
 * Runs the REAL deterministic generation pipeline (TestCoverageEngine.
 * generateFullCoverage) for a "User Login" requirement grounded in a realistic
 * 12-page e-commerce application profile + several test-data sets — the exact
 * situation from the Test Case Lab screenshot (5 scenarios / 5 cases /
 * ~9K tokens). The LLM call is STUBBED (zero network, zero cost) so the run is
 * instant and deterministic; the stub returns a realistically-sized completion
 * so the prompt-vs-completion split is representative.
 *
 * It then prints:
 *   (1) the per-section INPUT prompt breakdown (chars, est. tokens, % of prompt)
 *       — BEFORE and AFTER the Prompt Optimizer, so we can see what it saves;
 *   (2) the prompt vs completion split for the whole run.
 */
import { TestCoverageEngine, type KnowledgeContext, type RequirementInput } from '../src/engines/test-coverage-engine';

process.env['OPENAI_API_KEY'] = process.env['OPENAI_API_KEY'] || 'sk-diagnostic-stub';

// ── Realistic 12-page e-commerce application profile ──────────────────────────
function ecommerceProfile() {
  const pages = [
    { url: '/login', title: 'Login', pageType: 'login', elementCount: 6, formCount: 1 },
    { url: '/signup', title: 'Signup', pageType: 'register', elementCount: 8, formCount: 1 },
    { url: '/products', title: 'All Products', pageType: 'catalog', elementCount: 40, formCount: 1 },
    { url: '/product/:id', title: 'Product Detail', pageType: 'product', elementCount: 22, formCount: 1 },
    { url: '/cart', title: 'Shopping Cart', pageType: 'cart', elementCount: 18, formCount: 1 },
    { url: '/checkout', title: 'Checkout', pageType: 'checkout', elementCount: 30, formCount: 2 },
    { url: '/payment', title: 'Payment', pageType: 'payment', elementCount: 16, formCount: 1 },
    { url: '/account', title: 'My Account', pageType: 'account', elementCount: 24, formCount: 2 },
    { url: '/search', title: 'Search Results', pageType: 'search', elementCount: 20, formCount: 1 },
    { url: '/contact', title: 'Contact Us', pageType: 'contact', elementCount: 12, formCount: 1 },
    { url: '/subscribe', title: 'Newsletter', pageType: 'marketing', elementCount: 6, formCount: 1 },
    { url: '/api-list', title: 'API', pageType: 'api', elementCount: 4, formCount: 0 },
  ];
  const forms = [
    { page: '/login', action: '/login', method: 'POST', submitSelector: '[data-qa=login-button]',
      fields: [
        { name: 'email', type: 'email', required: true, selector: '[data-qa=login-email]', label: 'Email Address' },
        { name: 'password', type: 'password', required: true, selector: '[data-qa=login-password]', label: 'Password' },
      ] },
    { page: '/signup', action: '/signup', method: 'POST', submitSelector: '[data-qa=signup-button]',
      fields: [
        { name: 'name', type: 'text', required: true, selector: '[data-qa=signup-name]', label: 'Name' },
        { name: 'email', type: 'email', required: true, selector: '[data-qa=signup-email]', label: 'Email Address' },
      ] },
    { page: '/checkout', action: '/checkout', method: 'POST', submitSelector: '#place-order',
      fields: [
        { name: 'address', type: 'text', required: true, selector: '#addr', label: 'Shipping Address' },
        { name: 'city', type: 'text', required: true, selector: '#city', label: 'City' },
        { name: 'zip', type: 'text', required: true, selector: '#zip', label: 'ZIP' },
      ] },
    { page: '/payment', action: '/pay', method: 'POST', submitSelector: '#pay-now',
      fields: [
        { name: 'card', type: 'text', required: true, selector: '#card', label: 'Card Number' },
        { name: 'cvv', type: 'text', required: true, selector: '#cvv', label: 'CVV' },
        { name: 'expiry', type: 'text', required: true, selector: '#exp', label: 'Expiry' },
      ] },
    { page: '/search', action: '/search', method: 'GET', submitSelector: '#search-btn',
      fields: [{ name: 'q', type: 'search', required: false, selector: '#search', label: 'Search' }] },
    { page: '/contact', action: '/contact', method: 'POST', submitSelector: '#send',
      fields: [
        { name: 'name', type: 'text', required: true, selector: '#c-name', label: 'Name' },
        { name: 'message', type: 'textarea', required: true, selector: '#c-msg', label: 'Message' },
      ] },
    { page: '/subscribe', action: '/subscribe', method: 'POST', submitSelector: '#sub-btn',
      fields: [{ name: 'email', type: 'email', required: true, selector: '#sub-email', label: 'Email' }] },
  ];
  const keyElements = [
    { label: 'Login', tag: 'button', selector: '[data-qa=login-button]', role: 'button' },
    { label: 'Email Address', tag: 'input', selector: '[data-qa=login-email]', role: 'textbox' },
    { label: 'Password', tag: 'input', selector: '[data-qa=login-password]', role: 'textbox' },
    { label: 'Signup', tag: 'button', selector: '[data-qa=signup-button]', role: 'button' },
    { label: 'Add to Cart', tag: 'button', selector: '.add-to-cart', role: 'button' },
    { label: 'Proceed to Checkout', tag: 'button', selector: '#to-checkout', role: 'button' },
    { label: 'Place Order', tag: 'button', selector: '#place-order', role: 'button' },
    { label: 'Pay Now', tag: 'button', selector: '#pay-now', role: 'button' },
    { label: 'Search', tag: 'input', selector: '#search', role: 'searchbox' },
    { label: 'Newsletter Subscribe', tag: 'button', selector: '#sub-btn', role: 'button' },
    { label: 'Contact Send', tag: 'button', selector: '#send', role: 'button' },
    { label: 'Logout', tag: 'a', selector: 'a[href="/logout"]', role: 'link' },
  ];
  return {
    baseUrl: 'https://automationexercise.com', name: 'Automation Exercise',
    pageCount: pages.length, totalElements: 210, totalForms: forms.length,
    loginUrl: 'https://automationexercise.com/login', username: 'tester@example.com',
    pages, forms, keyElements,
  };
}

function knowledge(): KnowledgeContext {
  return {
    applicationProfile: ecommerceProfile(),
    testData: [
      { name: 'valid_users', environment: 'staging', recordCount: 20, sampleKeys: ['email', 'password', 'role'] },
      { name: 'locked_users', environment: 'staging', recordCount: 5, sampleKeys: ['email', 'password', 'status'] },
      { name: 'checkout_data', environment: 'staging', recordCount: 12, sampleKeys: ['address', 'city', 'zip'] },
      { name: 'payment_cards', environment: 'staging', recordCount: 8, sampleKeys: ['card', 'cvv', 'expiry'] },
      { name: 'search_terms', environment: 'staging', recordCount: 30, sampleKeys: ['query', 'expectedCount'] },
      { name: 'products', environment: 'staging', recordCount: 100, sampleKeys: ['sku', 'name', 'price'] },
    ],
    enterpriseKnowledge: [
      { id: 1, category: 'Authentication', title: 'Account lockout policy',
        description: 'Accounts lock for 15 minutes after 5 consecutive failed login attempts. A locked account shows "Your account is temporarily locked".',
        tags: ['login', 'security', 'lockout'], relatedModules: ['auth'], priority: 'high' },
      { id: 2, category: 'Authentication', title: 'Session policy',
        description: 'Sessions expire after 30 minutes of inactivity. Remember-me extends to 14 days.',
        tags: ['session', 'login'], relatedModules: ['auth'], priority: 'medium' },
      { id: 3, category: 'Checkout', title: 'Guest checkout',
        description: 'Guests may checkout without an account but must provide a valid email for the receipt.',
        tags: ['checkout', 'guest'], relatedModules: ['checkout'], priority: 'medium' },
      { id: 4, category: 'Payment', title: 'Card validation',
        description: 'Card numbers are validated with the Luhn algorithm; CVV must be 3-4 digits.',
        tags: ['payment', 'card'], relatedModules: ['payment'], priority: 'high' },
    ],
  };
}

const requirement: RequirementInput = {
  title: 'User Login',
  jiraId: 'REQ-001',
  module: 'Authentication',
  description: 'The system should allow registered users to log in using their email address and password. After successful authentication, users should be redirected to the home page. Invalid credentials should show a clear error message.',
  acceptanceCriteria: [
    'Given a registered user with valid credentials, when they submit the login form, then they are authenticated and redirected to the home page.',
    'Given an unregistered email, when the user submits login, then an "email or password is incorrect" error is shown.',
    'Given a valid email with the wrong password, when the user submits login, then the same generic error is shown.',
    'Given empty email or password, when the user submits, then inline validation blocks submission.',
  ].join('\n'),
  businessFlow: 'Login → Home',
};

// A realistically-sized completion (5 scenarios / 5 cases) matching the screenshot.
function stubbedCompletion(): string {
  const tc = (i: number, cov: string, src: string) => ({
    title: `Login case ${i} (${cov})`,
    objective: `Verify login behaviour ${i} for ${cov} coverage grounded in the requirement.`,
    scenarioIndex: i - 1, riskArea: 'Authentication / unauthorized access',
    preconditions: 'A registered user account exists in the valid_users dataset and the login page is reachable.',
    steps: ['Navigate to /login', 'Enter the email address', 'Enter the password', 'Click the Login button', 'Observe the result'],
    expectedResult: 'The user is authenticated and redirected to the home page, or a clear error is shown for invalid input.',
    testData: 'valid_users: email/password',
    priority: 'P0', severity: 'critical', tags: ['login', cov], automationReady: true,
    automationComplexity: 'low', selectorAvailability: 'high', source: src, sourceEvidence: 'AC: valid login',
  });
  return JSON.stringify({
    scenarios: [
      { scenario: 'Valid login with correct credentials', objective: 'Prove a registered user can log in.', coverageType: 'positive', priority: 'P0', riskArea: 'Authentication' },
      { scenario: 'Login with unregistered email', objective: 'Prove unknown users are rejected.', coverageType: 'negative', priority: 'P0', riskArea: 'Authentication' },
      { scenario: 'Login with wrong password', objective: 'Prove wrong password is rejected.', coverageType: 'negative', priority: 'P0', riskArea: 'Authentication' },
      { scenario: 'Empty email or password', objective: 'Prove inline validation blocks submit.', coverageType: 'edge_cases', priority: 'P1', riskArea: 'Input validation' },
      { scenario: 'Whitespace / case handling in email', objective: 'Prove email is normalized.', coverageType: 'edge_cases', priority: 'P2', riskArea: 'Input validation' },
    ],
    testCases: [tc(1, 'positive', 'requirement'), tc(2, 'negative', 'requirement'), tc(3, 'negative', 'requirement'), tc(4, 'edge_cases', 'requirement'), tc(5, 'edge_cases', 'knowledge')],
    coverageTypeEvaluations: [
      { coverageType: 'positive', status: 'covered', reason: '' },
      { coverageType: 'negative', status: 'covered', reason: '' },
      { coverageType: 'edge_cases', status: 'covered', reason: '' },
    ],
    suggestedTestCases: [], missingRequirements: [],
  });
}

function pad(s: string, n: number): string { return s.length >= n ? s : s + ' '.repeat(n - s.length); }

function printBreakdown(title: string, bd: any) {
  console.log(`\n${title}`);
  console.log('  ' + pad('SECTION', 26) + pad('CHARS', 10) + pad('EST.TOKENS', 12) + '% OF PROMPT');
  console.log('  ' + '-'.repeat(60));
  for (const s of bd.sections) {
    console.log('  ' + pad(s.label, 26) + pad(String(s.chars), 10) + pad(String(s.estimatedTokens), 12) + `${s.pctOfPrompt}%`);
  }
  console.log('  ' + '-'.repeat(60));
  console.log('  ' + pad('TOTAL (input prompt)', 26) + pad(String(bd.totalChars), 10) + pad(String(bd.totalEstimatedTokens), 12) + '100%');
}

async function run(label: string, optimizerOn: boolean) {
  process.env['GEN_PROMPT_OPTIMIZER'] = optimizerOn ? 'true' : 'false';
  const engine = new TestCoverageEngine();
  // Stub the private LLM call — zero network, representative completion size.
  // Detect the analysis round-trip vs the generation call by the prompt text.
  const analysisJson = JSON.stringify({
    featureType: 'authentication', riskLevel: 'critical',
    businessCriticality: 'Login gates all authenticated functionality.',
    impactedModules: ['auth', 'session'], userRolesAffected: ['registered_user'],
    apiDependencies: ['/login'], dbImpact: 'Reads users table', workflowSteps: ['Login', 'Home'],
    summary: 'Registered users authenticate with email + password.',
  });
  (engine as any).callLLM = async (prompt: string) => {
    const content = /Analyze this requirement and return a JSON object/.test(prompt)
      ? analysisJson
      : stubbedCompletion();
    const promptTokens = Math.round(prompt.length / 4);
    const completionTokens = Math.round(content.length / 4);
    return { content, tokensUsed: promptTokens + completionTokens, promptTokens, completionTokens };
  };

  const result = await engine.generateFullCoverage(
    requirement, ['positive', 'negative', 'edge_cases'], knowledge(),
    { includeCoverageGaps: false },
  );
  const md = result.stats.generationMetadata!;
  console.log(`\n${'═'.repeat(64)}\n${label}\n${'═'.repeat(64)}`);
  printBreakdown('INPUT PROMPT BREAKDOWN (per section):', md.promptBreakdown);
  const opt = md.promptOptimization;
  if (opt) {
    console.log(`\n  Prompt Optimizer: applied=${opt.applied} category=${opt.category} confidence=${opt.confidence}`);
    console.log(`    pages ${opt.pages.before}→${opt.pages.after}  forms ${opt.forms.before}→${opt.forms.after}  elements ${opt.elements.before}→${opt.elements.after}  testData ${opt.testData.before}→${opt.testData.after}`);
    console.log(`    reason: ${opt.reason}`);
  }
  console.log(`\n  TOKEN SPLIT (whole run):`);
  console.log(`    prompt (input)     : ${result.stats.promptTokens}`);
  console.log(`    completion (output): ${result.stats.completionTokens}`);
  console.log(`    total              : ${result.stats.tokensUsed}`);
  console.log(`    est. cost (USD)    : ${result.stats.estimatedCostUsd}`);
  console.log(`  Scenarios: ${result.stats.totalScenarios}  Test cases: ${result.stats.totalTestCases}  (coverage is the product — never trimmed)`);
  return result;
}

// Single run per process — PROMPT_OPTIMIZER_ENABLED is a module-level const
// frozen at import, so the toggle must come from the real environment. Invoke
// this script twice (GEN_PROMPT_OPTIMIZER=false then =true) for an honest
// before/after.
(async () => {
  const on = (process.env['GEN_PROMPT_OPTIMIZER'] || 'true').toLowerCase() !== 'false';
  await run(on
    ? 'Prompt Optimizer ON (QA-first: category-relevant grounding only)'
    : 'Prompt Optimizer OFF (legacy: full 12-page profile + all 6 test-data sets)', on);
})().catch((e) => { console.error(e); process.exit(1); });
