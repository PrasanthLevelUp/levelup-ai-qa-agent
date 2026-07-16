/**
 * ============================================================================
 * GOLD BENCHMARKS — the Senior-QA-Architect yardstick
 * ============================================================================
 *
 * SEALED SENIOR-QA EXPECTATIONS.
 *
 * These were authored from the requirement text + senior QA expertise ALONE —
 * NOT from any AI/engine output. They encode what a QA Lead with 15 years of
 * experience would expect a suite to validate. They are the fixed measuring
 * stick for "Test Case Lab Excellence": the generator improves toward THIS.
 *
 *   RULE: Do NOT move an expectation toward the generator after seeing output.
 *   If a concept is genuinely absent from the generated suite, it MUST miss.
 *
 * Every expectation carries a CANONICAL QA CATEGORY (not a Positive/Negative/
 * Edge label — those are reports). The category taxonomy is fixed and shared
 * across all requirements so a per-category leaderboard is comparable:
 *
 *   Functional     — the happy paths the feature exists to deliver.
 *   Validation     — field-level input checks (mandatory, format, mismatch).
 *   Business Rule  — domain rules (uniqueness, balances, pricing, approval,
 *                    immutability, idempotency, stock).
 *   Negative       — failure/error paths for an operation (declined, wrong
 *                    credential, rejected token, non-existent record).
 *   Boundary       — limits & odd-but-legal inputs (min/max length, whitespace,
 *                    special chars, leading zero, timeouts, concurrency).
 *   Security       — confidentiality/abuse defence (hashing, enumeration,
 *                    injection, rate limiting, PCI, session invalidation).
 *   Authorization  — who may perform the action (role, ownership, permission).
 *   File Upload     — file inputs (valid, wrong format, oversized, corrupt).
 *   Search         — retrievability after the operation (by id, by name).
 *   Navigation     — redirects, confirmations, notifications, cancel, logout.
 *   Data Integrity — persistence & consistency (saved, decremented, deducted,
 *                    audit trail, no partial writes, totals recalculated).
 *
 * `match` holds lowercase keyword alternatives; a generated case is "covered"
 * when its title/objective/steps satisfy any phrase (see coverage-match.ts).
 * `weight` marks how costly it is to miss (critical / high / medium).
 * ============================================================================
 */

import type { RequirementInput } from '../src/engines/test-coverage-engine';

export type Weight = 'critical' | 'high' | 'medium';

/** The fixed canonical QA category taxonomy — shared across every benchmark. */
export const QA_CATEGORIES = [
  'Functional',
  'Validation',
  'Business Rule',
  'Negative',
  'Boundary',
  'Security',
  'Authorization',
  'File Upload',
  'Search',
  'Navigation',
  'Data Integrity',
] as const;
export type QACategory = (typeof QA_CATEGORIES)[number];

export interface GoldValidation {
  /** Canonical QA category — the leaderboard axis. */
  category: QACategory;
  /** Human name of the expected validation concept. */
  name: string;
  /** Keyword alternatives (lowercase) used to detect coverage in output. */
  match: string[];
  /** How costly it is to miss this validation. */
  weight: Weight;
}

export interface GoldBenchmark {
  id: string;
  label: string;
  requirement: RequirementInput;
  /** The KB category a senior QA would expect this to route to (classification check). */
  expectedCategory: string;
  expected: GoldValidation[];
}

const V = (
  category: QACategory,
  name: string,
  match: string[],
  weight: Weight = 'high',
): GoldValidation => ({ category, name, match: match.map((m) => m.toLowerCase()), weight });

