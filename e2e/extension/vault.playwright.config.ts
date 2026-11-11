import { defineConfig } from '@playwright/test';

// Headless and self-contained: no dev server, no visible browser windows.
export default defineConfig({
    testDir: '.',
    testMatch: 'vault-extension.spec.ts',
    workers: 1,
    retries: 0,
    timeout: 120000,
    reporter: 'line'
});
