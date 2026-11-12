import { defineConfig } from '@playwright/test';

// Serve a compiled, extension-enabled app separately. This config never builds
// or changes a running server. Chromium's full headless channel loads the real
// packaged extension into disposable profiles; Firefox lacks this loader API.
export default defineConfig({
    testDir: '.',
    testMatch: 'new-interface-connection.spec.ts',
    workers: 1,
    retries: 0,
    timeout: 60_000,
    expect: { timeout: 12_000 },
    reporter: 'line',
    outputDir: '../test-results-new-extension'
});