/* -------------------------------------------------------------------------- */
/* 1. CREATE EMPLOYEE                                                          */
/* -------------------------------------------------------------------------- */
const employee: GoldBenchmark = {
  id: 'employee',
  label: 'Create Employee',
  expectedCategory: 'crud',
  requirement: {
    title: 'Create Employee',
    description:
      'Admin can add a new employee by entering first name, last name, employee ID and an optional profile photo. ' +
      'Employee ID may be auto-generated or entered manually and must be unique. On save the employee is created and ' +
      'becomes searchable by ID and by name.',
    module: 'HR / Employee Management',
    businessFlow: 'Admin opens Add Employee form → fills fields → uploads photo → saves → sees confirmation → employee searchable',
    acceptanceCriteria:
      'Given an authorized admin, when a valid employee is submitted, then the record is created, a success notification ' +
      'is shown, the user is redirected to the employee list, and the new employee is immediately searchable by ID and name.',
  },
  expected: [
    V('Functional', 'Create employee successfully', ['create employee', 'valid employee', 'successfully', 'add employee'], 'critical'),
    V('Functional', 'Create with minimum required fields', ['minimum required', 'required fields only', 'mandatory fields only'], 'medium'),

    V('Validation', 'First name blank', ['first name blank', 'first name empty', 'missing first name', 'first name required'], 'critical'),
    V('Validation', 'Last name blank', ['last name blank', 'last name empty', 'missing last name', 'last name required'], 'critical'),
    V('Validation', 'Both names blank', ['both blank', 'all required', 'both names', 'both fields blank'], 'high'),
    V('Validation', 'Empty employee ID', ['empty id', 'id blank', 'missing id', 'id required'], 'high'),
    V('Validation', 'Invalid employee ID format', ['invalid format', 'invalid id', 'malformed id', 'format'], 'high'),

    V('Business Rule', 'Auto-generated ID', ['auto-generated', 'auto generated', 'autogenerated'], 'high'),
    V('Business Rule', 'Editable ID', ['editable', 'manually entered', 'manual id', 'enter id'], 'medium'),
    V('Business Rule', 'Duplicate ID rejected', ['duplicate', 'already exists', 'unique', 'existing id'], 'critical'),

    V('Boundary', 'Whitespace-only names', ['whitespace', 'spaces only', 'blank spaces', 'trim'], 'high'),
    V('Boundary', 'Leading zero preserved', ['leading zero'], 'medium'),
    V('Boundary', 'Max length ID', ['max length', 'maximum length', 'length boundary', 'too long'], 'high'),
    V('Boundary', 'Special characters in ID', ['special character', 'special char'], 'medium'),

    V('File Upload', 'Valid photo upload', ['valid upload', 'valid photo', 'valid image', 'optional photo', 'profile photo'], 'medium'),
    V('File Upload', 'Invalid photo format', ['invalid file type', 'unsupported format', 'wrong format', 'invalid photo format'], 'high'),
    V('File Upload', 'Large photo file', ['large file', 'file size', 'oversized', 'too large'], 'high'),
    V('File Upload', 'Corrupted image', ['corrupted', 'corrupt image'], 'medium'),

    V('Authorization', 'Authorized user can create', ['authorized', 'admin can', 'permitted user'], 'high'),
    V('Authorization', 'Unauthorized user blocked', ['unauthorized', 'no permission', 'forbidden', 'access denied', 'not allowed'], 'critical'),

    V('Search', 'Searchable immediately', ['searchable', 'search immediately', 'appears in search'], 'high'),
    V('Search', 'Search by ID', ['search by id'], 'medium'),
    V('Search', 'Search by name', ['search by name'], 'medium'),

    V('Navigation', 'Success notification shown', ['success notification', 'success message', 'confirmation'], 'high'),
    V('Navigation', 'Redirect after save', ['redirect', 'navigates to', 'employee list'], 'medium'),

    V('Data Integrity', 'Record persisted and retrievable', ['persisted', 'saved to', 'record created', 'stored'], 'high'),
  ],
};

/* -------------------------------------------------------------------------- */
/* 2. LOGIN                                                                    */
/* -------------------------------------------------------------------------- */
const login: GoldBenchmark = {
  id: 'login',
  label: 'Login',
  expectedCategory: 'authentication',
  requirement: {
    title: 'User Login',
    description:
      'A registered user logs in with a username and password. Valid credentials grant access to the dashboard. ' +
      'Invalid credentials show a generic error. Accounts lock after repeated failures.',
    module: 'Authentication',
    businessFlow: 'User opens login page → enters credentials → submits → is authenticated and redirected, or sees an error',
    acceptanceCriteria:
      'Given a registered user, when correct credentials are entered, then a session is created and the user reaches the ' +
      'dashboard. When credentials are wrong the user stays on the login page with a non-enumerating error.',
  },
  expected: [
    V('Functional', 'Valid credentials succeed', ['valid credentials', 'successful login', 'log in successfully', 'correct credentials'], 'critical'),
    V('Functional', 'Session created on success', ['session'], 'high'),

    V('Validation', 'Username blank', ['username blank', 'username empty', 'missing username', 'empty required'], 'high'),
    V('Validation', 'Password blank', ['password blank', 'password empty', 'missing password'], 'high'),
    V('Validation', 'Both fields blank', ['both blank', 'empty fields', 'both empty'], 'high'),

    V('Negative', 'Wrong password rejected', ['wrong password', 'invalid password', 'incorrect password'], 'critical'),
    V('Negative', 'Unknown user rejected', ['unknown user', 'non-existent', 'unregistered', 'no account'], 'high'),
    V('Negative', 'Error message on failure', ['error message', 'clear error'], 'medium'),

    V('Boundary', 'Whitespace trimming on identifier', ['whitespace', 'trim'], 'medium'),
    V('Boundary', 'Case handling on identifier', ['case-insensitive', 'case sensitive', 'case handling'], 'medium'),

    V('Business Rule', 'Locked / disabled account cannot log in', ['locked account', 'disabled account', 'suspended'], 'high'),

    V('Security', 'Account lockout after repeated failures', ['lockout', 'locked', 'lock out', 'too many attempts', 'account lock'], 'critical'),
    V('Security', 'Password masked', ['masked', 'password mask', 'hidden password'], 'medium'),
    V('Security', 'Error does not leak account existence', ['non-enumerating', 'enumeration', 'does not reveal', 'generic error', 'not leak'], 'high'),
    V('Security', 'SQL injection attempt blocked', ['sql injection', 'injection'], 'high'),
    V('Security', 'Brute force / rate limiting', ['brute force', 'rate limit', 'throttle'], 'high'),

    V('Navigation', 'Redirect to dashboard on success', ['redirect', 'dashboard', 'landing'], 'medium'),
    V('Navigation', 'Logout', ['logout', 'log out', 'sign out'], 'medium'),
  ],
};

