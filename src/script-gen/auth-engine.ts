/**
 * Authentication Engine
 *
 * Enterprise-grade authenticated page crawling system.
 *
 * Capabilities:
 * 1. Intelligent login form detection (auto-detect fields across any app)
 * 2. Multi-strategy form fill and submit
 * 3. Login success / failure detection
 * 4. Session-aware multi-page navigation
 * 5. CAPTCHA / rate-limit detection
 * 6. Secure credential handling (never logged in plain text)
 *
 * Supported patterns:
 * - Standard username/password forms (OrangeHRM, Jira, etc.)
 * - Email/password forms (Salesforce, HubSpot, etc.)
 * - Custom field names (any HTML form)
 * - Multi-step login (email first, then password)
 * - SPA login forms (React/Angular/Vue rendered)
 * - Redirect-based auth (login → dashboard)
 *
 * NOT yet supported (future):
 * - SSO / OAuth / SAML flows
 * - TOTP / 2FA / MFA
 * - CAPTCHA-solving
 */

import { logger } from '../utils/logger';

const MOD = 'auth-engine';

/* ------------------------------------------------------------------ */
/*  Public Types                                                        */
/* ------------------------------------------------------------------ */

/** Configuration for authenticated crawling — passed from the UI. */
export interface AuthConfig {
  /** The URL of the login page (if different from the target URL). */
  loginUrl?: string;

  /** Credentials to use. */
  credentials: {
    username?: string;
    password?: string;
    /** Custom field overrides — key is human label, value is the credential. */
    [key: string]: string | undefined;
  };

  /**
   * Optional pre-login steps (e.g. click "Sign In" button to reveal
   * the form, dismiss a cookie banner, etc.)
   */
  preLoginSteps?: PreLoginStep[];

  /** Max time (ms) to wait for login to complete. Default 15 000. */
  loginTimeoutMs?: number;

  /** Custom selectors — if auto-detect fails, the user can provide them. */
  customSelectors?: {
    usernameField?: string;
    passwordField?: string;
    submitButton?: string;
  };
}

export interface PreLoginStep {
  action: 'click' | 'wait' | 'navigate';
  /** Playwright selector or URL (for navigate). */
  target: string;
  /** Optional value (not used for click). */
  value?: string;
}

/** Result of the login form detection. */
export interface LoginFormDetection {
  /** True if a login form was confidently detected. */
  detected: boolean;
  /** Confidence 0–1. */
  confidence: number;
  /** Playwright selector for the username / email field. */
  usernameSelector: string | null;
  /** Playwright selector for the password field. */
  passwordSelector: string | null;
  /** Playwright selector for the submit button. */
  submitSelector: string | null;
  /** Descriptive strategy that succeeded (for logging). */
  strategy: string;
  /** Whether the form appears to be multi-step (password hidden initially). */
  isMultiStep: boolean;
}

/** Outcome of the authentication attempt. */
export interface AuthResult {
  success: boolean;
  /** Description (e.g. "Redirected to /dashboard"). */
  message: string;
  /** Which strategy detected success / failure. */
  strategy: string;
  /** URL after auth attempt. */
  finalUrl: string;
  /** Duration of the auth process (ms). */
  durationMs: number;
  /** Cookies obtained (names only — values are NOT logged). */
  cookieNames: string[];
  /** If auth failed, actionable error message. */
  error?: string;
  /** Whether CAPTCHA was detected. */
  captchaDetected: boolean;
  /** Whether rate-limiting was detected. */
  rateLimited: boolean;
}

/* ------------------------------------------------------------------ */
/*  Username Field Candidate Selectors (ordered by specificity)         */
/* ------------------------------------------------------------------ */

