/**
 * Unit tests for the Requirement Capability Detector.
 *
 * The detector is PURE + deterministic (zero LLM tokens): given a requirement's
 * title/description/AC it returns the structured capability understanding a
 * planner needs to pick the RIGHT playbook (sorting vs CRUD vs checkout ...).
 *
 * The headline case is the one that scored 2/10 in review: a *sorting*
 * requirement must be detected as Sorting — NOT CRUD, and NOT checkout.
 *
 * Run with: npx jest tests/unit/requirement-capability-detector.test.ts
 */

import {
  detectCapability,
  summarizeCapability,
  type CapabilityInput,
} from '../../src/engines/requirement-capability-detector';

const SORT_REQ: CapabilityInput = {
  title: 'Allow users to sort products by different criteria',
  description:
    'As a customer, I want to sort the product list, So that I can quickly find ' +
    'the products I am interested in. Business Requirements: A sorting dropdown ' +
    'shall be displayed on the Inventory page. The user can sort by Name (A to Z), ' +
    'Name (Z to A), Price (Low to High) and Price (High to Low). The list shall ' +
    'reorder immediately. The current sort selection is retained while navigating. ' +
    'Sorting must not affect the shopping cart, and product information is unchanged.',
  acceptanceCriteria:
    'Given the Inventory page, when the user selects a sort option, the product ' +
    'list is reordered. The cart is preserved. Product details remain unchanged.',
  module: 'Inventory',
};

describe('detectCapability — the 2/10 sorting requirement', () => {
  const d = detectCapability(SORT_REQ);

  it('detects Sorting as the PRIMARY capability (not CRUD, not checkout)', () => {
    expect(d.primaryCapability).toBe('sorting');
    expect(d.primaryCapability).not.toBe('crud');
    expect(d.primaryCapability).not.toBe('checkout');
  });

  it('identifies the business object as Product', () => {
    expect(d.businessObject).toBe('Product');
  });

  it('includes Sort in the operations', () => {
    expect(d.operations).toContain('Sort');
  });

  it('extracts Name and Price as sort dimensions', () => {
    expect(d.dimensions).toEqual(expect.arrayContaining(['Name', 'Price']));
  });

  it('extracts the invariants as constraints', () => {
    expect(d.constraints).toEqual(
      expect.arrayContaining(['Cart preserved', 'Product unchanged', 'Selection retained']),
    );
  });

  it('produces a reviewer-friendly summary', () => {
    const s = summarizeCapability(d);
    expect(s).toContain('Primary Capability: Sorting');
    expect(s).toContain('Business Object: Product');
    expect(s).toContain('Name');
    expect(s).toContain('Price');
  });
});

describe('detectCapability — other capabilities', () => {
  it('detects filtering', () => {
    const d = detectCapability({
      title: 'Filter products by category and price range',
      description: 'Users can narrow down the product list by choosing a category or brand.',
    });
    expect(d.primaryCapability).toBe('filtering');
    expect(d.operations).toContain('Filter');
    expect(d.businessObject).toBe('Product');
  });

  it('detects search', () => {
    const d = detectCapability({
      title: 'Search for products by keyword',
      description: 'A search box lets the customer query the catalog and see autocomplete suggestions.',
    });
    expect(d.primaryCapability).toBe('search');
    expect(d.operations).toContain('Search');
  });

  it('detects authentication', () => {
    const d = detectCapability({
      title: 'User Login',
      description: 'A registered user logs in with email and password to access the dashboard.',
      acceptanceCriteria: 'Valid credentials authenticate; invalid credentials are rejected.',
    });
    expect(d.primaryCapability).toBe('authentication');
    expect(d.operations).toContain('Login');
  });

  it('detects CRUD for a genuine create/form requirement', () => {
    const d = detectCapability({
      title: 'Add a new employee',
      description: 'An admin fills a form to create a new employee record and saves it.',
    });
    expect(d.primaryCapability).toBe('crud');
    expect(d.operations).toEqual(expect.arrayContaining(['Create']));
    expect(d.businessObject).toBe('Employee');
  });

  it('detects checkout', () => {
    const d = detectCapability({
      title: 'Checkout and place an order',
      description: 'The customer reviews the shopping cart, enters shipping details and completes checkout.',
    });
    expect(d.primaryCapability).toBe('checkout');
    expect(d.operations).toEqual(expect.arrayContaining(['Checkout']));
  });

  it('detects payment', () => {
    const d = detectCapability({
      title: 'Process credit card payment',
      description: 'The customer pays for the order using a credit card. A refund can be issued on cancellation.',
    });
    expect(d.primaryCapability).toBe('payment');
    expect(d.operations).toContain('Pay');
  });

  it('detects workflow / approval', () => {
    const d = detectCapability({
      title: 'Manager approves leave request',
      description: 'A manager can approve or reject a submitted leave request. Status transitions accordingly.',
    });
    expect(d.primaryCapability).toBe('workflow');
    expect(d.operations).toEqual(expect.arrayContaining(['Approve', 'Reject']));
  });

  it('detects notification', () => {
    const d = detectCapability({
      title: 'Email notification on order shipment',
      description: 'The customer is notified by email when their order ships. An alert also appears in-app.',
    });
    expect(d.primaryCapability).toBe('notification');
    expect(d.operations).toContain('Notify');
  });

  it('detects reporting', () => {
    const d = detectCapability({
      title: 'Sales analytics dashboard',
      description: 'Managers view a dashboard with sales metrics and can export the report to CSV.',
    });
    expect(d.primaryCapability).toBe('reporting');
  });

  it('detects profile', () => {
    const d = detectCapability({
      title: 'Edit my profile',
      description: 'A user updates their personal information and preferences in account settings.',
    });
    // profile and crud both signal; profile should win or be secondary.
    expect(['profile', 'crud']).toContain(d.primaryCapability);
    expect(d.scores.profile).toBeGreaterThan(0);
  });
});

describe('detectCapability — robustness', () => {
  it('fails open to generic on empty input', () => {
    const d = detectCapability({});
    expect(d.primaryCapability).toBe('generic');
    expect(d.operations).toEqual([]);
    expect(d.dimensions).toEqual([]);
    expect(d.constraints).toEqual([]);
    expect(d.businessObject).toBe('Item');
  });

  it('is deterministic (same input → same output)', () => {
    const a = detectCapability(SORT_REQ);
    const b = detectCapability(SORT_REQ);
    expect(a).toEqual(b);
  });

  it('does not mutate its input', () => {
    const input = { ...SORT_REQ };
    const snapshot = JSON.stringify(input);
    detectCapability(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('exposes transparent per-capability scores', () => {
    const d = detectCapability(SORT_REQ);
    expect(d.scores.sorting).toBeGreaterThan(0);
    expect(typeof d.scores.sorting).toBe('number');
  });
});