/* -------------------------------------------------------------------------- */
/* 3. FORGOT PASSWORD / RESET                                                  */
/* -------------------------------------------------------------------------- */
const passwordReset: GoldBenchmark = {
  id: 'password-reset',
  label: 'Forgot Password',
  expectedCategory: 'authentication',
  requirement: {
    title: 'Password Reset',
    description:
      'A user requests a password reset by entering their email. A time-limited, single-use reset link is emailed. Using the ' +
      'link, the user sets a new password (with confirmation) that must meet complexity rules. The old password is then invalid.',
    module: 'Authentication',
    businessFlow: 'User requests reset → email with token link → opens link → sets new password → confirms → logs in with new password',
    acceptanceCriteria:
      'Given a registered email, when a reset is requested, then a single-use, time-limited link is emailed without revealing ' +
      'whether the account exists; using a valid link the user can set a complexity-compliant new password and the old one stops working.',
  },
  expected: [
    V('Functional', 'Request reset with valid email', ['valid email', 'request reset', 'reset request', 'forgot password'], 'critical'),
    V('Functional', 'Reset with valid token', ['valid token', 'valid link', 'reset link'], 'critical'),
    V('Functional', 'Login with new password', ['new password', 'log in with new'], 'high'),

    V('Validation', 'Email blank', ['email blank', 'email empty', 'missing email', 'email required'], 'high'),
    V('Validation', 'New password blank', ['password blank', 'password empty', 'missing password'], 'high'),
    V('Validation', 'Confirm password blank', ['confirm blank', 'confirm empty', 'confirmation required'], 'medium'),
    V('Validation', 'Invalid email format', ['invalid email', 'email format', 'malformed email'], 'high'),
    V('Validation', 'Password / confirm mismatch', ['mismatch', 'do not match', 'passwords match', "don't match"], 'high'),

    V('Business Rule', 'Password complexity enforced', ['complexity', 'password policy', 'weak password', 'strength'], 'high'),
    V('Business Rule', 'New password same as old rejected', ['same as old', 'reuse', 'previous password', 'old password'], 'medium'),

    V('Negative', 'Unknown email (no enumeration)', ['unknown email', 'non-existent email', 'unregistered', 'does not reveal'], 'high'),

    V('Security', 'Expired token rejected', ['expired token', 'expired link', 'token expired'], 'critical'),
    V('Security', 'Invalid token rejected', ['invalid token', 'invalid link', 'tampered token'], 'high'),
    V('Security', 'Reused / single-use token', ['reused token', 'single-use', 'single use', 'already used', 'token consumed'], 'high'),
    V('Security', 'Rate limiting on requests', ['rate limit', 'throttle', 'too many requests'], 'high'),
    V('Security', 'Session invalidated after reset', ['session invalidated', 'sessions revoked', 'log out other'], 'medium'),

    V('Boundary', 'Whitespace in email trimmed', ['whitespace', 'trim'], 'medium'),
    V('Boundary', 'Very long password boundary', ['max length', 'very long', 'length boundary', 'too long'], 'medium'),

    V('Navigation', 'Reset email sent', ['email sent', 'reset email', 'send link'], 'high'),
    V('Navigation', 'Success confirmation', ['success confirmation', 'password changed', 'reset successful'], 'medium'),

    V('Data Integrity', 'Old password invalidated', ['old password invalid', 'old password no longer', 'previous password invalid'], 'high'),
  ],
};