const USERNAME_SELECTORS: string[] = [
  // Explicit name attributes
  'input[name="username"]',
  'input[name="user"]',
  'input[name="login"]',
  'input[name="email"]',
  'input[name="user_name"]',
  'input[name="userName"]',
  'input[name="userId"]',
  'input[name="user_id"]',
  'input[name="loginId"]',
  'input[name="j_username"]',        // Java EE convention
  'input[name="log"]',               // WordPress
  'input[name="session[email]"]',    // Rails
  'input[name="session[username]"]', // Rails
  // Type-based
  'input[type="email"]',
  // ID patterns
  'input[id*="user" i]',
  'input[id*="email" i]',
  'input[id*="login" i]',
  // Placeholder patterns
  'input[placeholder*="username" i]',
  'input[placeholder*="email" i]',
  'input[placeholder*="user" i]',
  'input[placeholder*="login" i]',
  // Aria-label patterns
  'input[aria-label*="username" i]',
  'input[aria-label*="email" i]',
  'input[aria-label*="user" i]',
  // Auto-complete
  'input[autocomplete="username"]',
  'input[autocomplete="email"]',
  // data-testid fallback
  'input[data-testid*="user" i]',
  'input[data-testid*="email" i]',
  'input[data-testid*="login" i]',
  // Class patterns
  'input[class*="user" i]',
  'input[class*="email" i]',
  'input[class*="login" i]',
  // Generic text input as last resort (only first visible)
  'input[type="text"]',
];

const PASSWORD_SELECTORS: string[] = [
  'input[type="password"]',
  'input[name="password"]',
  'input[name="pass"]',
  'input[name="pwd"]',
  'input[name="j_password"]',        // Java EE
  'input[name="session[password]"]', // Rails
  'input[id*="pass" i]',
  'input[placeholder*="password" i]',
  'input[aria-label*="password" i]',
  'input[autocomplete="current-password"]',
  'input[data-testid*="pass" i]',
];

const SUBMIT_SELECTORS: string[] = [
  'button[type="submit"]',
  'input[type="submit"]',
  // Text-matching buttons — common login labels
  'button:has-text("Login")',
  'button:has-text("Log in")',
  'button:has-text("Log In")',
  'button:has-text("Sign in")',
  'button:has-text("Sign In")',
  'button:has-text("Submit")',
  'button:has-text("Continue")',
  'button:has-text("Enter")',
  // Role-based
  '[role="button"]:has-text("Login")',
  '[role="button"]:has-text("Sign in")',
  // Anchor-as-button
  'a:has-text("Login")',
  'a:has-text("Sign in")',
  // ID patterns
  'button[id*="login" i]',
  'button[id*="submit" i]',
  'button[id*="signin" i]',
  // Class patterns
  'button[class*="login" i]',
  'button[class*="submit" i]',
  // Fall back to any visible button inside a form
  'form button',
  'form input[type="submit"]',
];

/* ------------------------------------------------------------------ */
/*  CAPTCHA Detection Selectors                                         */
/* ------------------------------------------------------------------ */

const CAPTCHA_INDICATORS = [
  'iframe[src*="recaptcha"]',
  'iframe[src*="hcaptcha"]',
  'iframe[src*="captcha"]',
  '.g-recaptcha',
  '#recaptcha',
  '.h-captcha',
  '[data-sitekey]',
  'img[src*="captcha" i]',
  'input[name*="captcha" i]',
  '#captcha',
  '.captcha',
];

/* ------------------------------------------------------------------ */
/*  Success / Failure Detection Patterns                                */
/* ------------------------------------------------------------------ */

const ERROR_SELECTORS = [
  '.error',
  '.alert-danger',
  '.alert-error',
  '[role="alert"]',
  '.oxd-alert',            // OrangeHRM
  '.invalid-feedback',
  '.login-error',
  '.error-message',
  '.form-error',
  '.field-error',
  '#error',
  '.text-danger',
  '.notification-error',
  '.flash-error',
  '.notice-error',
  '.MuiAlert-standardError', // Material UI
  '[data-testid*="error" i]',
];

const LOGOUT_INDICATORS = [
  'a:has-text("Logout")',
  'a:has-text("Log out")',
  'a:has-text("Sign out")',
  'button:has-text("Logout")',
  'button:has-text("Sign out")',
  '[aria-label*="logout" i]',
  '[data-testid*="logout" i]',
  'img[alt*="profile" i]',
  '.user-avatar',
  '.user-menu',
  '.profile-pic',
  '.userdropdown',          // OrangeHRM
  '.oxd-userdropdown',
];

const LOGIN_URL_PATTERNS = /\/(login|signin|sign-in|auth|authenticate|session|sso)/i;

/* ------------------------------------------------------------------ */
/*  Auth Engine Class                                                   */
/* ------------------------------------------------------------------ */

