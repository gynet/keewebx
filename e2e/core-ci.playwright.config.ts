import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

// Build once before this config: KEEWEBX_NEW_EXTENSION=1 bun run build.
// This server only reads dist; it never starts webpack or opens a browser window.
// Examples: --project=new-chromium, --project=new-firefox,
//           --project=classic-chromium, --project=classic-firefox.
const port = Number(process.env.KEEWEBX_E2E_PORT || 8112);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid KEEWEBX_E2E_PORT');
const baseURL = `http://localhost:${port}`;

export default defineConfig({
    testDir: './core',
    globalSetup: './core-ci.global-setup.ts',
    forbidOnly: !!process.env.CI,
    fullyParallel: false,
    workers: 1,
    retries: 0,
    timeout: 60_000,
    reporter: [
        ['line'],
        ['html', { open: 'never', outputFolder: resolve(__dirname, '../playwright-report/core-ci') }],
        ['json', { outputFile: resolve(__dirname, '../playwright-report/core-ci/results.json') }]
    ],
    outputDir: './test-results-core-ci',
    use: {
        baseURL,
        headless: true,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure'
    },
    projects: [
        {
            name: 'new-chromium',
            testMatch: '**/next-*.spec.ts',
            use: { ...devices['Desktop Chrome'], channel: 'chromium', permissions: ['clipboard-read', 'clipboard-write'] }
        },
        {
            name: 'new-firefox',
            testMatch: '**/next-*.spec.ts',
            use: { ...devices['Desktop Firefox'] }
        },
        {
            name: 'classic-chromium',
            testIgnore: '**/next-*.spec.ts',
            use: { ...devices['Desktop Chrome'], channel: 'chromium', permissions: ['clipboard-read', 'clipboard-write'] }
        },
        {
            name: 'classic-firefox',
            testIgnore: '**/next-*.spec.ts',
            use: { ...devices['Desktop Firefox'] }
        }
    ],
    // Keep browser-API limitations at the individual test, with their reason.
    // WebAuthn virtual authenticators and native touch injection use Chromium CDP;
    // native clipboard readback also uses Chromium-only Playwright permissions.
    // Every portable case remains discovered in both browsers, with no failure-based exclusions.
    webServer: {
        command: 'bun e2e/serve-app.ts',
        cwd: resolve(__dirname, '..'),
        env: { KEEWEBX_E2E_PORT: String(port) },
        url: `${baseURL}/next.html`,
        reuseExistingServer: false,
        timeout: 30_000
    }
});