/* -------------------------------------------------------------------------- */
/* 4. CHECKOUT                                                                 */
/* -------------------------------------------------------------------------- */
const checkout: GoldBenchmark = {
  id: 'checkout',
  label: 'Checkout',
  expectedCategory: 'checkout',
  requirement: {
    title: 'Cart Checkout',
    description:
      'A shopper reviews the cart, enters a shipping address, applies an optional coupon, and pays. On success an order ' +
      'is created, inventory is decremented, and a confirmation is shown and emailed. Payment is by card.',
    module: 'E-commerce / Checkout',
    businessFlow: 'Cart → shipping address → coupon → payment → order confirmation + email',
    acceptanceCriteria:
      'Given a cart with in-stock items and valid payment, when the shopper checks out, then an order is created with the ' +
      'correct total (items + tax + shipping − discount), inventory is decremented, and a confirmation is shown and emailed.',
  },
  expected: [
    V('Functional', 'Checkout with valid cart and payment', ['valid cart', 'successful checkout', 'place order', 'complete checkout', 'checkout success'], 'critical'),
    V('Functional', 'Single item checkout', ['single item', 'one item'], 'medium'),
    V('Functional', 'Multiple items checkout', ['multiple items', 'several items'], 'medium'),
    V('Functional', 'Apply valid coupon', ['valid coupon', 'apply coupon', 'promo code', 'discount code'], 'high'),

    V('Validation', 'Missing required address field', ['missing address', 'address required', 'address blank'], 'high'),
    V('Validation', 'Invalid postal code', ['postal code', 'zip code', 'zip'], 'medium'),
    V('Validation', 'Invalid card number format', ['invalid card number', 'card format', 'invalid card'], 'high'),

    V('Business Rule', 'Out-of-stock item', ['out of stock', 'out-of-stock', 'unavailable'], 'critical'),
    V('Business Rule', 'Correct total calculation', ['total', 'correct amount', 'order total'], 'critical'),
    V('Business Rule', 'Tax applied', ['tax'], 'high'),
    V('Business Rule', 'Shipping calculated', ['shipping'], 'medium'),
    V('Business Rule', 'Coupon discount applied correctly', ['discount applied', 'coupon discount'], 'high'),

    V('Negative', 'Empty cart blocked', ['empty cart', 'no items', 'cart is empty'], 'high'),
    V('Negative', 'Declined card', ['declined', 'card declined', 'payment declined'], 'critical'),
    V('Negative', 'Expired card', ['expired card', 'expired'], 'high'),
    V('Negative', 'Invalid CVV', ['cvv', 'security code'], 'high'),
    V('Negative', 'Insufficient funds', ['insufficient funds'], 'high'),
    V('Negative', 'Invalid / expired coupon rejected', ['invalid coupon', 'expired coupon', 'coupon rejected'], 'high'),

    V('Boundary', 'Quantity exceeds stock', ['exceeds stock', 'quantity exceeds', 'insufficient stock'], 'high'),
    V('Boundary', 'Double submission / duplicate order prevented', ['double submission', 'duplicate order', 'double-click', 'idempoten'], 'high'),
    V('Boundary', 'Session timeout during checkout', ['session timeout', 'session expired'], 'medium'),
    V('Boundary', 'Price change during checkout', ['price change', 'price changed'], 'medium'),

    V('Security', 'Payment over HTTPS / no card data logged', ['https', 'card data', 'pci', 'not stored'], 'high'),

    V('Authorization', 'Authorization (logged-in vs guest)', ['guest', 'logged in', 'authorized', 'unauthorized'], 'medium'),

    V('Navigation', 'Order confirmation shown', ['order confirmation', 'confirmation page', 'order confirmed'], 'high'),
    V('Navigation', 'Confirmation email sent', ['confirmation email', 'email sent'], 'medium'),

    V('Data Integrity', 'Inventory decremented', ['inventory', 'stock decrement', 'stock reduced'], 'high'),
  ],
};

/* -------------------------------------------------------------------------- */
/* 5. LEAVE REQUEST                                                            */
/* -------------------------------------------------------------------------- */
const leave: GoldBenchmark = {
  id: 'leave',
  label: 'Leave Request',
  expectedCategory: 'workflow',
  requirement: {
    title: 'Submit Leave Request',
    description:
      'An employee submits a leave request selecting leave type, start date, end date and a reason. The request is validated ' +
      'against the leave balance and sent to the manager for approval. Approval or rejection updates the request status and ' +
      'notifies the employee.',
    module: 'HR / Leave Management',
    businessFlow: 'Employee fills leave form → validates dates and balance → submits → manager approves/rejects → status + notification',
    acceptanceCriteria:
      'Given an employee with sufficient balance, when a valid leave request is submitted, then it is created in Pending state, ' +
      'routed to the manager, and on approval the balance is deducted and the employee is notified.',
  },
  expected: [
    V('Functional', 'Submit valid leave request', ['valid leave', 'submit leave', 'leave request success', 'successfully submit'], 'critical'),
    V('Functional', 'Half-day leave', ['half day', 'half-day'], 'medium'),
    V('Functional', 'Multi-day leave', ['multi day', 'multiple day', 'multi-day', 'date range'], 'medium'),

    V('Validation', 'Start date blank', ['start date blank', 'start date empty', 'missing start date'], 'high'),
    V('Validation', 'End date blank', ['end date blank', 'end date empty', 'missing end date'], 'high'),
    V('Validation', 'Leave type blank', ['leave type blank', 'leave type required', 'missing leave type'], 'high'),
    V('Validation', 'Reason blank', ['reason blank', 'reason required', 'missing reason'], 'medium'),

    V('Business Rule', 'End date before start date rejected', ['end before start', 'end date before', 'invalid date range', 'before start'], 'critical'),
    V('Business Rule', 'Past date rejected', ['past date', 'backdated', 'date in the past'], 'high'),
    V('Business Rule', 'Overlapping leave rejected', ['overlap', 'overlapping', 'existing leave'], 'high'),
    V('Business Rule', 'Sufficient balance allowed', ['sufficient balance', 'enough balance'], 'high'),
    V('Business Rule', 'Insufficient balance rejected', ['insufficient balance', 'exceeds balance', 'not enough balance'], 'critical'),

    V('Boundary', 'Max consecutive days boundary', ['max days', 'maximum days', 'consecutive', 'boundary'], 'medium'),
    V('Boundary', 'Leave spanning weekend / holiday', ['weekend', 'holiday'], 'medium'),
    V('Boundary', 'Concurrent requests', ['concurrent', 'simultaneous'], 'medium'),

    V('Authorization', 'Employee submits own request', ['own request', 'own leave', 'self'], 'medium'),
    V('Authorization', 'Cannot submit for others', ['for others', 'on behalf', 'another employee'], 'high'),
    V('Authorization', 'Manager approves', ['manager approve', 'approver'], 'high'),
    V('Authorization', 'Unauthorized approval blocked', ['unauthorized approval', 'cannot approve', 'not authorized to approve'], 'high'),

    V('Navigation', 'Request routed to approver', ['routed', 'sent to manager', 'sent to approver', 'pending approval'], 'high'),
    V('Navigation', 'Notification to manager', ['notify manager', 'manager notification', 'notification'], 'medium'),
    V('Navigation', 'Cancellation', ['cancel', 'cancellation', 'withdraw'], 'medium'),

    V('Data Integrity', 'Approval updates status', ['approval', 'approved status', 'status updated'], 'high'),
    V('Data Integrity', 'Rejection updates status', ['rejection', 'rejected status', 'reject'], 'high'),
    V('Data Integrity', 'Balance deducted on approval', ['balance deduct', 'deduct balance', 'balance updated'], 'high'),
  ],
};