export class AuthEngine {
  /**
   * Detect login form elements on the current page.
   * @param page  Playwright Page object (already navigated to the login URL).
   */
  async detectLoginForm(page: any): Promise<LoginFormDetection> {
    const result: LoginFormDetection = {
      detected: false,
      confidence: 0,
      usernameSelector: null,
      passwordSelector: null,
      submitSelector: null,
      strategy: 'none',
      isMultiStep: false,
    };

    try {
      // --- Password field (easiest to detect) ---
      result.passwordSelector = await this.findFirstVisible(page, PASSWORD_SELECTORS);

      // --- Username / email field ---
      result.usernameSelector = await this.findFirstVisible(page, USERNAME_SELECTORS);
      // De-duplicate: if username selector matches the password field, skip it
      if (result.usernameSelector && result.passwordSelector) {
        const SAME_EL_CHECK = `([uSel, pSel]) => { const u = document.querySelector(uSel); const p = document.querySelector(pSel); return u === p; }`;
        const sameEl = await page.evaluate(SAME_EL_CHECK, [result.usernameSelector, result.passwordSelector]) as boolean;
        if (sameEl) {
          // Username candidate is actually the password field → try harder
          result.usernameSelector = await this.findFirstVisible(
            page,
            USERNAME_SELECTORS.filter(s => !PASSWORD_SELECTORS.includes(s)),
          );
        }
      }

      // --- Submit button ---
      result.submitSelector = await this.findFirstVisible(page, SUBMIT_SELECTORS);

      // --- Multi-step detection ---
      if (result.usernameSelector && !result.passwordSelector) {
        result.isMultiStep = true;
      }

      // --- Confidence scoring ---
      let score = 0;
      if (result.passwordSelector) score += 0.4;
      if (result.usernameSelector) score += 0.3;
      if (result.submitSelector) score += 0.2;
      // Bonus if the page looks like a login page
      const url = page.url().toLowerCase();
      if (LOGIN_URL_PATTERNS.test(url)) score += 0.1;

      result.confidence = Math.min(score, 1);
      result.detected = result.confidence >= 0.5;
      result.strategy = this.describeStrategy(result);

      logger.info(MOD, 'Login form detection', {
        detected: result.detected,
        confidence: result.confidence,
        strategy: result.strategy,
        isMultiStep: result.isMultiStep,
        hasUsername: !!result.usernameSelector,
        hasPassword: !!result.passwordSelector,
        hasSubmit: !!result.submitSelector,
      });
    } catch (err: any) {
      logger.warn(MOD, 'Login form detection error', { error: err.message });
    }

    return result;
  }

