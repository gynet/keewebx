import { defineConfig, devices } from '@playwright/test';
const port = Number(process.env.KEEWEBX_E2E_PORT || 8155);
export default defineConfig({
    testDir: '.', testMatch: 'backup.spec.ts', workers: 1, timeout: 90_000, reporter: 'list',
    outputDir: '../../.cache/backup/results',
    use: { headless: true, baseURL: `http://127.0.0.1:${port}`, serviceWorkers: 'block', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
    projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }, { name: 'firefox', use: { ...devices['Desktop Firefox'] } }],
    webServer: { command: 'bun e2e/backup/serve.ts', cwd: '../..', url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 120000 }
});
