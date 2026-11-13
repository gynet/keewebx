import { test, expect } from '@playwright/test';
import * as kdbxweb from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

test('large navigation scrolls independently while footer actions stay visible and clickable', async ({ page }) => {
    kdbxweb.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('sidebar')), 'Large vault');
    for (let i = 0; i < 60; i++) {
        const group = db.createGroup(db.groups[0], `Folder ${i}`);
        const entry = db.createEntry(group);
        entry.fields.set('Title', `Entry ${i}`);
        entry.tags = [`tag-${i}`];
    }
    await page.setViewportSize({ width: 1024, height: 480 });
    await page.goto('/next.html');
    await page.setInputFiles('#open-file-input', { name: 'large.kdbx', mimeType: 'application/octet-stream', buffer: Buffer.from(await db.save()) });
    await page.fill('#password', 'sidebar');
    await page.click('#unlock');
    const footer = page.locator('.side__foot');
    await expect(footer).toBeVisible();
    const initial = (await footer.boundingBox())!;
    expect(initial.y + initial.height).toBeLessThanOrEqual(480);
    const content = page.locator('.side__content');
    expect(await content.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    await content.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    expect((await footer.boundingBox())!.y).toBe(initial.y);
    await page.locator('#open-settings').click();
    await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'Theme' })).toBeVisible();
    await page.click('#settings-back');
    await page.setViewportSize({ width: 1024, height: 320 });
    const shorter = (await footer.boundingBox())!;
    expect(shorter.y).toBeGreaterThanOrEqual(0);
    expect(shorter.y + shorter.height).toBeLessThanOrEqual(320);
    await page.click('#lock');
    await expect(page.locator('#password')).toBeVisible();
});
