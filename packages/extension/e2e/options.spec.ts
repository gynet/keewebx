import { test, expect } from './fixtures';

test('options page loads', async ({ page, extensionId }) => {
    await page.goto(`chrome-extension://${extensionId}/pages/options.html`);
    // options.html renders a Preact app into <body>
    await expect(page.locator('body')).not.toBeEmpty();
    // Page title includes the extension name
    await expect(page).toHaveTitle(/KeeWeb Connect/);
});

test('options page loads scripts', async ({ page, extensionId }) => {
    await page.goto(`chrome-extension://${extensionId}/pages/options.html`);
    // Verify the options JS module is loaded
    const scriptSrc = await page.locator('script[src*="options"]').getAttribute('src');
    expect(scriptSrc).toContain('options.js');
});

// Regression guard for the v0.1.0 self-host bundle bug: Firefox user
// reported UI rejected `file:///...` URLs pointing at the release bundle.
// Validation now allows https://, file://, and http://localhost aliases.
//
// Chromium-only (pinned via playwright.config.ts `projects` = [chromium])
// because the harness can't load an MV3 extension in Firefox without
// `web-ext run` which isn't wired here. The pure-function tests in
// `tests/validate-keeweb-url.test.ts` cover cross-browser parity.
test.describe('KeeWeb URL validation UI', () => {
    const allowed = [
        'https://foo.example/',
        'http://localhost:8080/',
        'file:///Users/gynet/Desktop/app/index.html'
    ];
    const rejected = [
        { url: 'http://192.168.1.5:8080/', expectedSchemeError: true },
        { url: 'http://evil.com/', expectedSchemeError: true },
        { url: 'ftp://foo.example/', expectedSchemeError: true }
    ];

    for (const candidate of allowed) {
        test(`accepts ${candidate}`, async ({ page, extensionId }) => {
            await page.goto(`chrome-extension://${extensionId}/pages/options.html`);
            const input = page.locator('form input[type="text"]').first();
            await input.waitFor();
            await input.fill(candidate);
            await page.locator('form button[type="submit"]').first().click();
            // Error container should be empty on accept
            await expect(page.locator('.error').first()).toHaveText('');
        });
    }

    for (const { url } of rejected) {
        test(`rejects ${url}`, async ({ page, extensionId }) => {
            await page.goto(`chrome-extension://${extensionId}/pages/options.html`);
            const input = page.locator('form input[type="text"]').first();
            await input.waitFor();
            await input.fill(url);
            await page.locator('form button[type="submit"]').first().click();
            // Error container should contain the disallowed-scheme message
            const errorText = await page.locator('.error').first().textContent();
            expect(errorText?.length ?? 0).toBeGreaterThan(0);
            // Should mention one of the allowed scheme names
            expect(errorText ?? '').toMatch(/https?:\/\/|file:\/\/|localhost|scheme|Scheme/i);
        });
    }
});
