import { test, expect, type Page, type Locator } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const proof = Buffer.from([0, 1, 128, 200, 255, 0, 42]);
const historyProof = Buffer.from([255, 17, 0, 88]);
const timeout = 30_000;
const all = (db: kdbx.Kdbx) => db.groups.flatMap(root => [...root.allEntries()]);
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Move entry to another vault', exact: true });
const row = (page: Page, title: string) => page.locator('.entry-row').filter({ has: page.getByText(title, { exact: true }) });
const nav = (page: Page) => page.getByRole('navigation', { name: 'Vault', exact: true });
const click = (locator: Locator, touch = false) => touch ? locator.tap() : locator.click();

async function fixture(name: string, uuid?: string, deleted = false) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const password = `${name} independent password`;
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)), name);
    db.header.versionMinor = 1;
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    const group = db.createGroup(db.groups[0], 'Accounts'), entry = db.createEntry(group);
    if (uuid) entry.uuid = new kdbx.KdbxUuid(uuid);
    entry.fields.set('Title', 'Portable account');
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('Original protected password'));
    entry.fields.set('Empty protected', kdbx.ProtectedValue.fromString(''));
    entry.binaries.set('history.bin', await db.createBinary(new Uint8Array(historyProof).buffer));
    entry.pushHistory(); entry.binaries.clear();
    entry.history[0].customData = new Map([['historical', { value: 'revision metadata retained' }]]);
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('Current protected password'));
    entry.fields.set('Recovery code', kdbx.ProtectedValue.fromString('Protected recovery code'));
    entry.fields.set('Notes', `${name} notes`);
    entry.binaries.set('proof.bin', await db.createBinary(new Uint8Array(proof).buffer));
    entry.tags = ['shared', 'keep'];
    entry.customData = new Map([['portable', { value: 'metadata retained' }]]);
    entry.qualityCheck = false;
    entry.autoType.defaultSequence = '{USERNAME}{TAB}{PASSWORD}{ENTER}';
    entry.customIcon = kdbx.KdbxUuid.random();
    const icon = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3fkAAAAASUVORK5CYII=', 'base64');
    db.meta.customIcons.set(entry.customIcon.id, { data: new Uint8Array(icon).buffer, name: 'Portable icon' });
    if (deleted) db.move(entry, null);
    const excluded = db.createGroup(db.groups[0], 'Excluded'); excluded.enableSearching = false;
    db.createEntry(excluded).fields.set('Title', `${name} excluded`);
    const trashGroup = db.createGroup(db.getGroup(db.meta.recycleBinUuid!)!, `${name} trashed group`);
    db.createEntry(trashGroup).fields.set('Title', `${name} trash`);
    for (const item of all(db)) item.tags = ['shared', 'keep'];
    return { name, password, id: entry.uuid.id, root: db.groups[0].uuid.id, group: group.uuid.id,
        trash: trashGroup.uuid.id, icon: entry.customIcon.id, db, bytes: Buffer.from(await db.save()) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const payload = (f: Fixture) => ({ name: `${f.name}.kdbx`, mimeType: 'application/octet-stream', buffer: f.bytes });
async function unlock(page: Page, f: Fixture) {
    await page.locator('#password').fill(f.password); await page.locator('#unlock').click();
    await expect(page.locator('#search')).toBeVisible({ timeout });
}
async function openPair(page: Page, a: Fixture, b: Fixture, url?: string) {
    await page.goto('/next.html'); await page.locator('#open-file-input').setInputFiles(payload(a)); await unlock(page, a);
    await page.getByRole('button', { name: 'Open another vault', exact: true }).click();
    if (url) {
        await page.locator('#open-webdav').click(); await page.locator('#webdav-url').fill(url);
        await page.locator('#webdav-next').click();
    } else await page.locator('#open-file-input').setInputFiles(payload(b));
    await unlock(page, b);
    await expect(page.getByRole('dialog', { name: 'Open another vault', exact: true })).toHaveCount(0);
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
}
async function navigation(page: Page, touch = false) {
    if (!(await nav(page).isVisible())) {
        const showMenu = page.getByRole('button', { name: 'Show menu', exact: true });
        if (touch && await showMenu.isVisible()) await click(showMenu, touch);
        await click(page.getByRole('button', { name: 'Browse vault', exact: true }), touch);
    }
}
async function back(page: Page, touch = false) {
    await click(page.getByRole('button', { name: 'Back to vault', exact: true }).filter({ visible: true }).first(), touch);
}
async function downloads(page: Page, fixtures: Fixture[], touch = false) {
    await navigation(page, touch);
    await click(nav(page).getByRole('button', { name: 'Settings', exact: true }), touch);
    await click(page.getByRole('tab', { name: 'Database', exact: true }), touch);
    const result: kdbx.Kdbx[] = [];
    for (const source of fixtures) {
        const pending = page.waitForEvent('download');
        await click(page.getByRole('form', { name: `Database settings: ${source.name}`, exact: true })
            .getByRole('button', { name: 'Download KDBX', exact: true }), touch);
        const download = await pending; expect(await download.failure()).toBeNull();
        const stream = await download.createReadStream(); if (!stream) throw new Error('Missing encrypted download');
        const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        await test.info().attach(`${source.name}.kdbx`, { body: bytes, contentType: 'application/octet-stream' });
        expect(bytes.includes(Buffer.from('Current protected password'))).toBe(false);
        const other = fixtures.find(item => item !== source)!;
        await expect(kdbx.Kdbx.load(new Uint8Array(bytes).buffer, new kdbx.Credentials(kdbx.ProtectedValue.fromString(other.password)))).rejects.toThrow();
        result.push(await kdbx.Kdbx.load(new Uint8Array(bytes).buffer, new kdbx.Credentials(kdbx.ProtectedValue.fromString(source.password))));
    }
    await back(page, touch); return result;
}
async function reopenPair(page: Page, a: Fixture, b: Fixture, touch = false) {
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    await navigation(page, touch); await click(nav(page).getByRole('button', { name: 'Lock', exact: true }), touch);
    await expect(page.locator('#password')).toBeVisible({ timeout });
    await page.reload();
    await page.locator('.vault-row').filter({ has: page.getByText(`${a.name}.kdbx`, { exact: true }) }).click(); await unlock(page, a);
    await page.getByRole('button', { name: 'Open another vault', exact: true }).click();
    await page.getByRole('dialog', { name: 'Open another vault', exact: true }).locator('.vault-row')
        .filter({ has: page.getByText(`${b.name}.kdbx`, { exact: true }) }).click(); await unlock(page, b);
    await expect(page.getByRole('dialog', { name: 'Open another vault', exact: true })).toHaveCount(0);
}
async function begin(page: Page, b: Fixture, touch = false) {
    await click(row(page, 'Portable account').first(), touch);
    await choose(page, b, touch);
}
async function choose(page: Page, b: Fixture, touch = false) {
    await click(page.getByRole('button', { name: 'Move to another vault…', exact: true }), touch);
    await expect(dialog(page)).toBeVisible();
    await expect(dialog(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    const option = await dialog(page).getByRole('option').filter({ hasText: `${b.name} (2) / "${b.name}" / "Accounts"` }).getAttribute('value');
    expect(option).toBeTruthy();
    await dialog(page).getByRole('combobox', { name: 'Destination vault and group', exact: true }).selectOption(option!);
}
async function apply(page: Page, touch = false) {
    await click(dialog(page).getByRole('button', { name: 'Move and save both vaults', exact: true }), touch);
}
function fidelity(db: kdbx.Kdbx, source: Fixture, destination: Fixture, historyCount = 1) {
    const entry = all(db).find(item => item.uuid.id === source.id)!;
    expect(entry).toBeDefined(); expect(entry.parentGroup?.uuid.id).toBe(destination.group);
    expect(entry.fields.get('Empty protected')).toBeInstanceOf(kdbx.ProtectedValue);
    expect((entry.fields.get('Empty protected') as kdbx.ProtectedValue).getText()).toBe('');
    expect(entry.history[0].fields.get('Empty protected')).toBeInstanceOf(kdbx.ProtectedValue);
    expect(entry.fields.get('Password')).toBeInstanceOf(kdbx.ProtectedValue);
    expect((entry.fields.get('Password') as kdbx.ProtectedValue).getText()).toBe('Current protected password');
    expect(entry.fields.get('Recovery code')).toBeInstanceOf(kdbx.ProtectedValue);
    expect((entry.fields.get('Recovery code') as kdbx.ProtectedValue).getText()).toBe('Protected recovery code');
    expect(entry.fields.get('Notes')).toBe(`${source.name} notes`);
    expect(entry.customData?.get('portable')?.value).toBe('metadata retained');
    expect(entry.qualityCheck).toBe(false);
    expect(entry.autoType.defaultSequence).toBe('{USERNAME}{TAB}{PASSWORD}{ENTER}');
    expect(entry.history).toHaveLength(historyCount); expect(entry.history[0].uuid.id).toBe(source.id);
    expect(entry.history[0].customData?.get('historical')?.value).toBe('revision metadata retained');
    expect((entry.history[0].fields.get('Password') as kdbx.ProtectedValue).getText()).toBe('Original protected password');
    for (const [revision, name, expected] of [[entry, 'proof.bin', proof], [entry.history[0], 'history.bin', historyProof]] as const) {
        const binary = revision.binaries.get(name);
        expect(kdbx.KdbxBinaries.isKdbxBinaryWithHash(binary)).toBe(true);
        if (!kdbx.KdbxBinaries.isKdbxBinaryWithHash(binary)) throw new Error('Missing binary');
        expect(Buffer.from(binary.value as ArrayBuffer)).toEqual(expected);
        expect(db.binaries.getValueByHash(binary.hash)).toEqual(binary.value);
    }
    expect(entry.customIcon?.id).toBe(source.icon);
    expect(db.meta.customIcons.get(source.icon)?.data).toEqual(source.db.meta.customIcons.get(source.icon)?.data);
}

for (const touch of [false, true]) test.describe(touch ? '320px touch' : 'desktop', () => {
    test.use(touch ? { viewport: { width: 320, height: 568 }, hasTouch: true } : {});
    test('cross-vault move confirms destination, preserves drafts on cancel, identity and bytes through encrypted cached reopen', async ({ page }) => {
        const a = await fixture('Source'), b = await fixture('Destination'); await openPair(page, a, b);
        await navigation(page, touch);
        await click(nav(page).locator('.open-vaults__select').filter({ hasText: 'Source.kdbx' }), touch);
        await click(row(page, 'Portable account').first(), touch);
        const notes = page.getByRole('region', { name: 'Notes', exact: true });
        await click(notes.getByRole('button', { name: 'Edit notes', exact: true }), touch);
        await notes.getByRole('textbox').fill('Uncommitted draft stays on cancel');
        await click(page.getByRole('button', { name: 'Move to another vault…', exact: true }), touch);
        await click(dialog(page).getByRole('button', { name: 'Cancel', exact: true }), touch);
        await expect(notes.getByRole('textbox')).toHaveValue('Uncommitted draft stays on cancel');
        await choose(page, b, touch);
        const bounds = await dialog(page).boundingBox(); expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
        await test.info().attach('move-confirmation', { body: await page.screenshot(), contentType: 'image/png' });
        let prompts = 0;
        page.once('dialog', async prompt => { prompts++; await prompt.dismiss(); });
        await apply(page, touch);
        expect(prompts).toBe(1); await expect(dialog(page)).toBeVisible();
        page.once('dialog', async prompt => { prompts++; await prompt.accept(); });
        await apply(page, touch);
        expect(prompts).toBe(2);
        if (!touch) await expect(page.getByRole('combobox', { name: 'Vault filter', exact: true }).locator('option:checked')).toHaveText('Destination.kdbx (vault 2)');
        await expect(page.locator('#entry-title')).toHaveText('Portable account');
        await expect(page.getByRole('status').filter({ hasText: 'Entry moved. Both vaults saved.' })).toBeInViewport({ timeout });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
        await test.info().attach('move-result', { body: await page.screenshot(), contentType: 'image/png' });
        if (touch) {
            await navigation(page, touch);
            await expect(nav(page).locator('.open-vaults__select').filter({ hasText: 'Destination.kdbx' })).toHaveAttribute('aria-pressed', 'true');
            await expect(nav(page).locator('.open-vaults__select').filter({ hasText: 'Source.kdbx' })).toHaveAttribute('aria-pressed', 'false');
        }
        await reopenPair(page, a, b, touch);
        const [savedA, savedB] = await downloads(page, [a, b], touch);
        expect(all(savedA).some(item => item.uuid.id === a.id)).toBe(false);
        expect(savedA.deletedObjects.some(item => item.uuid?.id === a.id)).toBe(true);
        fidelity(savedB, a, b); fidelity(savedB, b, b);
        expect(savedB.deletedObjects.some(item => item.uuid?.id === a.id)).toBe(false);
    });

    test('two open vaults: global rename/remove tags and confirmed Empty trash survive encrypted reopen', async ({ page }) => {
        const a = await fixture('Source'), b = await fixture('Destination'); await openPair(page, a, b);
        await navigation(page, touch); await click(nav(page).getByRole('button', { name: 'shared', exact: true }), touch);
        await click(page.getByRole('button', { name: 'Rename tag', exact: true }), touch);
        let action = page.getByRole('dialog', { name: 'Rename tag', exact: true });
        await expect(action).toContainText('Source'); await expect(action).toContainText('Destination');
        await action.getByLabel('Tag name', { exact: true }).fill('renamed');
        await click(action.getByRole('button', { name: 'Cancel', exact: true }), touch);
        await click(page.getByRole('button', { name: 'Rename tag', exact: true }), touch);
        await action.getByLabel('Tag name', { exact: true }).fill('renamed');
        await click(action.getByRole('button', { name: 'Rename tag', exact: true }), touch);
        await reopenPair(page, a, b, touch);
        for (const db of await downloads(page, [a, b], touch)) expect(all(db).every(item => item.tags.join() === 'keep,renamed')).toBe(true);
        await navigation(page, touch); await click(nav(page).getByRole('button', { name: 'renamed', exact: true }), touch);
        await click(page.getByRole('button', { name: 'Remove tag', exact: true }), touch);
        action = page.getByRole('dialog', { name: 'Remove tag', exact: true });
        await click(action.getByRole('button', { name: 'Cancel', exact: true }), touch);
        await click(page.getByRole('button', { name: 'Remove tag', exact: true }), touch);
        await click(action.getByRole('button', { name: 'Remove tag', exact: true }), touch);
        await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
        await navigation(page, touch); await click(nav(page).getByRole('button', { name: 'Trash', exact: true }), touch);
        await click(page.locator('summary').filter({ hasText: /^Manage trash$/ }), touch);
        if (touch) {
            await click(page.getByRole('button', { name: 'Move menu', exact: true }), touch);
            await expect(page.getByRole('button', { name: 'Show menu', exact: true })).toBeVisible();
        }
        await click(page.getByRole('button', { name: 'Empty trash…', exact: true }), touch);
        action = page.getByRole('dialog', { name: 'Empty trash', exact: true });
        await expect(action).toContainText('Source: 1 groups, 1 entries'); await expect(action).toContainText('Destination: 1 groups, 1 entries');
        await expect(action.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
        await click(action.getByRole('button', { name: 'Cancel', exact: true }), touch);
        expect(await page.locator('.entry-row').count()).toBe(2);
        await click(page.getByRole('button', { name: 'Empty trash…', exact: true }), touch);
        await test.info().attach('empty-trash-confirmation', { body: await page.screenshot(), contentType: 'image/png' });
        await click(action.getByRole('button', { name: 'Empty trash', exact: true }), touch);
        await reopenPair(page, a, b, touch);
        const saved = await downloads(page, [a, b], touch);
        for (let i = 0; i < saved.length; i++) {
            const db = saved[i], original = [a, b][i];
            expect(all(db)).toHaveLength(2); expect(all(db).every(item => item.tags.join() === 'keep')).toBe(true);
            expect(all(db).map(item => item.uuid.id).sort()).toEqual(all(original.db)
                .filter(item => item.parentGroup?.uuid.id !== original.trash).map(item => item.uuid.id).sort());
            expect(db.meta.recycleBinUuid?.id).toBe(original.db.meta.recycleBinUuid?.id);
            expect(db.getGroup(original.trash)).toBeUndefined();
            expect(db.getGroup(db.meta.recycleBinUuid!)!.groups).toHaveLength(0);
            expect(db.deletedObjects.some(item => item.uuid?.id === original.trash)).toBe(true);
            fidelity(db, original, original, 3);
        }
    });
});

for (const deleted of [false, true]) test(`${deleted ? 'deleted' : 'live'} UUID collision never becomes a copy or source deletion`, async ({ page }) => {
    const a = await fixture('Source'), b = await fixture('Destination', a.id, deleted); await openPair(page, a, b);
    await begin(page, b); await apply(page);
    await expect(dialog(page).getByRole('alert')).toContainText('UUID already exists or was deleted');
    await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    const [savedA, savedB] = await downloads(page, [a, b]); fidelity(savedA, a, a);
    expect(all(savedB).filter(item => item.uuid.id === a.id)).toHaveLength(deleted ? 0 : 1);
    expect(savedA.deletedObjects.some(item => item.uuid?.id === a.id)).toBe(false);
});

async function failCache(page: Page, which: 'first' | 'second') {
    await page.evaluate(which => {
        const put = IDBObjectStore.prototype.put;
        const state = { hits: 0, first: '', failed: false, restore: () => { IDBObjectStore.prototype.put = put; } };
        (window as any).transferFault = state;
        IDBObjectStore.prototype.put = function (...args) {
            if (this.transaction.db.name.endsWith('FilesCache')) {
                const key = String(args[1] ?? (args[0] as any)?.id);
                if (!state.first) state.first = key;
                if (which === 'first' || key !== state.first) {
                    state.hits++; state.failed = true; throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
                }
            }
            return put.apply(this, args as any);
        };
    }, which);
}
async function recoverBoth(page: Page, fixtures: Fixture[]) {
    for (const fixture of fixtures) {
        const form = page.getByRole('form', { name: `Verify database: ${fixture.name}`, exact: true });
        await expect(form).toBeVisible({ timeout });
        await form.getByLabel('Master password', { exact: true }).fill(fixture.password);
        await form.getByRole('button', { name: 'Verify', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Return to unsaved changes', exact: true }).click();
}
for (const failing of ['destination', 'source'] as const) test(`${failing} durability failure reports partial state and retains both vaults behind credential recovery`, async ({ page }) => {
    const a = await fixture('Source'), b = await fixture('Destination'); await openPair(page, a, b);
    await begin(page, b); await failCache(page, failing === 'destination' ? 'first' : 'second'); await apply(page);
    const message = failing === 'destination' ? 'Move not completed. The source entry is intact.' : 'The destination is saved. Source removal is not yet saved';
    await expect(page.getByRole('status').filter({ hasText: message })).toBeVisible({ timeout });
    await expect.poll(() => page.evaluate(() => (window as any).transferFault.hits)).toBeGreaterThan(0);
    await nav(page).getByRole('button', { name: 'Lock', exact: true }).click();
    await recoverBoth(page, [a, b]);
    const [savedA, savedB] = await downloads(page, [a, b]);
    if (failing === 'destination') fidelity(savedA, a, a);
    else expect(all(savedA).some(item => item.uuid.id === a.id)).toBe(false);
    fidelity(savedB, a, b);
    await page.evaluate(() => (window as any).transferFault.restore());
    await nav(page).getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.locator('#password')).toBeVisible({ timeout });
    await page.reload();
    await page.locator('.vault-row').filter({ has: page.getByText('Source.kdbx', { exact: true }) }).click(); await unlock(page, a);
    expect(await row(page, 'Portable account').count()).toBe(failing === 'destination' ? 1 : 0);
    await page.getByRole('button', { name: 'Open another vault', exact: true }).click();
    await page.getByRole('dialog', { name: 'Open another vault', exact: true }).locator('.vault-row')
        .filter({ has: page.getByText('Destination.kdbx', { exact: true }) }).click(); await unlock(page, b);
    const reopened = await downloads(page, [a, b]); fidelity(reopened[1], a, b);
});

test('stop during destination encryption never removes the source or reports a successful move', async ({ page }) => {
    const a = await fixture('Source'), b = await fixture('Destination'); await openPair(page, a, b);
    await begin(page, b);
    await page.evaluate(() => {
        const encrypt = SubtleCrypto.prototype.encrypt;
        (window as any).transferGate = false;
        SubtleCrypto.prototype.encrypt = async function (...args) {
            SubtleCrypto.prototype.encrypt = encrypt; (window as any).transferGate = true;
            await new Promise<void>(resolve => window.addEventListener('release-transfer', () => resolve(), { once: true }));
            return encrypt.apply(this, args);
        };
    });
    await apply(page);
    await expect.poll(() => page.evaluate(() => (window as any).transferGate), { timeout }).toBe(true);
    await dialog(page).getByRole('button', { name: 'Stop move', exact: true }).click();
    await page.evaluate(() => window.dispatchEvent(new Event('release-transfer')));
    await expect(page.getByRole('status').filter({ hasText: 'Move not completed.' })).toBeVisible({ timeout });
    const [savedA, savedB] = await downloads(page, [a, b]); fidelity(savedA, a, a); fidelity(savedB, a, b);
    expect(savedA.deletedObjects.some(item => item.uuid?.id === a.id)).toBe(false);
});

test('idle lock during destination encryption invalidates the pending source deletion before cached reopen', async ({ page }) => {
    await page.clock.install();
    const a = await fixture('Source'), b = await fixture('Destination'); await openPair(page, a, b);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Security', exact: true }).click();
    await page.locator('#setting-auto-lock').selectOption('5'); await back(page);
    await begin(page, b);
    await page.evaluate(() => {
        const encrypt = SubtleCrypto.prototype.encrypt;
        (window as any).transferGate = false;
        SubtleCrypto.prototype.encrypt = async function (...args) {
            SubtleCrypto.prototype.encrypt = encrypt; (window as any).transferGate = true;
            await new Promise<void>(resolve => window.addEventListener('release-transfer', () => resolve(), { once: true }));
            return encrypt.apply(this, args);
        };
    });
    await apply(page);
    await expect.poll(() => page.evaluate(() => (window as any).transferGate), { timeout }).toBe(true);
    await page.clock.fastForward(6 * 60_000);
    await expect(dialog(page)).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event('release-transfer')));
    await expect(page.locator('#password')).toBeVisible({ timeout });
    await page.reload();
    await page.locator('.vault-row').filter({ has: page.getByText('Source.kdbx', { exact: true }) }).click(); await unlock(page, a);
    await page.getByRole('button', { name: 'Open another vault', exact: true }).click();
    await page.getByRole('dialog', { name: 'Open another vault', exact: true }).locator('.vault-row')
        .filter({ has: page.getByText('Destination.kdbx', { exact: true }) }).click(); await unlock(page, b);
    const [savedA, savedB] = await downloads(page, [a, b]); fidelity(savedA, a, a); fidelity(savedB, a, b);
    expect(savedA.deletedObjects.some(item => item.uuid?.id === a.id)).toBe(false);
});

test('a real encrypted destination revision invalidates the open picker without source deletion or remote writes', async ({ page }) => {
    const a = await fixture('Source'), b = await fixture('Destination');
    let bytes = b.bytes, revision = 1, writes = 0;
    const server = createServer((req, res) => {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, PUT, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Cache-Control, Content-Type, If-Match');
        res.setHeader('Access-Control-Expose-Headers', 'Last-Modified, ETag');
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
        if (req.method === 'PUT') { writes++; res.writeHead(503).end(); return; }
        res.setHeader('ETag', `"revision-${revision}"`);
        res.setHeader('Last-Modified', new Date(Date.UTC(2026, 10, 13) + revision * 60_000).toUTCString());
        res.writeHead(200).end(req.method === 'GET' ? bytes : undefined);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await page.clock.install();
        await page.goto('/index.html?ui=classic');
        await page.locator('#open__icon-more').click(); await page.locator('#open__icon-settings').click();
        await page.locator('#settings__general-auto-save-interval').selectOption('1');
        await page.clock.runFor(100);
        await openPair(page, a, b, `http://127.0.0.1:${(server.address() as AddressInfo).port}/Destination.kdbx`);
        await begin(page, b);
        b.db.getGroup(b.group)!.name = 'Changed remotely'; b.db.getGroup(b.group)!.times.update();
        bytes = Buffer.from(await b.db.save()); revision++;
        await page.clock.fastForward(61_000);
        await expect(dialog(page).getByRole('alert')).toContainText('changed', { timeout });
        await expect(dialog(page).getByRole('button', { name: 'Move and save both vaults', exact: true })).toBeDisabled();
        await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
        const [savedA, savedB] = await downloads(page, [a, b]); fidelity(savedA, a, a);
        expect(savedB.getGroup(b.group)!.name).toBe('Changed remotely');
        expect(all(savedB).some(item => item.uuid.id === a.id)).toBe(false); expect(writes).toBe(0);
    } finally {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
});
