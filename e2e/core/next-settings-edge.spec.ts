import { test, expect, type Locator, type Page } from '@playwright/test';
import path from 'node:path';

const password = 'settings edge password';
const vaultName = 'Settings edge';
const aesFixture = path.resolve(__dirname,
    '../../modules/db/resources/external/test_db_kdbx4_with_password_aes.kdbx');

async function setArgon2(form: Locator, kdf: 'Argon2d' | 'Argon2id', iterations: string,
    memory: string, parallelism: string) {
    await form.getByLabel('Key derivation function', { exact: true }).selectOption(kdf);
    await form.getByLabel('Iterations', { exact: true }).fill(iterations);
    await form.getByLabel('Memory, KiB', { exact: true }).fill(memory);
    await form.getByLabel('Parallelism', { exact: true }).fill(parallelism);
}

async function prepareCreation(page: Page, name = vaultName) {
    await page.getByRole('button', { name: 'Create a vault', exact: true }).click();
    const form = page.getByRole('form', { name: 'Create a vault', exact: true });
    await form.getByLabel('Vault name', { exact: true }).fill(name);
    await form.getByText('Advanced', { exact: true }).click();
    await form.getByLabel('Default user', { exact: true }).fill('original-user');
    await form.getByLabel('Enable trash', { exact: true }).check();
    await form.getByLabel('History length, records per entry', { exact: true }).fill('17');
    await setArgon2(form, 'Argon2d', '3', '16384', '2');
    await form.getByLabel('Master password', { exact: true }).fill(password);
    await form.getByLabel('Confirm password', { exact: true }).fill(password);
    return form;
}

async function createVault(page: Page, name = vaultName) {
    const form = await prepareCreation(page, name);
    await form.getByRole('button', { name: 'Create vault', exact: true }).click();
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout: 30_000 });
}

async function openSettings(page: Page) {
    await page.locator('#open-settings').click();
    const form = page.getByRole('form', { name: /^Database settings: / });
    await expect(form).toBeVisible();
    await form.getByText('Advanced', { exact: true }).click();
    return form;
}

async function cancelAndReopenSettings(page: Page, form: Locator) {
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(form).toHaveCount(0);
    await expect(page.locator('#settings-back')).toHaveCount(0);
    return openSettings(page);
}

async function expectOriginalSettings(form: Locator) {
    await expect(form.getByLabel('Vault name', { exact: true })).toHaveValue(vaultName);
    await expect(form.getByLabel('Default user', { exact: true })).toHaveValue('original-user');
    await expect(form.getByLabel('Enable trash', { exact: true })).toBeChecked();
    await expect(form.getByLabel('History length, records per entry', { exact: true })).toHaveValue('17');
    await expect(form.getByLabel('Key derivation function', { exact: true })).toHaveValue('Argon2d');
    await expect(form.getByLabel('Iterations', { exact: true })).toHaveValue('3');
    await expect(form.getByLabel('Memory, KiB', { exact: true })).toHaveValue('16384');
    await expect(form.getByLabel('Parallelism', { exact: true })).toHaveValue('2');
}

async function lock(page: Page) {
    await page.locator('#lock').click();
    await expect(page.locator('#password')).toBeVisible({ timeout: 30_000 });
}

async function reloadAndUnlock(page: Page, secret = password) {
    await page.reload();
    await page.locator('#password').fill(secret);
    await page.locator('#unlock').click();
    await expect(page.locator('#open-settings')).toBeVisible({ timeout: 30_000 });
}

async function confirmAction(page: Page, action: Locator, accept: boolean, message: RegExp) {
    const seen: { type: string; message: string }[] = [];
    const handler = async (dialog: import('@playwright/test').Dialog) => {
        seen.push({ type: dialog.type(), message: dialog.message() });
        if (accept) await dialog.accept();
        else await dialog.dismiss();
    };
    page.on('dialog', handler);
    try {
        await action.click();
        // A missing dialog must fail rather than Playwright's automatic dismissal masking it.
        expect(seen).toHaveLength(1);
        expect(seen[0].type).toBe('confirm');
        expect(seen[0].message).toMatch(message);
    } finally {
        page.off('dialog', handler);
    }
}

