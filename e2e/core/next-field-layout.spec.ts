import { test, expect } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

for (const colorScheme of ['light', 'dark'] as const) {
    test.describe(`Long field labels — ${colorScheme}`, () => {
        test.use({ viewport: { width: 320, height: 350 }, hasTouch: true, colorScheme });
        test('keeps an unbroken custom field name and its copy action inside the detail panel', async ({ page }, info) => {
            kdbx.CryptoEngine.setArgon2Impl(argon2);
            const password = 'disposable layout password';
            const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)), 'Field layout');
            const entry = db.createEntry(db.groups[0]);
            const fieldName = 'LongFieldName'.repeat(12);
            entry.fields.set('Title', 'Long field layout');
            entry.fields.set(fieldName, 'LongValue'.repeat(30));
            await page.goto('/next.html');
            await page.locator('#open-file-input').setInputFiles({
                name: 'layout.kdbx', mimeType: 'application/octet-stream', buffer: Buffer.from(await db.save())
            });
            await page.locator('#password').fill(password);
            await page.locator('#unlock').click();
            await page.locator('.entry-row').filter({ hasText: 'Long field layout' }).tap();
            const field = page.locator('.field').filter({ has: page.getByText(fieldName, { exact: true }) });
            await field.scrollIntoViewIfNeeded();
            await expect(field.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
            for (const node of [page.locator('main.detail'), field, field.locator('.field__text')]) {
                expect(await node.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
            }
            const button = await field.getByRole('button', { name: 'Copy', exact: true }).boundingBox();
            expect(button!.x).toBeGreaterThanOrEqual(0);
            expect(button!.x + button!.width).toBeLessThanOrEqual(320);
            await page.screenshot({ path: info.outputPath('long-custom-field.png'), fullPage: true });
        });
    });
}
