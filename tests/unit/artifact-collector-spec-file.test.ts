import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ArtifactCollector } from '../../src/core/artifact-collector';

/**
 * Regression: when a broken locator lives in a Page Object, the collector must
 * report `spec_file` = the runnable SPEC (where the test is defined) separately
 * from `file_path` = the Page Object (where the locator is fixed).
 *
 * Before this fix, the healing rerun targeted `file_path` (the Page Object),
 * which Playwright rejects with "No tests found" — so the applied heal could
 * never be confirmed and was silently reverted, surfacing the misleading
 * "none of the 3 healing layers could propose a viable candidate" summary.
 */
describe('ArtifactCollector — spec_file vs file_path (Page Object heals)', () => {
  let repo: string;

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-specfile-'));
    fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'pages'), { recursive: true });

    // The runnable spec (where the test is DEFINED).
    fs.writeFileSync(
      path.join(repo, 'tests', 'login.spec.ts'),
      [
        "import { test } from '@playwright/test';",
        "import { LoginPage } from '../pages/LoginPage';",
        "test('valid login', async ({ page }) => {",
        '  const lp = new LoginPage(page);',
        '  await lp.login("standard_user", "secret_sauce");',
        '});',
        '',
      ].join('\n'),
      'utf-8',
    );

    // The Page Object (where the broken locator lives — and where the fix lands).
    fs.writeFileSync(
      path.join(repo, 'pages', 'LoginPage.ts'),
      [
        'export class LoginPage {',
        '  constructor(private page: any) {}',
        "  username = this.page.locator('#username');",
        '  async login(u: string, p: string) {',
        '    await this.username.fill(u);',
        '  }',
        '}',
        '',
      ].join('\n'),
      'utf-8',
    );
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('sets spec_file to the spec and file_path to the Page Object', () => {
    // Mimic Playwright's two-error timeout shape: errors[0] is the generic
    // timeout (no location), errors[1] carries the real Page Object location.
    const results = {
      suites: [
        {
          file: 'login.spec.ts',
          specs: [
            {
              title: 'valid login',
              file: 'login.spec.ts',
              tests: [
                {
                  results: [
                    {
                      status: 'failed',
                      startTime: new Date().toISOString(),
                      error: { message: 'Test timeout of 30000ms exceeded.' },
                      errors: [
                        { message: 'Test timeout of 30000ms exceeded.' },
                        {
                          message:
                            "locator.fill: Timeout 30000ms exceeded.\nwaiting for locator('#username')",
                          location: {
                            file: path.join(repo, 'pages', 'LoginPage.ts'),
                            line: 3,
                            column: 5,
                          },
                        },
                      ],
                      attachments: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const resultsPath = path.join(repo, 'test-results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(results), 'utf-8');

    const artifacts = new ArtifactCollector().collect(resultsPath, repo);
    expect(artifacts.length).toBe(1);
    const a = artifacts[0];

    // file_path resolves to the Page Object (where the locator is fixed).
    expect(a.file_path).toBe(path.join(repo, 'pages', 'LoginPage.ts'));
    // spec_file resolves to the runnable spec (what the rerun must target).
    expect(a.spec_file).toBe(path.join(repo, 'tests', 'login.spec.ts'));
    // The two MUST differ for a Page Object heal — that's the whole point.
    expect(a.spec_file).not.toBe(a.file_path);
  });
});
