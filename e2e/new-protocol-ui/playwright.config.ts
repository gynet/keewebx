import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
    testDir: '.', testMatch: 'ui.spec.ts', workers: 1, reporter: 'list',
    outputDir: '../../.cache/new-protocol-ui/results',
    use: { headless: true, baseURL: 'http://127.0.0.1:8097', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'firefox', use: { ...devices['Desktop Firefox'] } }
    ],
    webServer: { command: 'bun e2e/new-protocol-ui/serve.ts', cwd: '../..',
        url: 'http://127.0.0.1:8097', reuseExistingServer: false, timeout: 120000 }
});
