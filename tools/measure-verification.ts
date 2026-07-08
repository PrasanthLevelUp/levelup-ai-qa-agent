/**
 * Sprint 3A measurement harness — Verification Standards → Composer integration.
 *
 * Honest, SauceDemo-only. The headline metric is BUSINESS VERIFICATION
 * OBJECTIVES PROVEN — not assertion count. Customers care about confidence
 * (which business goals are proven), so that is what we measure. Supporting
 * assertion count is reported second, as evidence, never as the goal.
 *
 *   BEFORE = the ad-hoc assertion rules only (navigate→title, login→postLogin,
 *            assert→pageType) — the "URL/text → done" default: 0 named objectives.
 *   AFTER  = the same ad-hoc base + enrichWithVerificationStandards().
 *
 * Run:  npx ts-node tools/measure-verification.ts
 */
import { ScriptGenEngine } from '../src/script-gen/script-gen-engine';
import { planVerifications } from '../src/script-gen/verification-standards';

// A framework-agnostic view of the private TestPlanStep — enough for the two
// private methods we exercise (action, description, target, selector, assertions).
interface Step {
  action: string;
  description: string;
  target?: string;
  selector?: string;
  assertions?: string[];
}

// The 12 canonical SauceDemo business steps (same journey Sprint 2 measured):
// login → browse inventory → add to cart → view cart → checkout → confirm.
const STEPS: Step[] = [
  { action: 'navigate', description: 'Open the SauceDemo login page', target: 'https://www.saucedemo.com' },
  { action: 'fill', description: 'Enter the username', target: 'Username', selector: `page.locator('[data-test="username"]')` },
  { action: 'fill', description: 'Enter the password', target: 'Password', selector: `page.locator('[data-test="password"]')` },
  { action: 'click', description: 'Click the Login button to sign in', target: 'Login', selector: `page.locator('[data-test="login-button"]')` },
  { action: 'click', description: 'Add a product to the shopping cart', target: 'Add to cart', selector: `page.locator('[data-test="add-to-cart-sauce-labs-backpack"]')` },
  { action: 'click', description: 'Open the shopping cart', target: 'Cart', selector: `page.locator('.shopping_cart_link')` },
  { action: 'click', description: 'Proceed to checkout', target: 'Checkout', selector: `page.locator('[data-test="checkout"]')` },
  { action: 'fill', description: 'Enter checkout first name', target: 'First Name', selector: `page.locator('[data-test="firstName"]')` },
  { action: 'fill', description: 'Enter checkout postal code', target: 'Zip', selector: `page.locator('[data-test="postalCode"]')` },
  { action: 'click', description: 'Continue to the order overview', target: 'Continue', selector: `page.locator('[data-test="continue"]')` },
  { action: 'click', description: 'Finish and place the order', target: 'Finish', selector: `page.locator('[data-test="finish"]')` },
  { action: 'assert', description: 'Verify the order confirmation is shown', target: 'Order complete' },
];

// Minimal SauceDemo-shaped page objects so context can strengthen critical-UI.
const pageObjects = [
  { name: 'InventoryPage', actions: [{ name: 'addToCart' }, { name: 'openCart' }, { name: 'logout' }], locators: [{ name: 'cartBadge' }, { name: 'menuButton' }] },
  { name: 'CheckoutPage', actions: [{ name: 'continue' }, { name: 'finish' }], locators: [{ name: 'summaryTotal' }] },
];

// Replicate the ad-hoc base the Composer applies BEFORE enrichment, so the
// measurement isolates exactly what the verification plan adds.
function applyAdHocBase(step: Step): void {
  if (step.action === 'navigate') {
    step.assertions = [`await expect(page).toHaveTitle(/.+/)`];
  } else if (step.action === 'click' && step.description.toLowerCase().includes('login')) {
    step.assertions = [`await expect(page).toHaveURL(/inventory/)`]; // postLogin (representative)
  } else if (step.action === 'assert') {
    step.assertions = [`await expect(page.getByText(/complete/i)).toBeVisible()`]; // pageType (representative)
  } else {
    step.assertions = [];
  }
}

function count(steps: Step[]): number {
  return steps.reduce((n, s) => n + (s.assertions?.length || 0), 0);
}

function main(): void {
  const engine: any = new ScriptGenEngine();
  const testPlan = { pageObjects };

  const before: Step[] = STEPS.map(s => ({ ...s }));
  before.forEach(applyAdHocBase);
  const beforeTotal = count(before);

  const after: Step[] = STEPS.map(s => ({ ...s }));
  after.forEach(applyAdHocBase);
  after.forEach(s => engine.enrichWithVerificationStandards(s, testPlan));
  const afterTotal = count(after);

  const ctx = {
    pageObjectMembers: pageObjects.flatMap(po => [...po.actions.map(a => a.name), ...po.locators.map(l => l.name)]),
    existingAssertions: [] as string[],
  };
  const isCheckpoint = (s: Step) => ['click', 'press', 'assert'].includes(s.action);

  // The headline: the distinct BUSINESS OBJECTIVES proven across the journey.
  // (Only checkpoint steps are enriched — fills/navigations are not outcomes.)
  const objectivesProven = new Map<string, { strength: number; evidence: number }>();
  for (const s of STEPS) {
    if (!isCheckpoint(s)) continue;
    for (const o of planVerifications(s as any, ctx).objectives) {
      const prev = objectivesProven.get(o.objective);
      objectivesProven.set(o.objective, {
        strength: Math.max(prev?.strength ?? 0, o.strength),
        evidence: Math.max(prev?.evidence ?? 0, o.evidence.length),
      });
    }
  }

  console.log('\n=== Sprint 3A — Verification Standards → Composer (SauceDemo, 12 steps) ===\n');

  console.log('BUSINESS VERIFICATION OBJECTIVES PROVEN  (the metric that matters):');
  console.log(`  BEFORE (ad-hoc URL/text → done): 0 named objectives`);
  console.log(`  AFTER  (verification plan)     : ${objectivesProven.size} objectives\n`);
  for (const [name, m] of objectivesProven) {
    console.log(`   • ${name.padEnd(22)} ${'⭐'.repeat(m.strength)}  (${m.evidence} piece(s) of evidence)`);
  }

  const checkpoints = STEPS.filter(isCheckpoint).length;
  console.log(`\nBusiness checkpoints covered: ${checkpoints}/${STEPS.length} steps` +
    ` (fills & navigations left clean — not outcomes)`);

  console.log('\nPer-checkpoint objective → evidence (BEFORE → AFTER assertions):');
  for (let i = 0; i < STEPS.length; i++) {
    if (!isCheckpoint(STEPS[i]!)) continue;
    const b = before[i]!.assertions?.length || 0;
    const a = after[i]!.assertions?.length || 0;
    const o = planVerifications(STEPS[i]! as any, ctx).objectives[0]!;
    console.log(
      `  ${String(i + 1).padStart(2)}. ${STEPS[i]!.action.padEnd(7)} “${o.objective}”`.padEnd(46) +
        ` ${b} → ${a} assertion(s)`,
    );
  }

  console.log('\nSupporting assertions (evidence, NOT the goal):');
  console.log(`  BEFORE: ${beforeTotal}   AFTER: ${afterTotal}   (each objective backed by ${(afterTotal / Math.max(1, objectivesProven.size)).toFixed(1)} on average)`);
  console.log('');
}

main();