/* -------------------------------------------------------------------------- */
/* 6. REGISTRATION                                                             */
/* -------------------------------------------------------------------------- */
const registration: GoldBenchmark = {
  id: 'registration',
  label: 'Registration',
  expectedCategory: 'authentication',
  requirement: {
    title: 'User Registration',
    description:
      'A new user registers with a username, email, password and password confirmation, and must accept the terms. On submit ' +
      'a verification email is sent; the account is inactive until the email is verified. Email and username must be unique.',
    module: 'Authentication',
    businessFlow: 'User opens sign-up → enters details → accepts terms → submits → receives verification email → verifies → can log in',
    acceptanceCriteria:
      'Given valid, unique details and accepted terms, when the user registers, then an inactive account is created, a single-use ' +
      'verification email is sent, and the user can log in only after verifying; duplicate email/username are rejected.',
  },
  expected: [
    V('Functional', 'Register with valid details', ['valid registration', 'register successfully', 'sign up successfully', 'create account'], 'critical'),
    V('Functional', 'Verification email sent on register', ['verification email', 'confirm email', 'activation email'], 'high'),
    V('Functional', 'Login only after verification', ['after verification', 'verify email', 'email verified'], 'high'),

    V('Validation', 'Username blank', ['username blank', 'username empty', 'missing username', 'username required'], 'high'),
    V('Validation', 'Email blank', ['email blank', 'email empty', 'missing email', 'email required'], 'high'),
    V('Validation', 'Password blank', ['password blank', 'password empty', 'missing password'], 'high'),
    V('Validation', 'Invalid email format', ['invalid email', 'email format', 'malformed email'], 'high'),
    V('Validation', 'Password / confirm mismatch', ['mismatch', 'do not match', 'passwords match', "don't match"], 'high'),
    V('Validation', 'Terms not accepted', ['terms', 'accept terms', 'agreement', 'checkbox required'], 'medium'),

    V('Business Rule', 'Duplicate email rejected', ['duplicate email', 'email already', 'email exists', 'already registered'], 'critical'),
    V('Business Rule', 'Duplicate username rejected', ['duplicate username', 'username taken', 'username exists'], 'high'),

    V('Negative', 'Register with already-existing account', ['existing account', 'already have an account', 'already exists'], 'high'),

    V('Boundary', 'Username min / max length', ['min length', 'max length', 'length boundary', 'too long', 'too short'], 'medium'),
    V('Boundary', 'Whitespace-only fields trimmed', ['whitespace', 'spaces only', 'trim'], 'medium'),

    V('Security', 'Password complexity enforced', ['complexity', 'weak password', 'password policy', 'strength'], 'high'),
    V('Security', 'Password stored hashed (never plaintext)', ['hashed', 'hash', 'not plaintext', 'encrypted at rest'], 'high'),
    V('Security', 'No email enumeration on register', ['enumeration', 'does not reveal', 'non-enumerating'], 'medium'),
    V('Security', 'Bot / rate limiting / captcha', ['captcha', 'rate limit', 'bot', 'throttle'], 'medium'),

    V('Navigation', 'Redirect / message after register', ['redirect', 'check your email', 'confirmation message', 'success message'], 'medium'),

    V('Data Integrity', 'Account persisted and inactive until verified', ['inactive', 'pending verification', 'account created', 'persisted'], 'high'),
    V('Data Integrity', 'Verification token single-use / expiring', ['single-use', 'single use', 'token expires', 'expiring link'], 'medium'),
  ],
};

