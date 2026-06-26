import {
  parseFieldReference,
  resolveFieldLocator,
  resolvePageObjectLocator,
} from '../../src/core/page-object-resolver';

// A representative Page Object class, mirroring the SauceDemo LoginPage that
// produced the false "broken locator" report for #login-button.
const LOGIN_PAGE_SOURCE = `
import { Page, Locator } from '@playwright/test';

export class LoginPage {
  readonly page: Page;
  readonly userName: Locator;
  readonly password: Locator;
  readonly loginBtn: Locator;
  readonly errorMsg: Locator;

  constructor(page: Page) {
    this.page = page;
    this.userName = page.locator('#user-name');
    this.password = this.page.locator('#password');
    this.loginBtn = page.locator('#login-button');
    this.errorMsg = this.page.getByRole('alert');
  }

  async login(user: string, pass: string) {
    await this.userName.fill(user);
    await this.password.fill(pass);
    await this.loginBtn.click();
  }
}
`;

describe('parseFieldReference', () => {
  it('parses this.<field>.<action>() form', () => {
    const ref = parseFieldReference('    await this.loginBtn.click();');
    expect(ref).toEqual({ receiver: 'this', fieldName: 'loginBtn', action: 'click' });
  });

  it('parses pageObject.<field>.<action>() form from a spec', () => {
    const ref = parseFieldReference("await loginPage.userName.fill('standard_user');");
    expect(ref).toEqual({ receiver: 'loginPage', fieldName: 'userName', action: 'fill' });
  });

  it('parses a field reference passed to expect() with no trailing action', () => {
    const ref = parseFieldReference('await expect(this.errorMsg).toBeVisible();');
    expect(ref?.fieldName).toBe('errorMsg');
    expect(ref?.action).toBeNull();
  });

  it('returns null for a line that already has an inline locator', () => {
    expect(parseFieldReference("await page.locator('#login-button').click();")).toBeNull();
    expect(
      parseFieldReference("await page.getByRole('button', { name: 'Login' }).click();"),
    ).toBeNull();
  });

  it('returns null for empty / non-matching lines', () => {
    expect(parseFieldReference('')).toBeNull();
    expect(parseFieldReference('const x = 5;')).toBeNull();
  });
});

describe('resolveFieldLocator', () => {
  it('resolves a page.locator() field to its raw selector', () => {
    const r = resolveFieldLocator('loginBtn', LOGIN_PAGE_SOURCE);
    expect(r).not.toBeNull();
    expect(r?.builder).toBe('locator');
    expect(r?.resolvedLocator).toBe('#login-button');
    expect(r?.locatorExpression).toBe("locator('#login-button')");
  });

  it('resolves a this.page.locator() field', () => {
    const r = resolveFieldLocator('password', LOGIN_PAGE_SOURCE);
    expect(r?.resolvedLocator).toBe('#password');
  });

  it('resolves a getByRole() field, keeping the role builder', () => {
    const r = resolveFieldLocator('errorMsg', LOGIN_PAGE_SOURCE);
    expect(r?.builder).toBe('getByRole');
    expect(r?.resolvedLocator).toBe('alert');
    expect(r?.locatorExpression).toBe("getByRole('alert')");
  });

  it('resolves a typed assignment form: loginBtn: Locator = page.getByTestId(...)', () => {
    const src = `
      class P {
        loginBtn: Locator = page.getByTestId('login');
      }
    `;
    const r = resolveFieldLocator('loginBtn', src);
    expect(r?.builder).toBe('getByTestId');
    expect(r?.resolvedLocator).toBe('login');
  });

  it('returns null for an unknown field', () => {
    expect(resolveFieldLocator('nopeField', LOGIN_PAGE_SOURCE)).toBeNull();
  });

  it('returns null on empty inputs', () => {
    expect(resolveFieldLocator('', LOGIN_PAGE_SOURCE)).toBeNull();
    expect(resolveFieldLocator('loginBtn', '')).toBeNull();
  });
});

describe('resolvePageObjectLocator (end-to-end)', () => {
  it('resolves the SauceDemo false-positive case: this.loginBtn.click() -> #login-button', () => {
    const res = resolvePageObjectLocator(
      '    await this.loginBtn.click();',
      LOGIN_PAGE_SOURCE,
    );
    expect(res).not.toBeNull();
    expect(res?.fieldName).toBe('loginBtn');
    expect(res?.action).toBe('click');
    expect(res?.resolvedLocator).toBe('#login-button');
    expect(res?.builder).toBe('locator');
  });

  it('returns null when the failing line is already an inline locator', () => {
    expect(
      resolvePageObjectLocator("await page.locator('#login-button').click();", LOGIN_PAGE_SOURCE),
    ).toBeNull();
  });

  it('returns null when the field cannot be found in the source', () => {
    expect(
      resolvePageObjectLocator('await this.ghostField.click();', LOGIN_PAGE_SOURCE),
    ).toBeNull();
  });
});
