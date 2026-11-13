import { test, expect } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const password = 'Disposable Classic cache password';
const edited = 'Classic durable latest edit';
const credentials = () => new kdbx.Credentials(kdbx.ProtectedValue.fromString(password));

for (const mode of ['quota', 'abort'] as const) test(`Classic ${mode}: failed cache commit prevents lock and retry preserves encrypted content`, async ({ page }) => {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(credentials(), 'Classic cache');
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    const entry = db.createEntry(db.getDefaultGroup()); entry.fields.set('Title', 'Before edit');
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('Preserved Classic secret'));
    await page.goto('/index.html?ui=classic');
    const chooser = page.waitForEvent('filechooser'); await page.locator('#open__icon-open').click();
    await (await chooser).setFiles({ name: 'Classic cache.kdbx', mimeType: 'application/octet-stream', buffer: Buffer.from(await db.save()) });
    await page.locator('.modal__buttons button[data-result="ok"]').click();
    await page.locator('.open__pass-input').fill(password); await page.locator('.open__pass-enter-btn').click();
    await expect(page.locator('.list__item').first()).toBeVisible({ timeout: 30_000 });
    await page.evaluate(mode => {
        const put = IDBObjectStore.prototype.put;
        const state = { hits: 0, restore: () => { IDBObjectStore.prototype.put = put; } };
        (window as any).cacheFault = state;
        IDBObjectStore.prototype.put = function (...args) {
            if (!this.transaction.db.name.endsWith('FilesCache')) return put.apply(this, args as any);
            if (mode === 'quota') { ++state.hits; throw new DOMException('Controlled quota failure', 'QuotaExceededError'); }
            const req = put.apply(this, args as any), tx = this.transaction;
            req.addEventListener('success', () => { ++state.hits; tx.abort(); }); return req;
        };
    }, mode);
    await page.locator('.list__item').first().click(); await page.locator('.details__header-title').click();
    await page.locator('.details__header-title-input').fill(edited); await page.locator('.details__header-title-input').press('Enter');
    await expect.poll(() => page.evaluate(() => (window as any).cacheFault.hits), { timeout: 30_000 }).toBeGreaterThan(0);
    await page.locator('#footer__btn-lock').click();
    await expect(page.locator('.modal')).toBeVisible();
    await expect(page.locator('.list__item').filter({ hasText: edited })).toBeVisible();
    await expect(page.locator('.open__pass-input')).toHaveCount(0);
    await page.evaluate(() => (window as any).cacheFault.restore());
    await page.locator('.modal__buttons button').first().click(); await page.locator('#footer__btn-lock').click();
    await expect(page.locator('.open__pass-input')).toBeVisible({ timeout: 30_000 });
    const bytes = await page.evaluate(async () => {
        const name = (await indexedDB.databases()).find(db => db.name?.endsWith('FilesCache'))!.name!;
        return new Promise<number[]>((resolve, reject) => {
            const open = indexedDB.open(name); open.onerror = () => reject(open.error);
            open.onsuccess = () => {
                const db = open.result, get = db.transaction('files').objectStore('files').getAll();
                get.onsuccess = () => { db.close(); resolve([...new Uint8Array(get.result[0])]); }; get.onerror = () => reject(get.error);
            };
        });
    });
    const recovered = await kdbx.Kdbx.load(new Uint8Array(bytes).buffer, credentials());
    expect(recovered.getDefaultGroup().entries[0].fields.get('Title')).toBe(edited);
    expect((recovered.getDefaultGroup().entries[0].fields.get('Password') as kdbx.ProtectedValue).getText()).toBe('Preserved Classic secret');
    await page.reload(); await page.locator('.open__pass-input').fill(password); await page.locator('.open__pass-enter-btn').click();
    await expect(page.locator('.list__item').filter({ hasText: edited })).toBeVisible({ timeout: 30_000 });
});
