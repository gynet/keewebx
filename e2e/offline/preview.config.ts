import { defineConfig, devices } from '@playwright/test';

// Production assets must be built first. No dev server or external origin.
export default defineConfig({
    testDir: '.', testMatch: 'preview.spec.ts',
    workers: 1, retries: 0, timeout: 45000, fullyParallel: false,
    outputDir: '../../test-results/offline-preview', reporter: 'list',
    use: { headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
    projects: [
        { name: 'chromium', use: { ...devices['Desktop Chrome'],
            launchOptions: { executablePath: process.env.KEEWEBX_CHROMIUM_EXECUTABLE } } },
        { name: 'firefox', use: { ...devices['Desktop Firefox'],
            launchOptions: { executablePath: process.env.KEEWEBX_FIREFOX_EXECUTABLE } } }
    ]
});
