import { test as base, chromium, type BrowserContext } from '@playwright/test';
import path from 'path';

export const test = base.extend<{
    context: BrowserContext;
    extensionId: string;
}>({
    context: async ({}, use) => {
        const pathToExtension = path.join(__dirname, '..', 'dist', 'chrome');
        const context = await chromium.launchPersistentContext('', {
            channel: 'chromium',
            args: [
                `--disable-extensions-except=${pathToExtension}`,
                `--load-extension=${pathToExtension}`,
            ],
        });
        await use(context);
        await context.close();
    },
    extensionId: async ({ context }, use) => {
        let [sw] = context.serviceWorkers();
        if (!sw) sw = await context.waitForEvent('serviceworker');
        const extensionId = sw.url().split('/')[2];
        await use(extensionId);
    },
});

export const expect = test.expect;