// Read-only browser storage inspection; all creation, edits and deletion use the UI.
// Enumerate first so inspecting a missing cache cannot accidentally create one.
async function cachedKeys(page: Page): Promise<string[]> {
    return page.evaluate(async () => {
        const databases = (await indexedDB.databases()).filter(({ name }) =>
            name === 'FilesCache' || name?.endsWith(':FilesCache'));
        if (!databases.length) return [];
        if (databases.length !== 1) throw new Error('Expected one vault cache in this fresh browser context');
        return new Promise<string[]>((resolve, reject) => {
            const request = indexedDB.open(databases[0].name!);
            request.onerror = () => reject(request.error);
            request.onblocked = () => reject(new Error('Vault cache inspection was blocked'));
            request.onupgradeneeded = () => request.transaction!.abort();
            request.onsuccess = () => {
                const db = request.result;
                try {
                    const transaction = db.transaction('files', 'readonly');
                    const keys = transaction.objectStore('files').getAllKeys();
                    transaction.oncomplete = () => {
                        db.close();
                        if (keys.result.some((key) => typeof key !== 'string')) {
                            reject(new Error('Expected string vault cache keys'));
                        } else resolve((keys.result as string[]).sort());
                    };
                    transaction.onabort = () => { db.close(); reject(transaction.error); };
                } catch (error) { db.close(); reject(error); }
            };
        });
    });
}

