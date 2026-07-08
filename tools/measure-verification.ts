/**
 * Sprint 3A measurement harness — Verification Standards → Composer integration.
 *
 * Honest, SauceDemo-only. Measures the *delta* the deterministic verification
 * plan adds when folded into the Script Composer's assertion injection:
 *   BEFORE = the ad-hoc assertion rules only (navigate→title, login→postLogin,
 *            assert→pageType) — i.e. the "URL/text → done" default.
 *   AFTER  = the same ad-hoc base + enrichWithVerificationStandards().
 *
 * Reports assertions/test and tier coverage, per step and in aggregate, so a
 * reviewer can see exactly what stronger evidence the plan bought us.
 *
 * Run:  npx ts-node tools/measure-verification.ts
 */
import { ScriptGenEngine } from '../src/script-gen/script-gen-engine';
import { planVerifications, verificationTiersInOrder } from '../src/script-gen/verification-standards';

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

  // Tier coverage from the rule library (what evidence classes the plan asks for).
  const tierHits = new Map<string, number>();
  for (const s of STEPS) {
    const plan = planVerifications(s as any, {
      pageObjectMembers: pageObjects.flatMap(po => [...po.actions.map(a => a.name), ...po.locators.map(l => l.name)]),
      existingAssertions: [],
    });
    for (const it of plan.intents) tierHits.set(it.tier, (tierHits.get(it.tier) || 0) + 1);
  }

  console.log('\n=== Sprint 3A — Verification Standards → Composer (SauceDemo, 12 steps) ===\n');
  console.log('Per-step assertions (BEFORE → AFTER):');
  for (let i = 0; i < STEPS.length; i++) {
    const b = before[i]!.assertions?.length || 0;
    const a = after[i]!.assertions?.length || 0;
    const cat = planVerifications(STEPS[i]! as any).category;
    console.log(
      `  ${String(i + 1).padStart(2)}. ${STEPS[i]!.action.padEnd(9)} [${cat.padEnd(14)}] ${b} → ${a}` +
        (a > b ? `  (+${a - b})` : ''),
    );
  }

  console.log('\nAssertions in the journey (this journey = one "test"):');
  console.log(`  BEFORE (ad-hoc only): ${beforeTotal} assertions`);
  console.log(`  AFTER  (with plan)  : ${afterTotal} assertions`);
  const pct = beforeTotal > 0 ? (((afterTotal - beforeTotal) / beforeTotal) * 100).toFixed(0) : 'n/a';
  console.log(`  Delta               : +${afterTotal - beforeTotal} assertions  (+${pct}%)`);
  const checkpoints = STEPS.filter(s => ['click', 'press', 'assert'].includes(s.action)).length;
  console.log(`  Checkpoints enriched: ${checkpoints} of ${STEPS.length} steps (fills/navigations left clean)`);

  console.log('\nTier coverage across the journey (strength ⭐ from the frozen table):');
  for (const t of verificationTiersInOrder()) {
    const hits = tierHits.get(t.tier) || 0;
    console.log(`  ${'⭐'.repeat(t.strength).padEnd(5)} ${t.tier.padEnd(18)} used in ${hits} step(s)`);
  }

  const stepsWithOutcome = STEPS.filter(s => planVerifications(s as any).intents.some(i => i.tier === 'business-outcome')).length;
  console.log(`\nSteps now carrying a business-outcome proof: ${stepsWithOutcome}/${STEPS.length}`);
  console.log('');
}

main();
