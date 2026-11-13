import { defineConfig, devices } from '@playwright/test';
const port = Number(process.env.KEEWEBX_E2E_PORT || 8123);
export default defineConfig({testDir: '.', testMatch: 'provider.spec.ts', workers: 1, retries: 0,
    timeout: 30000, use: {baseURL: `http://localhost:${port}`, headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure'},
    projects: [{name: 'chromium', use: {...devices['Desktop Chrome']}}, {name: 'firefox', use: {...devices['Desktop Firefox']}}],
    webServer: {command: 'bun e2e/serve-app.ts', cwd: '../..', env: {KEEWEBX_E2E_PORT: String(port)}, url: `http://localhost:${port}/next.html`, reuseExistingServer: false}
});