/* -------------------------------------------------------------------------- */
/* 7. EDIT EMPLOYEE                                                            */
/* -------------------------------------------------------------------------- */
const editEmployee: GoldBenchmark = {
  id: 'edit-employee',
  label: 'Edit Employee',
  expectedCategory: 'crud',
  requirement: {
    title: 'Edit Employee',
    description:
      'An authorized admin edits an existing employee: updates first/last name and profile photo. The employee ID is immutable. ' +
      'On save the changes are persisted, a confirmation is shown, and the updated employee remains searchable by the new name.',
    module: 'HR / Employee Management',
    businessFlow: 'Admin opens employee → edit form prefilled → changes fields → saves → confirmation → updated record searchable',
    acceptanceCriteria:
      'Given an authorized admin editing an existing employee, when valid changes are saved, then only the changed fields are ' +
      'updated, the employee ID is unchanged, the record is persisted, and the employee is searchable by the new name.',
  },
  expected: [
    V('Functional', 'Edit form prefilled with current values', ['prefilled', 'pre-populated', 'current values', 'existing values'], 'high'),
    V('Functional', 'Update employee successfully', ['update employee', 'edit successfully', 'save changes', 'update successfully'], 'critical'),

    V('Validation', 'First name blank on edit', ['first name blank', 'first name empty', 'first name required'], 'high'),
    V('Validation', 'Last name blank on edit', ['last name blank', 'last name empty', 'last name required'], 'high'),
    V('Validation', 'Invalid field format on edit', ['invalid format', 'invalid input', 'malformed'], 'medium'),

    V('Business Rule', 'Employee ID is immutable', ['immutable', 'cannot change id', 'id read-only', 'id unchanged'], 'high'),
    V('Business Rule', 'Only changed fields updated', ['only changed', 'partial update', 'changed fields', 'unchanged fields'], 'medium'),
    V('Business Rule', 'Concurrent edit / optimistic locking', ['concurrent edit', 'optimistic lock', 'stale', 'conflict'], 'high'),

    V('Negative', 'Edit non-existent employee', ['non-existent', 'not found', 'does not exist', 'deleted employee'], 'high'),
    V('Negative', 'Save with no changes', ['no changes', 'unchanged', 'nothing to save'], 'medium'),

    V('Boundary', 'Max length fields on edit', ['max length', 'maximum length', 'too long', 'length boundary'], 'medium'),
    V('Boundary', 'Special characters in fields', ['special character', 'special char'], 'medium'),

    V('Authorization', 'Authorized user can edit', ['authorized', 'admin can edit', 'permitted'], 'high'),
    V('Authorization', 'Unauthorized user blocked', ['unauthorized', 'no permission', 'forbidden', 'access denied'], 'critical'),

    V('File Upload', 'Replace photo with valid image', ['replace photo', 'valid photo', 'valid image', 'update photo'], 'medium'),
    V('File Upload', 'Invalid photo format on edit', ['invalid format', 'unsupported format', 'wrong format'], 'high'),
    V('File Upload', 'Oversized photo on edit', ['oversized', 'large file', 'file size', 'too large'], 'medium'),

    V('Search', 'Updated employee searchable by new name', ['searchable', 'search by name', 'appears in search'], 'high'),

    V('Navigation', 'Redirect after save', ['redirect', 'navigates to', 'detail page', 'employee list'], 'medium'),
    V('Navigation', 'Cancel edit discards changes', ['cancel', 'discard', 'without saving'], 'medium'),

    V('Data Integrity', 'Changes persisted', ['persisted', 'saved', 'stored', 'reflected'], 'high'),
    V('Data Integrity', 'No partial update on failure', ['partial update', 'rollback', 'atomic', 'transaction'], 'medium'),
  ],
};

