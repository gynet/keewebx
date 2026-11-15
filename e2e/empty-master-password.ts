import { expect, type Page } from '@playwright/test';

/** Follow the visible warning while retaining the existing key-only credentials. */
export async function withEmptyMasterPasswordConsent(page: Page, expected: boolean, action: () => Promise<unknown>) {
    if (!expected) { await action(); return; }
    await Promise.all([
        page.waitForEvent('dialog').then(async dialog => {
            expect(dialog.type()).toBe('confirm');
            expect(dialog.message()).toContain('no master password');
            expect(dialog.message()).toContain('existing credentials');
            await dialog.accept();
        }),
        action()
    ]);
}