test.describe('Next database settings edge cases', () => {
    test.setTimeout(90_000);
    test.beforeEach(async ({ page }) => { await page.goto('/next.html'); });

    const invalidParameters = [
        { name: 'memory below the per-thread minimum', label: 'Memory, KiB', value: '8', native: false },
        { name: 'fractional iterations', label: 'Iterations', value: '1.5', native: false },
        { name: 'fractional parallelism', label: 'Parallelism', value: '1.5', native: false },
        { name: 'empty memory', label: 'Memory, KiB', value: '', native: true },
        { name: 'zero iterations', label: 'Iterations', value: '0', native: true }
    ];

    for (const invalid of invalidParameters) {
        test(`rejects ${invalid.name} before applying any database edits`, async ({ page }) => {
            await createVault(page);
            const form = await openSettings(page);
            await form.getByLabel('Vault name', { exact: true }).fill('Must not be applied');
            await form.getByLabel('Default user', { exact: true }).fill('must-not-be-applied');
            await form.getByLabel('Enable trash', { exact: true }).uncheck();
            await form.getByLabel('History length, records per entry', { exact: true }).fill('9');
            await setArgon2(form, 'Argon2id', '4', '16384', '2');
            const field = form.getByLabel(invalid.label, { exact: true });
            await field.fill(invalid.value);
            // Non-native cases are deliberately valid HTML inputs: application validation
            // must catch cross-field and integer constraints before touching the database.
            expect(await field.evaluate((input: HTMLInputElement) => input.validity.valid)).toBe(!invalid.native);
            await form.getByRole('button', { name: 'Save database settings', exact: true }).click();
            if (invalid.native) {
                expect(await field.evaluate((input: HTMLInputElement) => input.validationMessage)).not.toBe('');
            } else {
                await expect(form.getByRole('status')).toContainText('Invalid Argon2 parameters');
            }
            await expect(form.getByRole('status').filter({ hasText: 'Database settings saved.' })).toHaveCount(0);
            await expect(form.getByRole('heading', { level: 3 })).toHaveText(vaultName);
            await expect(field).toHaveValue(invalid.value);

            // Reopening after Cancel must not expose a partially applied submission
            // as the new baseline. Reload also checks durable state.
            await cancelAndReopenSettings(page, form);
            await expectOriginalSettings(form);
            await page.locator('#settings-back').click();
            await lock(page);
            await reloadAndUnlock(page);
            await expectOriginalSettings(await openSettings(page));
        });
    }

    test('invalid Argon2 creation leaves no cached vault and can be corrected in place', async ({ page }) => {
        const form = await prepareCreation(page);
        await form.getByLabel('Memory, KiB', { exact: true }).fill('8');
        await form.getByRole('button', { name: 'Create vault', exact: true }).click();
        await expect(form.getByRole('alert')).toContainText('Invalid Argon2 parameters');
        await expect(page.locator('[data-vault]')).toHaveCount(0);
        await expect(page.locator('#open-settings')).toHaveCount(0);
        expect(await cachedKeys(page)).toEqual([]);
        await expect(form.getByLabel('Vault name', { exact: true })).toHaveValue(vaultName);
        await expect(form.getByLabel('Master password', { exact: true })).toHaveValue(password);

        await form.getByLabel('Memory, KiB', { exact: true }).fill('16384');
        await form.getByRole('button', { name: 'Create vault', exact: true }).click();
        await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout: 30_000 });
        await lock(page);
        await expect(page.locator('[data-vault]')).toHaveCount(1);
        await expect.poll(async () => (await cachedKeys(page)).length).toBe(1);
        await reloadAndUnlock(page);
        await expectOriginalSettings(await openSettings(page));
    });

    test('cancel restores the existing Argon2 algorithm and non-default parameters', async ({ page }) => {
        await createVault(page);
        const form = await openSettings(page);
        await setArgon2(form, 'Argon2id', '5', '8192', '1');
        await cancelAndReopenSettings(page, form);
        await expectOriginalSettings(form);
        await page.locator('#settings-back').click();
        await lock(page);
        await reloadAndUnlock(page);
        await expectOriginalSettings(await openSettings(page));
    });

    test('canceling an Argon2 migration preserves an imported AES KDF even after another setting is saved', async ({ page }) => {
        await page.setInputFiles('#open-file-input', aesFixture);
        await page.locator('#password').fill('demopass');
        await page.locator('#unlock').click();
        await expect(page.locator('.entry-row[data-entry="ASDF"]')).toBeVisible({ timeout: 30_000 });
        const form = await openSettings(page);
        await expect(form.getByLabel('Key derivation function', { exact: true })).toHaveValue('Aes');
        await setArgon2(form, 'Argon2id', '3', '16384', '2');
        await cancelAndReopenSettings(page, form);
        await expect(form.getByLabel('Key derivation function', { exact: true })).toHaveValue('Aes');
        await expect(form.getByLabel('Iterations', { exact: true })).toHaveCount(0);
        await form.getByLabel('Default user', { exact: true }).fill('AES retained');
        await form.getByRole('button', { name: 'Save database settings', exact: true }).click();
        await expect(form.getByRole('status')).toHaveText('Database settings saved.');
        await page.locator('#settings-back').click();
        await lock(page);
        await reloadAndUnlock(page, 'demopass');
        const reopened = await openSettings(page);
        await expect(reopened.getByLabel('Key derivation function', { exact: true })).toHaveValue('Aes');
        await expect(reopened.getByLabel('Default user', { exact: true })).toHaveValue('AES retained');
    });

    for (const invalid of [false, true]) {
        test(`Back cannot silently drop ${invalid ? 'an invalid' : 'a valid'} database draft`, async ({ page }) => {
            await createVault(page);
            const form = await openSettings(page);
            await form.getByLabel('Vault name', { exact: true }).fill('Retained draft');
            await form.getByLabel('Default user', { exact: true }).fill('retained-user');
            await setArgon2(form, 'Argon2id', '4', invalid ? '8' : '8192', '2');
            await confirmAction(page, page.locator('#settings-back'), false, /discard unsaved changes/i);
            await expect(form).toBeVisible();
            await expect(form.getByLabel('Vault name', { exact: true })).toHaveValue('Retained draft');
            await expect(form.getByLabel('Default user', { exact: true })).toHaveValue('retained-user');
            await expect(form.getByLabel('Key derivation function', { exact: true })).toHaveValue('Argon2id');
            await expect(form.getByLabel('Iterations', { exact: true })).toHaveValue('4');
            await expect(form.getByLabel('Memory, KiB', { exact: true })).toHaveValue(invalid ? '8' : '8192');
            await expect(form.getByLabel('Parallelism', { exact: true })).toHaveValue('2');
            if (invalid) await form.getByLabel('Memory, KiB', { exact: true }).fill('8192');
            await form.getByRole('button', { name: 'Save database settings', exact: true }).click();
            await expect(form.getByRole('status')).toHaveText('Database settings saved.');
            await page.locator('#settings-back').click();
            await lock(page);
            await reloadAndUnlock(page);
            const reopened = await openSettings(page);
            await expect(reopened.getByLabel('Vault name', { exact: true })).toHaveValue('Retained draft');
            await expect(reopened.getByLabel('Default user', { exact: true })).toHaveValue('retained-user');
            await expect(reopened.getByLabel('Key derivation function', { exact: true })).toHaveValue('Argon2id');
            await expect(reopened.getByLabel('Iterations', { exact: true })).toHaveValue('4');
            await expect(reopened.getByLabel('Memory, KiB', { exact: true })).toHaveValue('8192');
            await expect(reopened.getByLabel('Parallelism', { exact: true })).toHaveValue('2');
        });
    }

    test('Back discards database edits only after explicit confirmation', async ({ page }) => {
        await createVault(page);
        const form = await openSettings(page);
        await form.getByLabel('Vault name', { exact: true }).fill('Discarded draft');
        await form.getByLabel('Default user', { exact: true }).fill('discarded-user');
        await setArgon2(form, 'Argon2id', '5', '8192', '1');
        await confirmAction(page, page.locator('#settings-back'), true, /discard unsaved changes/i);
        await expect(form).toHaveCount(0);
        await expectOriginalSettings(await openSettings(page));
        await page.locator('#settings-back').click();
        await lock(page);
        await reloadAndUnlock(page);
        await expectOriginalSettings(await openSettings(page));
    });

    test('Cancel closes database settings without discarding an unrelated entry draft', async ({ page }) => {
        await createVault(page);
        await page.getByRole('button', { name: 'New entry', exact: true }).click();
        const editor = page.locator('.entry-editor');
        await editor.getByLabel('Title', { exact: true }).fill('Entry draft survives settings Cancel');
        await editor.getByLabel('Password', { exact: true }).fill('Unrelated protected draft');
        const form = await openSettings(page);
        await form.getByLabel('Default user', { exact: true }).fill('Discard this database draft');
        await form.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(form).toHaveCount(0);
        await expect(page.locator('#settings-back')).toHaveCount(0);
        await expect(editor.getByLabel('Title', { exact: true })).toHaveValue('Entry draft survives settings Cancel');
        await expect(editor.getByLabel('Password', { exact: true })).toHaveValue('Unrelated protected draft');
        await expectOriginalSettings(await openSettings(page));
        await form.getByRole('button', { name: 'Cancel', exact: true }).click();
        await editor.getByRole('button', { name: 'Save', exact: true }).click();
        await lock(page);
        await reloadAndUnlock(page);
        await page.locator('.entry-row[data-entry="Entry draft survives settings Cancel"]').click();
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        await expect(editor.getByLabel('Password', { exact: true })).toHaveValue('Unrelated protected draft');
    });

    test('browser-local removal deletes its IndexedDB record and preserves another cached vault', async ({ page }) => {
        await createVault(page, 'Keep this vault');
        await lock(page);
        await expect.poll(async () => (await cachedKeys(page)).length).toBe(1);
        const keeperKeys = await cachedKeys(page);
        await createVault(page, 'Delete this vault');
        await lock(page);
        await expect.poll(async () => (await cachedKeys(page)).length).toBe(2);
        const before = await cachedKeys(page);
        const targetKeys = before.filter((key) => !keeperKeys.includes(key));
        expect(targetKeys).toHaveLength(1);

        const remove = page.getByRole('button', { name: 'Remove Delete this vault.kdbx from this browser', exact: true });
        await page.locator('.vault-row-wrap').filter({ has: remove }).hover();
        await confirmAction(page, remove, false, /Remove Delete this vault\.kdbx from this browser\?/);
        await expect(remove).toBeVisible();
        expect(await cachedKeys(page)).toEqual(before);
        await confirmAction(page, remove, true, /Remove Delete this vault\.kdbx from this browser\?/);
        await expect(remove).toHaveCount(0);
        // A disappearing recent-file row alone cannot prove encrypted bytes were deleted.
        await expect.poll(() => cachedKeys(page), { timeout: 10_000 }).toEqual(keeperKeys);
        expect(await cachedKeys(page)).not.toContain(targetKeys[0]);
        await page.reload();
        await expect(page.locator('[data-vault]')).toHaveCount(1);
        await expect(page.locator('[data-vault="Keep this vault"]')).toBeVisible();
        expect(await cachedKeys(page)).toEqual(keeperKeys);
        await page.locator('[data-vault="Keep this vault"]').click();
        await page.locator('#password').fill(password);
        await page.locator('#unlock').click();
        await expect(page.locator('#open-settings')).toBeVisible({ timeout: 30_000 });
        const surviving = await openSettings(page);
        await expect(surviving.getByLabel('Vault name', { exact: true })).toHaveValue('Keep this vault');
        await expect(surviving.getByLabel('Default user', { exact: true })).toHaveValue('original-user');
    });
});