/* -------------------------------------------------------------------------- */
/* 8. SHOPPING CART                                                            */
/* -------------------------------------------------------------------------- */
const cart: GoldBenchmark = {
  id: 'cart',
  label: 'Shopping Cart',
  expectedCategory: 'checkout',
  requirement: {
    title: 'Shopping Cart',
    description:
      'A shopper adds items to a cart, updates quantities, and removes items. The cart shows a running subtotal and item count, ' +
      'reflects current prices and stock, and persists across the session. A guest cart merges into the user cart on login.',
    module: 'E-commerce / Cart',
    businessFlow: 'Browse → add to cart → view cart → update quantity / remove → subtotal updates → proceed to checkout',
    acceptanceCriteria:
      'Given a shopper, when items are added, updated or removed, then the cart reflects current price and stock, recalculates ' +
      'the subtotal and count accurately, persists across the session, and merges a guest cart into the user cart on login.',
  },
  expected: [
    V('Functional', 'Add item to cart', ['add to cart', 'add item', 'added to cart'], 'critical'),
    V('Functional', 'View cart contents', ['view cart', 'cart contents', 'cart page'], 'high'),
    V('Functional', 'Update item quantity', ['update quantity', 'change quantity', 'increase quantity', 'decrease quantity'], 'high'),
    V('Functional', 'Remove item from cart', ['remove item', 'delete item', 'remove from cart'], 'high'),

    V('Validation', 'Quantity must be a positive integer', ['positive integer', 'invalid quantity', 'quantity must be', 'non-numeric quantity'], 'high'),

    V('Business Rule', 'Add out-of-stock item blocked', ['out of stock', 'out-of-stock', 'unavailable'], 'critical'),
    V('Business Rule', 'Quantity capped at available stock', ['capped', 'exceeds stock', 'max stock', 'available stock'], 'high'),
    V('Business Rule', 'Cart reflects current price', ['current price', 'price update', 'price change'], 'medium'),
    V('Business Rule', 'Merge guest cart on login', ['merge', 'guest cart', 'on login'], 'medium'),

    V('Negative', 'Remove item not in cart', ['not in cart', 'already removed', 'non-existent item'], 'medium'),
    V('Negative', 'Add invalid / non-existent product', ['invalid product', 'non-existent product', 'invalid item id'], 'medium'),

    V('Boundary', 'Max quantity per item', ['max quantity', 'maximum quantity', 'quantity limit'], 'medium'),
    V('Boundary', 'Zero quantity removes item', ['zero quantity', 'quantity zero', 'qty 0'], 'medium'),

    V('Security', 'Cart isolated per user / session', ['isolated', 'cross-user', 'other user', 'session cart'], 'high'),

    V('Authorization', 'Guest vs logged-in cart', ['guest', 'logged in', 'anonymous cart'], 'medium'),

    V('Navigation', 'Proceed to checkout', ['proceed to checkout', 'checkout button', 'go to checkout'], 'high'),
    V('Navigation', 'Continue shopping', ['continue shopping', 'back to products'], 'medium'),

    V('Data Integrity', 'Subtotal recalculated correctly', ['subtotal', 'recalculate', 'cart total', 'total updates'], 'critical'),
    V('Data Integrity', 'Cart count / badge accurate', ['cart count', 'item count', 'badge'], 'medium'),
    V('Data Integrity', 'Cart persists across session', ['persist', 'saved cart', 'across session', 'after refresh'], 'high'),
  ],
};

/* -------------------------------------------------------------------------- */
/* 9. PAYMENT                                                                  */
/* -------------------------------------------------------------------------- */
const payment: GoldBenchmark = {
  id: 'payment',
  label: 'Payment',
  expectedCategory: 'payment',
  requirement: {
    title: 'Card Payment',
    description:
      'A user pays for an order by card (number, expiry, CVV, name). On success a transaction is recorded and a receipt shown. ' +
      'The charged amount must equal the order total and must not be double-charged. Card data is never stored; payment uses TLS.',
    module: 'Payments',
    businessFlow: 'Enter card details → submit payment → gateway authorizes → transaction recorded → receipt shown, or failure handled',
    acceptanceCriteria:
      'Given a valid card and an order, when payment is submitted, then the exact order total is charged once (idempotent), a ' +
      'transaction is recorded, a receipt is shown, and no card data is persisted; failures are handled without charging.',
  },
  expected: [
    V('Functional', 'Pay with valid card', ['valid card', 'successful payment', 'payment success', 'pay successfully'], 'critical'),
    V('Functional', 'Receipt shown on success', ['receipt', 'payment confirmation', 'success page'], 'high'),

    V('Validation', 'Card number required / format', ['card number required', 'invalid card number', 'card number format'], 'high'),
    V('Validation', 'Expiry required / format', ['expiry required', 'invalid expiry', 'expiry format', 'expiration date'], 'high'),
    V('Validation', 'CVV required / format', ['cvv required', 'invalid cvv', 'security code'], 'high'),
    V('Validation', 'Name on card required', ['name on card', 'cardholder name'], 'medium'),

    V('Business Rule', 'Charged amount equals order total', ['amount matches', 'equals order total', 'correct amount', 'charged amount'], 'critical'),
    V('Business Rule', 'Idempotent — no double charge', ['double charge', 'idempoten', 'duplicate charge', 'charged twice'], 'critical'),
    V('Business Rule', 'Correct currency', ['currency'], 'medium'),

    V('Negative', 'Declined card', ['declined', 'card declined', 'payment declined'], 'critical'),
    V('Negative', 'Expired card', ['expired card', 'expired'], 'high'),
    V('Negative', 'Insufficient funds', ['insufficient funds'], 'high'),
    V('Negative', 'Invalid CVV rejected', ['invalid cvv', 'wrong cvv'], 'high'),
    V('Negative', 'Gateway timeout / error handled', ['gateway timeout', 'gateway error', 'payment error', 'network error'], 'high'),

    V('Boundary', 'Minimum / maximum amount', ['minimum amount', 'maximum amount', 'amount boundary', 'zero amount'], 'medium'),

    V('Security', 'No card data stored / logged (PCI)', ['not stored', 'card data', 'pci', 'not logged'], 'critical'),
    V('Security', 'Payment over TLS / HTTPS', ['tls', 'https', 'encrypted'], 'high'),
    V('Security', '3D Secure / OTP challenge', ['3d secure', '3ds', 'otp', 'two-factor'], 'medium'),

    V('Authorization', 'Only the order owner can pay', ['order owner', 'own order', 'unauthorized payment'], 'high'),

    V('Navigation', 'Redirect to confirmation on success', ['redirect', 'confirmation page', 'success redirect'], 'medium'),
    V('Navigation', 'Retry / return on failure', ['retry', 'try again', 'return to payment'], 'medium'),

    V('Data Integrity', 'Transaction recorded', ['transaction recorded', 'transaction saved', 'payment record'], 'high'),
    V('Data Integrity', 'Order status consistent with payment', ['order status', 'status consistent', 'marked paid'], 'high'),
    V('Data Integrity', 'Refund path', ['refund'], 'medium'),
  ],
};

