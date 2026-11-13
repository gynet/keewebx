import { defineConfig, devices } from '@playwright/test';
const port = Number(process.env.KEEWEBX_E2E_PORT || 8097);
export default defineConfig({
    testDir: '.', testMatch: 'ui.spec.ts', workers: 1, reporter: 'list',
    outputDir: '../../.cache/new-protocol-ui/results',
    use: { headless: true, baseURL: `http://127.0.0.1:${port}`, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'firefox', use: { ...devices['Desktop Firefox'] } }
    ],
    webServer: { command: 'bun e2e/new-protocol-ui/serve.ts', cwd: '../..',
        url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 120000 }
});
