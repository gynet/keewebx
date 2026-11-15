import { expect, test } from '@playwright/test';
import { activateEntryAction } from '../entry-actions';

for (const width of [320, 390, 1280]) test.describe(`Entry password copy at ${width}px`, () => {
    test.use({ viewport: { width, height: 740 }, hasTouch: width < 400 });
    for (const sharing of ['unsupported', 'rejected'] as const) {
        test(`${sharing} sharing offers confirmed copy with real clipboard readback`, async ({ page, browserName }) => {
            test.skip(browserName !== 'chromium', 'Native clipboard readback permissions are Chromium-only in core config.');
            await page.addInitScript(sharing => Object.defineProperty(navigator, 'share', {
                configurable: true,
                value: sharing === 'unsupported' ? undefined : async () => { throw new DOMException('Unsupported share target', 'NotSupportedError'); }
            }), sharing);
            const activate = (button: ReturnType<typeof page.getByRole>) => width < 400 ? button.tap() : button.click();
            await page.goto('next.html');
            await page.locator('#open-demo').click();
            await activate(page.locator('.entry-row[data-entry="GitHub"]'));
            await activate(page.getByRole('button', { name: 'Show password', exact: true }));
            const password = await page.locator('[data-field="password"] .field__value').innerText();
            expect(password.length).toBeGreaterThan(0);
            await activate(page.getByRole('button', { name: 'Hide password', exact: true }));
            const sentinel = 'Leave clipboard unchanged until confirmation';
            await page.evaluate(value => navigator.clipboard.writeText(value), sentinel);
            const copy = page.getByRole('dialog', { name: 'Copy password', exact: true });
            const actions = page.getByRole('group', { name: 'Entry actions', exact: true });
            const triggerName = sharing === 'unsupported' ? 'Copy password…' : 'Share password…';
            const openCopy = async () => {
                await activateEntryAction(page, triggerName, width < 400);
                if (sharing === 'rejected') {
                    const share = page.getByRole('dialog', { name: 'Share password', exact: true });
                    await expect(share).toBeVisible();
                    await activate(share.getByRole('button', { name: 'Share password', exact: true }));
                } else {
                    await expect(actions.getByRole('button', { name: 'Share password…', exact: true, includeHidden: true })).toHaveCount(0);
                }
                await expect(copy).toBeVisible();
                await expect(copy).toContainText('Copy the password to the clipboard?');
                await expect(copy.getByRole('alert')).toHaveCount(0);
                await expect(copy).not.toContainText(/unavailable|not supported/i);
                expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(sentinel);
            };
            await openCopy();
            await activate(copy.getByRole('button', { name: 'Cancel', exact: true }));
            await expect(copy).toBeHidden();
            expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(sentinel);
            await expect(actions.getByRole('button', { name: triggerName, exact: true })).toBeFocused();
            await openCopy();
            await activate(copy.getByRole('button', { name: 'Copy password', exact: true }));
            await expect(copy).toBeHidden();
            await expect(actions.getByRole('status')).toHaveText('Password copied.');
            expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(password);
            expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        });
    }
});
