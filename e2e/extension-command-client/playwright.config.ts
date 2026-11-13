import { defineConfig } from '@playwright/test';
const port = Number(process.env.KEEWEBX_E2E_PORT || 8127);
export default defineConfig({
    testDir: '.', testMatch: 'commands.spec.ts', workers: 1, retries: 0,
    timeout: 90_000, expect: { timeout: 10_000 }, reporter: 'line',
    outputDir: '../../.cache/extension-command-results',
    webServer: { command: 'bun e2e/serve-app.ts', cwd: '../..',
        url: `http://127.0.0.1:${port}/next.html`, reuseExistingServer: false }
});
