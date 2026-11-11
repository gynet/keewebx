import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './e2e',
    timeout: 30000,
    retries: 1,
    reporter: [['html', { open: 'never' }]],
    use: {
        headless: true,
        video: 'on',
        screenshot: 'on',
    },
    projects: [
        {
            name: 'chromium',
        },
    ],
});