  /**
   * Perform the full authentication flow.
   *
   * @param page       Playwright Page — should NOT be navigated yet.
   * @param authConfig Authentication configuration from the UI.
   * @param targetUrl  The URL the user actually wants to crawl (post-auth).
   * @returns AuthResult with success/failure details.
   */
  async authenticate(
    page: any,
    context: any,
    authConfig: AuthConfig,
    targetUrl: string,
  ): Promise<AuthResult> {
    const startTime = Date.now();
    const loginUrl = authConfig.loginUrl || targetUrl;
    const timeout = authConfig.loginTimeoutMs ?? 15_000;

    logger.info(MOD, 'Starting authentication', {
      loginUrl,
      targetUrl,
      hasCustomSelectors: !!authConfig.customSelectors,
      hasPreSteps: (authConfig.preLoginSteps?.length ?? 0) > 0,
      // SECURITY: never log credential values
    });

    try {
      // 1. Navigate to login page
      await page.goto(loginUrl, {
        waitUntil: 'domcontentloaded',
        timeout,
      });
      await this.waitForPageReady(page, timeout);

      // 2. CAPTCHA check (early bail)
      const captchaDetected = await this.detectCaptcha(page);
      if (captchaDetected) {
        return this.buildResult(false, 'CAPTCHA detected on login page — automated login not possible', 'captcha-detect', page, startTime, true, false);
      }

      // 3. Pre-login steps
      if (authConfig.preLoginSteps?.length) {
        await this.executePreLoginSteps(page, authConfig.preLoginSteps, timeout);
        await this.waitForPageReady(page, 5000);
      }

      // 4. Detect login form (or use custom selectors)
      let detection: LoginFormDetection;
      if (authConfig.customSelectors?.usernameField || authConfig.customSelectors?.passwordField) {
        detection = {
          detected: true,
          confidence: 1,
          usernameSelector: authConfig.customSelectors.usernameField || null,
          passwordSelector: authConfig.customSelectors.passwordField || null,
          submitSelector: authConfig.customSelectors.submitButton || null,
          strategy: 'custom-selectors',
          isMultiStep: false,
        };
      } else {
        detection = await this.detectLoginForm(page);
      }

      if (!detection.detected) {
        return this.buildResult(false, 'Could not detect login form on page', 'form-detect-fail', page, startTime, false, false);
      }

      // 5. Fill & submit — handle multi-step if needed
      const username = authConfig.credentials.username || authConfig.credentials.email || '';
      const password = authConfig.credentials.password || '';

      if (!username || !password) {
        return this.buildResult(false, 'Missing username or password in credentials', 'missing-creds', page, startTime, false, false);
      }

      if (detection.isMultiStep) {
        // Multi-step: fill username, submit, wait, fill password, submit
        await this.fillAndSubmitMultiStep(page, detection, username, password, timeout);
      } else {
        // Standard: fill both, submit
        await this.fillAndSubmitStandard(page, detection, username, password, timeout);
      }

      // 6. Wait for navigation / response
      await this.waitForPostLoginNavigation(page, loginUrl, timeout);

      // 7. Check for rate limiting
      const rateLimited = await this.detectRateLimiting(page);
      if (rateLimited) {
        return this.buildResult(false, 'Rate limiting detected — too many login attempts', 'rate-limited', page, startTime, false, true);
      }

      // 8. Detect success vs failure
      const loginSuccess = await this.detectLoginSuccess(page, loginUrl);

      if (loginSuccess.success) {
        logger.info(MOD, 'Authentication successful', {
          strategy: loginSuccess.strategy,
          finalUrl: page.url(),
        });
        return this.buildResult(true, loginSuccess.message, loginSuccess.strategy, page, startTime, false, false);
      } else {
        logger.warn(MOD, 'Authentication failed', {
          strategy: loginSuccess.strategy,
          finalUrl: page.url(),
        });
        return this.buildResult(false, loginSuccess.message, loginSuccess.strategy, page, startTime, false, false);
      }
    } catch (err: any) {
      const sanitizedMsg = this.sanitizeError(err.message, authConfig);
      logger.error(MOD, 'Authentication error', { error: sanitizedMsg });
      return this.buildResult(false, `Authentication error: ${sanitizedMsg}`, 'exception', page, startTime, false, false);
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Private Helpers                                                   */
  /* ---------------------------------------------------------------- */

  /** Find the first visible element matching any of the candidate selectors. */
  private async findFirstVisible(page: any, candidates: string[]): Promise<string | null> {
    for (const selector of candidates) {
      try {
        const el = page.locator(selector).first();
        const isVisible = await el.isVisible({ timeout: 300 }).catch(() => false);
        if (isVisible) {
          return selector;
        }
      } catch {
        // Selector syntax not supported or element not found — skip
      }
    }
    return null;
  }

  /** Wait for the page to be interactive (SPA rendering, loaders, etc.) */
  private async waitForPageReady(page: any, maxMs: number): Promise<void> {
    const safeTimeout = Math.min(maxMs, 10_000);
    try {
      await page.waitForLoadState('networkidle', { timeout: safeTimeout });
    } catch {
      // networkidle may not fire on SPAs with websockets/polling
    }
    // Small extra delay for JS frameworks to finish rendering
    await page.waitForTimeout(1000);
  }

  /** Detect common CAPTCHA elements on the page. */
  private async detectCaptcha(page: any): Promise<boolean> {
    for (const selector of CAPTCHA_INDICATORS) {
      try {
        const visible = await page.locator(selector).first().isVisible({ timeout: 500 }).catch(() => false);
        if (visible) {
          logger.warn(MOD, 'CAPTCHA detected', { selector });
          return true;
        }
      } catch { /* skip */ }
    }
    return false;
  }

  /** Detect rate-limiting responses. */
  private async detectRateLimiting(page: any): Promise<boolean> {
    try {
      const BODY_TEXT_SCRIPT = `() => (document.body?.innerText?.toLowerCase() ?? '')`;
      const bodyText = await page.evaluate(BODY_TEXT_SCRIPT) as string;
      const ratePatterns = ['too many requests', 'rate limit', 'please try again later', '429', 'slow down'];
      return ratePatterns.some(p => bodyText.includes(p));
    } catch {
      return false;
    }
  }

  /** Execute pre-login steps (dismiss banners, click "Sign In" link, etc.) */
  private async executePreLoginSteps(page: any, steps: PreLoginStep[], timeout: number): Promise<void> {
    for (const step of steps) {
      logger.info(MOD, 'Pre-login step', { action: step.action, target: step.target });
      switch (step.action) {
        case 'click':
          await page.locator(step.target).first().click({ timeout });
          break;
        case 'wait':
          await page.waitForTimeout(parseInt(step.target, 10) || 2000);
          break;
        case 'navigate':
          await page.goto(step.target, { waitUntil: 'domcontentloaded', timeout });
          break;
      }
    }
  }

  /** Standard login: fill username + password, then submit. */
  private async fillAndSubmitStandard(
    page: any,
    detection: LoginFormDetection,
    username: string,
    password: string,
    timeout: number,
  ): Promise<void> {
    // Fill username
    if (detection.usernameSelector) {
      const usernameEl = page.locator(detection.usernameSelector).first();
      await usernameEl.click({ timeout: 5000 });
      await usernameEl.fill(''); // clear first
      await usernameEl.fill(username);
      logger.info(MOD, 'Filled username field', { selector: detection.usernameSelector });
    }

    // Fill password
    if (detection.passwordSelector) {
      const passwordEl = page.locator(detection.passwordSelector).first();
      await passwordEl.click({ timeout: 5000 });
      await passwordEl.fill(''); // clear first
      await passwordEl.fill(password);
      logger.info(MOD, 'Filled password field');
    }

    // Submit
    await this.submitForm(page, detection, timeout);
  }

  /** Multi-step login: fill username → submit → wait → fill password → submit. */
  private async fillAndSubmitMultiStep(
    page: any,
    detection: LoginFormDetection,
    username: string,
    password: string,
    timeout: number,
  ): Promise<void> {
    // Step 1: username
    if (detection.usernameSelector) {
      const usernameEl = page.locator(detection.usernameSelector).first();
      await usernameEl.click({ timeout: 5000 });
      await usernameEl.fill(username);
    }

    // Submit step 1
    await this.submitForm(page, detection, timeout);
    await this.waitForPageReady(page, 5000);

    // Step 2: detect password field (it should appear now)
    let pwSelector = detection.passwordSelector;
    if (!pwSelector) {
      pwSelector = await this.findFirstVisible(page, PASSWORD_SELECTORS);
    }

    if (pwSelector) {
      const passwordEl = page.locator(pwSelector).first();
      await passwordEl.click({ timeout: 5000 });
      await passwordEl.fill(password);
    }

    // Detect submit for step 2
    let submitSelector = await this.findFirstVisible(page, SUBMIT_SELECTORS);
    if (submitSelector) {
      await page.locator(submitSelector).first().click({ timeout: 5000 });
    } else {
      await page.keyboard.press('Enter');
    }
  }

  /** Submit the login form using the detected button or Enter key. */
  private async submitForm(page: any, detection: LoginFormDetection, timeout: number): Promise<void> {
    if (detection.submitSelector) {
      try {
        await page.locator(detection.submitSelector).first().click({ timeout: 5000 });
        return;
      } catch {
        logger.warn(MOD, 'Submit button click failed, falling back to Enter key');
      }
    }
    // Fallback: press Enter
    await page.keyboard.press('Enter');
  }

  /** Wait for the page to change after form submission. */
  private async waitForPostLoginNavigation(page: any, loginUrl: string, timeout: number): Promise<void> {
    const safeTimeout = Math.min(timeout, 15_000);
    try {
      // Wait for either URL change or networkidle
      await Promise.race([
        page.waitForURL((url: URL) => url.href !== loginUrl, { timeout: safeTimeout }).catch(() => {}),
        page.waitForLoadState('networkidle', { timeout: safeTimeout }).catch(() => {}),
        page.waitForNavigation({ timeout: safeTimeout }).catch(() => {}),
      ]);
    } catch { /* swallow */ }
    // Extra settle time for SPAs
    await page.waitForTimeout(2000);
  }

  /** Multi-strategy login success detection. */
  private async detectLoginSuccess(
    page: any,
    loginUrl: string,
  ): Promise<{ success: boolean; message: string; strategy: string }> {
    const currentUrl = page.url();

    // Strategy 1: URL changed away from login page
    const loginPath = new URL(loginUrl).pathname;
    const currentPath = new URL(currentUrl).pathname;
    if (currentPath !== loginPath && !LOGIN_URL_PATTERNS.test(currentUrl)) {
      return { success: true, message: `Redirected to ${currentPath}`, strategy: 'url-change' };
    }

    // Strategy 2: Check for logout / profile indicators (proves we're logged in)
    for (const selector of LOGOUT_INDICATORS) {
      try {
        const visible = await page.locator(selector).first().isVisible({ timeout: 1000 }).catch(() => false);
        if (visible) {
          return { success: true, message: 'Authenticated — user menu/logout found', strategy: 'logout-indicator' };
        }
      } catch { /* skip */ }
    }

    // Strategy 3: Check for error messages (proves we failed)
    for (const selector of ERROR_SELECTORS) {
      try {
        const el = page.locator(selector).first();
        const visible = await el.isVisible({ timeout: 500 }).catch(() => false);
        if (visible) {
          const text = await el.textContent().catch(() => '');
          const errorText = (text || '').trim().substring(0, 200);
          return { success: false, message: `Login error: ${errorText || 'Error element visible'}`, strategy: 'error-message' };
        }
      } catch { /* skip */ }
    }

    // Strategy 4: Login form still visible → failure
    const passwordStillVisible = await page.locator('input[type="password"]').first().isVisible({ timeout: 1000 }).catch(() => false);
    if (passwordStillVisible && currentPath === loginPath) {
      return { success: false, message: 'Login form still visible — credentials may be incorrect', strategy: 'form-still-visible' };
    }

    // Strategy 5: Session cookies present
    const cookies = await page.context().cookies();
    const sessionCookies = cookies.filter((c: any) =>
      /session|token|auth|jwt|sid|connect\.sid/i.test(c.name),
    );
    if (sessionCookies.length > 0) {
      return { success: true, message: `Session cookies present: ${sessionCookies.map((c: any) => c.name).join(', ')}`, strategy: 'session-cookies' };
    }

    // Strategy 6: URL changed even slightly (hash-based SPA routing)
    if (currentUrl !== loginUrl) {
      return { success: true, message: `URL changed to ${currentUrl}`, strategy: 'url-any-change' };
    }

    // Unknown — can't determine
    return { success: false, message: 'Could not determine login outcome', strategy: 'unknown' };
  }

  /** Build an AuthResult, extracting cookie names from the browser context. */
  private async buildResult(
    success: boolean,
    message: string,
    strategy: string,
    page: any,
    startTime: number,
    captcha: boolean,
    rateLimit: boolean,
  ): Promise<AuthResult> {
    let cookieNames: string[] = [];
    try {
      const cookies = await page.context().cookies();
      cookieNames = cookies.map((c: any) => c.name);
    } catch { /* context might be closed */ }

    return {
      success,
      message,
      strategy,
      finalUrl: page.url(),
      durationMs: Date.now() - startTime,
      cookieNames,
      error: success ? undefined : message,
      captchaDetected: captcha,
      rateLimited: rateLimit,
    };
  }

  /** Build a readable description of the detection strategy. */
  private describeStrategy(d: LoginFormDetection): string {
    const parts: string[] = [];
    if (d.usernameSelector) parts.push(`username=${d.usernameSelector}`);
    if (d.passwordSelector) parts.push(`password=${d.passwordSelector}`);
    if (d.submitSelector) parts.push(`submit=${d.submitSelector}`);
    if (d.isMultiStep) parts.push('multi-step');
    return parts.join(', ') || 'none';
  }

  /**
   * Remove credential values from error messages to prevent accidental leakage.
   */
  private sanitizeError(msg: string, config: AuthConfig): string {
    let sanitized = msg;
    const secrets = [
      config.credentials.username,
      config.credentials.password,
      config.credentials.email,
    ].filter(Boolean) as string[];

    for (const s of secrets) {
      if (s.length >= 3) {
        sanitized = sanitized.replaceAll(s, '***');
      }
    }
    return sanitized;
  }
}
