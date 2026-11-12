import { test, expect, type Page } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const password = 'open recovery password';
const title = 'Recovered database entry';
const payload = (buffer: Buffer, name = 'recovery.kdbx') => ({
    name, mimeType: 'application/octet-stream', buffer
});

async function database() {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)), 'Recovery');
    db.createEntry(db.groups[0]).fields.set('Title', title);
    return Buffer.from(await db.save());
}

async function openSelected(page: Page) {
    await page.locator('#password').fill(password);
    await page.locator('#unlock').click();
    await expect(page.locator('.entry-row').filter({ hasText: title })).toBeVisible({ timeout: 30_000 });
}

async function recentVault(page: Page, buffer: Buffer) {
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles(payload(buffer));
    await openSelected(page);
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.locator('.vault-row--on')).toHaveAttribute('data-vault', 'recovery');
    await page.locator('#password').fill(password);
}

test('an unreadable file preserves the recent selection and password, then retries and opens real bytes', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const buffer = await database();
    await recentVault(page, buffer);
    await page.evaluate(() => {
        const original = File.prototype.arrayBuffer;
        File.prototype.arrayBuffer = function () {
            File.prototype.arrayBuffer = original;
            return Promise.reject(new DOMException('Unreadable fixture', 'NotReadableError'));
        };
    });
    await page.locator('#open-file-input').setInputFiles(payload(buffer, 'retry.kdbx'));
    await expect(page.getByRole('alert')).toContainText('Failed to read file');
    // A sync notification must rerender the app without remounting the unlock form.
    await page.evaluate(async () => {
        window.postMessage({ kwSyncState: {} }, window.location.origin);
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    });
    await expect(page.getByRole('alert')).toContainText('Failed to read file');
    await expect(page.locator('.vault-row--on')).toHaveAttribute('data-vault', 'recovery');
    await expect(page.locator('#password')).toHaveValue(password);
    await expect(page.locator('#unlock')).toBeEnabled();
    await expect(page.locator('#open-file-input')).toHaveValue('');
    await page.getByRole('button', { name: 'Retry reading file', exact: true }).click();
    await expect(page.locator('.card__title')).toHaveText('retry.kdbx');
    await expect(page.locator('#open-file-error')).toHaveCount(0);
    await openSelected(page);
    expect(errors).toEqual([]);
});

test('short, unrelated and legacy KDB bytes leave the selected vault and password usable', async ({ page }) => {
    const buffer = await database();
    await recentVault(page, buffer);
    const kdb = Buffer.alloc(8);
    kdb.writeUInt32LE(kdbx.Consts.Signatures.FileMagic, 0);
    kdb.writeUInt32LE(kdbx.Consts.Signatures.Sig2Kdb, 4);
    for (const invalid of [
        { bytes: Buffer.alloc(0), name: 'empty.kdbx', message: 'This file format is not supported.' },
        { bytes: buffer.subarray(0, 7), name: 'short.kdbx', message: 'This file format is not supported.' },
        { bytes: Buffer.from('not a database'), name: 'wrong.kdbx', message: 'This file format is not supported.' },
        { bytes: kdb, name: 'legacy.kdb', message: 'please use KeePass v2 to convert between them.' }
    ]) {
        await page.locator('#open-file-input').setInputFiles(payload(invalid.bytes, invalid.name));
        await expect(page.locator('#open-file-error')).toContainText(invalid.message);
        await expect(page.locator('.vault-row--on')).toHaveAttribute('data-vault', 'recovery');
        await expect(page.locator('#password')).toHaveValue(password);
        await expect(page.getByRole('button', { name: 'Choose another file', exact: true })).toBeVisible();
    }
    await page.locator('#unlock').click();
    await expect(page.locator('.entry-row').filter({ hasText: title })).toBeVisible({ timeout: 30_000 });
});

