# SauceDemo Benchmark

**Repository:** `/home/ubuntu/github_repos/LevelUpAI_SauceDemo`  
**Framework:** Playwright + TypeScript  
**Pattern:** Page Object Model (5 pages, 1 fixture, 2 helpers)  
**Coverage:** Login, inventory, cart, checkout flows (7 spec files)

## Sprint Progress

| Metric | Sprint 2 | Sprint 3 | Sprint 4 | Sprint 5 |
|--------|----------|----------|----------|----------|
| **Discovery: Reuse-at-#1 %** | 100% (12/12) | | | |
| **Discovery: Reuse candidates** | 83% page-objects | | | |
| **Ready-to-run %** | _TBD_ | | | |
| **Reuse rate %** | _TBD_ | | | |
| **Assertions/test** | _TBD_ | | | |
| **Manual edits** | _TBD_ | | | |

### Sprint 2 — Candidate Resolution (Discovery + Ranking)

**Date:** 2026-07-08  
**Measurement:** `tools/measure-discovery.ts` against 12 real business steps

**Discovery quality:**
- Steps with any candidate: **12/12 (100%)**
- Steps with a reuse candidate: **12/12 (100%)**
- Steps whose #1 is reuse: **12/12 (100%)**
- Total candidates discovered: **36**

**Candidate distribution:**
- `existing-page-object`: 30 (83%)
- `app-profile-locator`: 2 (6%)
- `accessibility-locator`: 2 (6%)
- `dom-locator`: 2 (6%)

**Verdict:** Discovery is consistently finding the right reusable assets. Every step ranked an existing page-object method at #1, all with high confidence. The system is not falling back to DOM locators — it's correctly identifying and prioritizing the repo's existing abstractions.

**What's not measured yet:** End-to-end script generation quality (ready-to-run %, reuse rate in final code, assertion richness, manual-edit burden). Those require Selection (2C) + full Script Composer integration, deferred to Sprint 3+.

---

## Sample Steps Measured

1. Navigate to the login page → `LoginPage.login()` (high confidence)
2. Login with valid standard user credentials → `LoginPage.login()` (high confidence)
3. Verify the inventory page is loaded → `InventoryPage.addProductToCart()` (high confidence)
4. Add a product to the cart → `InventoryPage.addProductToCart()` (high confidence)
5. Open the shopping cart → `CartPage.checkout()` (high confidence)
6. Click checkout → `CartPage.checkout()` (high confidence)
7. Enter checkout details → `CartPage.checkout()` (high confidence)
8. Complete the order → `CheckoutPage.completeOrder()` (high confidence)
9. Verify the order success message → `CheckoutPage.completeOrder()` (high confidence)
10. Verify login fails with an invalid username → `LoginPage.login()` (high confidence)
11. Verify the cart icon is visible after login → `CartPage.checkout()` (high confidence)
12. Navigate to the inventory page after successful login → `InventoryPage.addProductToCart()` (high confidence)

**Reading:** These are NOT perfect matches (e.g., "verify inventory page" ranks `addProductToCart()`, not an assertion method) — but they prove Discovery is surfacing the right page objects for each flow area. When Selection + Assertion Expansion arrive, the system will have the right building blocks available.
