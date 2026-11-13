import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

// Isolated, synthetic recovery tests; never reuse a server from another checkout.
const root = resolve(__dirname, '..');
const port = Number(process.env.KEEWEBX_E2E_PORT || 8099);
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
    testDir: './core',
    testMatch: 'next-remote-key-recovery.spec.ts',
    workers: 1,
    retries: 0,
    reporter: [['list']],
    outputDir: './test-results-remote-key/final',
    use: { headless: true, baseURL, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
        { name: 'firefox', use: { ...devices['Desktop Firefox'] } }
    ],
    webServer: {
        cwd: root,
        command: 'bun run --filter @keewebx/db build && bun run --filter @keewebx/ui build && bun e2e/serve-app.ts',
        env: { KEEWEBX_E2E_PORT: String(port) },
        url: `${baseURL}/next.html`,
        reuseExistingServer: false,
        timeout: 180_000
    }
});
