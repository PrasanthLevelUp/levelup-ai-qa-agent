/**
 * QA Artifact Standard — Prompt Encoding
 * 
 * Encodes the 20 principles from docs/QA_ARTIFACT_STANDARD.md as reusable
 * prompt instructions. These strings are injected into LLM prompts to enforce
 * human-quality test case writing across Test Case Lab generation, formatter
 * mode, and future exporters.
 * 
 * Design: Each principle becomes a concise, enforceable rule the model can
 * follow. The full standard document is for humans; this module is for models.
 */

/**
 * Core quality principles — the non-negotiable rules that define senior-QA
 * writing. These apply to EVERY test case, regardless of mode or tier.
 */
export const CORE_PRINCIPLES = `CORE QUALITY PRINCIPLES (mandatory for every test case):
1. ONE OBJECTIVE: Each test case verifies exactly ONE thing. Title formula: "Verify <expected behavior> when <condition>."
2. ONE ACTION PER STEP: Never combine actions. Bad: "Enter username and password." Good: separate steps for each action.
3. USER ACTIONS ONLY: Write what a human tester does. Bad: "Ensure button is clickable" / "Observe the page." Good: "Click Login" / "Verify Home page is displayed."
4. VERIFICATION ≠ ACTION: Separate them. Bad: "Click Login and verify Home page." Good: "Click Login" (step N), "Verify Home page is displayed" (step N+1).
5. BUSINESS LANGUAGE: Use product terminology, never automation vocabulary. Bad: "Fill username field" / "Trigger submit." Good: "Enter registered email address" / "Click Login."
6. OBSERVABLE EXPECTED RESULTS: Specific, checkable outcomes. Never "Login successful" or "System behaves correctly." Always granular: "Home page is displayed" + "Logged-in username is visible in the header" + "Logout button is available."
7. TEST DATA ROLES, NOT VALUES: Steps use roles ("registered username", "valid password"). Actual values go in Test Data section. Never embed "standard_user" or "secret_sauce" in steps.
8. PRECONDITIONS ≠ STEPS: Preconditions describe the starting state ("Registered user exists"). Steps describe user actions ("Open Login page").
9. MACHINE-READABLE: Use consistent, parseable action verbs ("Open", "Enter", "Click", "Select", "Verify"). No ambiguous phrasing. Script Generation must parse steps deterministically without another LLM.
10. STABLE STRUCTURE: Every test case follows the canonical order: Title → Preconditions → Test Data → Steps → Expected Results → Traceability.`;

/**
 * Step wording rules — specific patterns for action and verification steps.
 * Used in formatter mode and generation prompts to enforce atomic, parseable steps.
 */
export const STEP_WORDING_RULES = `STEP WORDING (atomic, parseable actions):
• Navigation: "Open <Page> page" (never "Navigate to...", "Go to...").
• Input: "Enter <role> <field>" (e.g., "Enter registered email address"). Never "Fill", "Input", "Type into".
• Click: "Click <Control>" (e.g., "Click Login button"). Never "Press", "Trigger", "Submit via".
• Selection: "Select <Option> from <Dropdown>" (e.g., "Select United States from Country dropdown").
• Verification: "Verify <Observable> is <State>" (e.g., "Verify Home page is displayed" / "Verify error message is shown").
• Multi-step sequences: SPLIT into separate steps. "Enter email and password and click Login" is 3 steps.
• NO meta-actions: Never "Ensure...", "Confirm...", "Observe...", "Check...", "Wait for..." — these are not user actions.`;

/**
 * Expected results rules — enforcing granular, observable outcomes that enable
 * failure diagnosis (Principle 18).
 */
export const EXPECTED_RESULTS_RULES = `EXPECTED RESULTS (granular, observable, diagnostic):
• NEVER write abstract outcomes: "Login successful" / "Operation completes" / "System behaves correctly."
• ALWAYS write specific observables: "Home page is displayed" + "Logged-in username visible in header" + "Logout button available" + "Login form no longer displayed."
• Failure scenarios: describe WHAT the user sees (error message displayed, stays on login page, no session created) — not just "fails."
• Each assertion is a separate bullet. This accelerates debugging when one fails.
• Expected results enable a tester to immediately know WHICH assertion broke without interpretation.`;

/**
 * Test data rules — roles vs. values (Principle 7, 10, 17).
 */
export const TEST_DATA_RULES = `TEST DATA (roles, not values):
• Steps NEVER contain actual data values ("standard_user", "secret_sauce", "user@example.com").
• Steps describe the ROLE of the data: "registered username", "valid password", "incorrect password", "unregistered email."
• Test Data section maps role → dataset → record (e.g., "Role: Registered User / Dataset: valid_users / Record: standard_user").
• Data intent: explain WHY this data is used (e.g., "Valid credentials for successful authentication" / "Incorrect password to trigger authentication error").`;

/**
 * Traceability rules — mandatory metadata (Principle 17).
 */
export const TRACEABILITY_RULES = `TRACEABILITY (mandatory for audit):
• Every test case MUST include: Requirement ID, Acceptance Criteria reference, Scenario ID.
• This metadata enables impact analysis, coverage reporting, and regression prioritization.
• Not displayed to end users, but required in the canonical artifact.`;

/**
 * Title formula — consistent, predictable naming (Principle 11).
 */
export const TITLE_FORMULA = `TITLE FORMULA (no creativity):
Pattern: "Verify <expected behavior> when <condition>."
Examples: "Verify successful login with valid credentials" / "Verify login fails with an invalid password" / "Verify validation message when password is empty."
Never: "Test login", "Check if user can log in", "Login functionality", "Positive login test."`;

/**
 * The complete formatter instruction set — used by buildFormatterPrompt when
 * polishing deterministic test cases. This is the minimal, high-ROI subset of
 * the 20 principles focused on wording quality.
 */
export function getFormatterInstructions(): string {
  return `${CORE_PRINCIPLES}

${STEP_WORDING_RULES}

${EXPECTED_RESULTS_RULES}

${TEST_DATA_RULES}

${TITLE_FORMULA}`;
}

/**
 * The complete generation instruction set — used by the main LLM generation
 * prompt in test-coverage-engine.ts. Includes all principles plus the
 * structural and traceability rules.
 */
export function getGenerationInstructions(): string {
  return `${CORE_PRINCIPLES}

${STEP_WORDING_RULES}

${EXPECTED_RESULTS_RULES}

${TEST_DATA_RULES}

${TRACEABILITY_RULES}

${TITLE_FORMULA}

ADDITIONAL STRUCTURAL RULES:
• Test Case Independence: Every test case is executable in isolation. Never reference "run X first" or "after executing Y."
• Stable Artifact Structure: Canonical order is mandatory. Never reorder sections.
• Failure Diagnosis: Expected results must be granular enough that when a test fails, the tester knows which assertion broke.
• Priority is Risk-Based: Priority reflects business impact (authentication → High, payment → Critical), not test type (positive/negative).`;
}

/**
 * Validation checklist — the 10-question Senior QA Review from Principle 15.
 * Can be appended to prompts or used in post-generation validators.
 */
export const SENIOR_QA_CHECKLIST = `SENIOR QA REVIEW CHECKLIST (every test case must pass all 10):
1. One objective?
2. One variable changed?
3. Human wording?
4. No automation wording?
5. Observable results?
6. Correct test data role?
7. No assumptions?
8. Steps in execution order?
9. One action per step?
10. Can Script Gen consume directly?`;
