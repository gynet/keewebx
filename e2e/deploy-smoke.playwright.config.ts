import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
const port = Number(process.env.KEEWEBX_E2E_PORT || 8138);
export default defineConfig({
    testDir: './deploy-smoke', workers: 1, retries: 0, timeout: 45_000,
    reporter: 'line', outputDir: './test-results-deploy',
    use: { baseURL: `http://localhost:${port}`, headless: true, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
    webServer: { command: 'bun e2e/serve-app.ts', cwd: resolve(__dirname, '..'),
        env: { KEEWEBX_E2E_PORT: String(port) }, url: `http://localhost:${port}/index.html`, reuseExistingServer: false }
});