test('a truncated KDBX reports an open error and permits a valid replacement and password retry', async ({ page }) => {
    const buffer = await database();
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles(payload(buffer.subarray(0, 16), 'truncated.kdbx'));
    await page.locator('#password').fill(password);
    await page.locator('#unlock').click();
    await expect(page.locator('#unlock-error')).toHaveText('There was an error opening file. Try again or choose another file.');
    const details = page.locator('#unlock-error-details');
    await expect(details).not.toHaveAttribute('open', '');
    await expect(details.locator('pre')).toBeHidden();
    await expect(details.locator('pre')).toContainText('RangeError');
    await details.locator('summary').click();
    await expect(details.locator('pre')).toBeVisible();
    // Repeating the same failure returns to the friendly, collapsed presentation.
    await page.locator('#unlock').click();
    await expect(details.locator('pre')).toContainText('RangeError');
    await expect(details.locator('pre')).toBeHidden();
    await expect(page.locator('#password')).toHaveValue(password);
    await expect(page.locator('#unlock')).toBeEnabled();
    await expect(page.locator('.entry-row')).toHaveCount(0);
    await page.locator('#open-file-input').setInputFiles(payload(buffer, 'truncated.kdbx'));
    await expect(page.locator('#unlock-error')).toHaveCount(0);
    await expect(details).toHaveCount(0);
    await page.locator('#password').fill('wrong password');
    await page.locator('#unlock').click();
    await expect(page.locator('#unlock-error')).toHaveText('Wrong password');
    await expect(details).toHaveCount(0);
    await openSelected(page);
});

type HeldRead = { finish(reject: boolean): void; settled: Promise<void> };

async function holdRead(page: Page) {
    await page.evaluate(() => {
        const original = File.prototype.arrayBuffer;
        let finish!: (reject: boolean) => void;
        const gate = new Promise<boolean>(resolve => { finish = resolve; });
        const control: HeldRead = { finish, settled: Promise.resolve() };
        (window as unknown as { heldRead: HeldRead }).heldRead = control;
        File.prototype.arrayBuffer = function () {
            if (this.name !== 'slow.kdbx') return original.call(this);
            File.prototype.arrayBuffer = original;
            const result = original.call(this).then(async bytes => {
                if (await gate) throw new DOMException('Late read failure', 'NotReadableError');
                return bytes;
            });
            control.settled = result.then(() => {}, () => {});
            return result;
        };
    });
}

async function finishRead(page: Page, reject: boolean) {
    await page.evaluate(async reject => {
        const control = (window as unknown as { heldRead: HeldRead }).heldRead;
        control.finish(reject);
        await control.settled;
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    }, reject);
}

for (const destination of ['recent', 'create', 'webdav', 'newer file', 'unlock'] as const) {
    for (const reject of [false, true]) {
        test(`late read ${reject ? 'failure' : 'success'} cannot replace ${destination}`, async ({ page }) => {
            const errors: string[] = [];
            page.on('pageerror', error => errors.push(error.message));
            const buffer = await database();
            await recentVault(page, buffer);
            await holdRead(page);
            await page.locator('#open-file-input').setInputFiles(payload(buffer, 'slow.kdbx'));
            await expect(page.getByRole('status')).toHaveText('Reading file…');
            const selected = destination === 'recent' ? 'recovery.kdbx'
                : destination === 'create' ? 'Create a vault'
                : destination === 'webdav' ? 'Connect to WebDAV' : 'newer.kdbx';
            if (destination === 'recent') await page.locator('.vault-row[data-vault="recovery"]').click();
            else if (destination === 'create') await page.locator('#create-vault').click();
            else if (destination === 'webdav') await page.locator('#open-webdav').click();
            else if (destination === 'newer file') {
                await page.locator('#open-file-input').setInputFiles(payload(buffer, 'newer.kdbx'));
            } else await page.locator('#unlock').click();
            if (destination !== 'unlock') await expect(page.locator('.card__title')).toHaveText(selected);
            await finishRead(page, reject);
            if (destination === 'unlock') {
                await expect(page.locator('.entry-row').filter({ hasText: title })).toBeVisible({ timeout: 30_000 });
            } else {
                await expect(page.locator('.card__title')).toHaveText(selected);
                if (destination === 'recent') await expect(page.locator('#password')).toHaveValue(password);
            }
            await expect(page.locator('#open-file-error')).toHaveCount(0);
            expect(errors).toEqual([]);
        });
    }
}