/* -------------------------------------------------------------------------- */
/* 10. USER PROFILE                                                            */
/* -------------------------------------------------------------------------- */
const profile: GoldBenchmark = {
  id: 'profile',
  label: 'User Profile',
  expectedCategory: 'crud',
  requirement: {
    title: 'User Profile',
    description:
      'A logged-in user views and edits their profile: display name, email, phone, bio and avatar. Changing the email requires ' +
      're-verification. Email must remain unique. Changes are persisted and reflected across the app. Users edit only their own profile.',
    module: 'Account / Profile',
    businessFlow: 'Open profile → edit fields / change avatar → save → (email change → re-verify) → changes persisted and reflected',
    acceptanceCriteria:
      'Given a logged-in user editing their own profile, when valid changes are saved, then they persist and are reflected across ' +
      'the app; an email change requires re-verification and must stay unique; a user cannot edit another user’s profile.',
  },
  expected: [
    V('Functional', 'View own profile', ['view profile', 'profile page', 'display profile'], 'high'),
    V('Functional', 'Edit and save profile successfully', ['edit profile', 'update profile', 'save profile', 'profile updated'], 'critical'),

    V('Validation', 'Display name blank', ['name blank', 'name empty', 'name required'], 'high'),
    V('Validation', 'Invalid email format', ['invalid email', 'email format', 'malformed email'], 'high'),
    V('Validation', 'Invalid phone format', ['invalid phone', 'phone format', 'phone number format'], 'medium'),

    V('Business Rule', 'Email change requires re-verification', ['re-verification', 're-verify', 'verify new email', 'confirm new email'], 'high'),
    V('Business Rule', 'Email remains unique', ['unique email', 'email already', 'email taken', 'duplicate email'], 'high'),

    V('Negative', 'Update with invalid data rejected', ['invalid data', 'rejected', 'validation error'], 'medium'),

    V('Boundary', 'Bio / name max length', ['max length', 'maximum length', 'too long', 'character limit'], 'medium'),
    V('Boundary', 'Special characters / unicode in fields', ['special character', 'unicode', 'emoji'], 'medium'),

    V('Security', 'Change password requires current password', ['current password', 'existing password', 'verify password'], 'high'),
    V('Security', 'Sessions handled after email/password change', ['session', 'sessions revoked', 're-authenticate'], 'medium'),

    V('Authorization', 'User edits only their own profile', ['own profile', 'other user', 'cannot edit others', 'unauthorized'], 'critical'),
    V('Authorization', 'Admin override where applicable', ['admin', 'admin can edit', 'elevated'], 'medium'),

    V('File Upload', 'Valid avatar upload', ['valid avatar', 'valid image', 'upload avatar', 'profile picture'], 'medium'),
    V('File Upload', 'Invalid avatar format', ['invalid format', 'unsupported format', 'wrong format'], 'high'),
    V('File Upload', 'Oversized avatar', ['oversized', 'large file', 'file size', 'too large'], 'medium'),

    V('Navigation', 'Redirect / confirmation after save', ['redirect', 'confirmation', 'success message'], 'medium'),
    V('Navigation', 'Cancel discards changes', ['cancel', 'discard', 'without saving'], 'medium'),

    V('Data Integrity', 'Changes persisted and reflected across app', ['persisted', 'reflected', 'updated everywhere', 'saved'], 'high'),
  ],
};

export const GOLD_BENCHMARKS: GoldBenchmark[] = [
  employee,
  login,
  passwordReset,
  checkout,
  leave,
  registration,
  editEmployee,
  cart,
  payment,
  profile,
];

export function getBenchmark(id: string): GoldBenchmark | undefined {
  return GOLD_BENCHMARKS.find((b) => b.id === id);
}
