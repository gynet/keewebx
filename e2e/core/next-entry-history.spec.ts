import { test, expect, type Page, type Locator } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFile } from 'node:fs/promises';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const password = 'disposable history password';
const vaultName = 'History fixture';
const title = 'History account';
const timeout = 30_000;
const oldBytes = Buffer.from([0, 255, 127, 10, 1]);
const newBytes = Buffer.from([254, 128, 2, 3]);
const credentials = () => new kdbx.Credentials(kdbx.ProtectedValue.fromString(password));
const text = (value: unknown) => value instanceof kdbx.ProtectedValue ? value.getText() : value;
const entries = (db: kdbx.Kdbx) => db.groups.flatMap(group => [...group.allEntries()]);
async function decode(data: Buffer) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    return kdbx.Kdbx.load(new Uint8Array(data).buffer, credentials());
}
async function fixture() {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(credentials(), vaultName);
    const group = db.createGroup(db.groups[0], 'Accounts');
    const entry = db.createEntry(group);
    entry.fields.set('Title', title);
    entry.fields.set('UserName', 'old user');
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('old history secret'));
    entry.fields.set('Notes', kdbx.ProtectedValue.fromString('Old protected notes\nsecond line'));
    entry.fields.set('Old field', 'Only in first version');
    entry.fields.set('Protection change', 'unchanged value');
    entry.tags = ['old'];
    entry.times.creationTime = new Date('2019-01-01T00:00:00Z');
    entry.times.lastModTime = new Date('2020-01-01T00:00:00Z');
    entry.binaries.set('old-proof.bin', await db.createBinary(new Uint8Array(oldBytes).buffer));
    entry.pushHistory();
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('middle history secret'));
    entry.fields.set('Notes', kdbx.ProtectedValue.fromString('Middle notes'));
    entry.fields.delete('Old field');
    entry.tags = ['middle'];
    entry.times.lastModTime = new Date('2021-01-01T00:00:00Z');
    entry.pushHistory();
    entry.fields.set('UserName', 'current user');
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('current history secret'));
    entry.fields.set('Notes', kdbx.ProtectedValue.fromString('Current notes'));
    entry.fields.set('Protection change', kdbx.ProtectedValue.fromString('unchanged value'));
    entry.fields.set('New field', '<script>literal text, never execute</script>');
    entry.binaries.clear();
    entry.binaries.set('current-proof.bin', await db.createBinary(new Uint8Array(newBytes).buffer));
    entry.tags = ['current'];
    entry.times.lastModTime = new Date('2022-01-01T00:00:00Z');
    const sibling = db.createEntry(group);
    sibling.fields.set('Title', 'Untouched sibling');
    sibling.fields.set('Password', kdbx.ProtectedValue.fromString('sibling secret'));
    const data = Buffer.from(await db.save());
    return { data, entryId: entry.uuid.id, siblingId: sibling.uuid.id, groupId: group.uuid.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const history = (page: Page) => page.getByRole('dialog', { name: 'Entry history', exact: true });
const editor = (page: Page) => page.locator('.entry-editor');
const navigation = (page: Page) => page.getByRole('navigation', { name: 'Vault', exact: true });
const target = (page: Page) => page.locator('.entry-row').filter({ has: page.getByText(title, { exact: true }) });
const field = (page: Page, name: string) => history(page).locator(`[aria-label="History field: ${name}"]`);
async function activate(control: Locator, touch = false) { if (touch) await control.tap(); else await control.click(); }
async function browse(page: Page, touch = false) {
    if (!await navigation(page).isVisible()) await activate(page.getByRole('button', { name: 'Browse vault', exact: true }), touch);
}
async function open(page: Page, source: Fixture) {
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles({ name: `${vaultName}.kdbx`, mimeType: 'application/octet-stream', buffer: source.data });
    await page.locator('#password').fill(password);
    await page.locator('#unlock').click();
    await expect(target(page)).toBeVisible({ timeout });
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    await target(page).click();
}
async function showHistory(page: Page, touch = false) {
    await activate(page.getByRole('button', { name: 'History', exact: true }), touch);
    await expect(history(page)).toBeVisible();
    await expect(history(page).getByRole('combobox', { name: 'Version', exact: true })).toBeFocused();
}
async function version(page: Page, value: number) {
    await history(page).getByRole('combobox', { name: 'Version', exact: true }).selectOption(String(value));
}
async function download(page: Page, touch = false) {
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    await browse(page, touch);
    await activate(navigation(page).getByRole('button', { name: 'Settings', exact: true }), touch);
    await activate(page.getByRole('tab', { name: 'Database', exact: true }), touch);
    const pending = page.waitForEvent('download');
    await activate(page.getByRole('button', { name: 'Download KDBX', exact: true }), touch);
    const output = await pending;
    expect(await output.failure()).toBeNull();
    const stream = await output.createReadStream();
    if (!stream) throw new Error('No downloaded encrypted bytes');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    const path = test.info().outputPath(`history-actual-download-${Date.now()}.kdbx`);
    await writeFile(path, bytes);
    await test.info().attach('history-actual-download.kdbx', { path, contentType: 'application/octet-stream' });
    const db = await decode(bytes);
    await activate(page.locator('#settings-back:visible, .settings__phone-back:visible'), touch);
    return { db, bytes };
}
function binary(entry: kdbx.KdbxEntry, name: string) {
    const value = entry.binaries.get(name);
    expect(kdbx.KdbxBinaries.isKdbxBinaryWithHash(value)).toBe(true);
    if (!kdbx.KdbxBinaries.isKdbxBinaryWithHash(value)) throw new Error('Missing binary');
    return Buffer.from(value.value instanceof kdbx.ProtectedValue ? value.value.getBinary() : new Uint8Array(value.value));
}
function semantic(entry: kdbx.KdbxEntry): unknown {
    return { uuid: entry.uuid.id, parent: entry.parentGroup?.uuid.id,
        fields: [...entry.fields].map(([name, value]) => [name, text(value), value instanceof kdbx.ProtectedValue]),
        tags: entry.tags, updated: entry.times.lastModTime?.toISOString(),
        binaries: [...entry.binaries.keys()].map(name => [name, binary(entry, name).toString('base64')]),
        history: entry.history.map(semantic) };
}
function restored(db: kdbx.Kdbx, source: Fixture, deleted = false) {
    expect(entries(db)).toHaveLength(2);
    const entry = entries(db).find(entry => entry.uuid.id === source.entryId)!;
    expect(entry.parentGroup?.uuid.id).toBe(source.groupId);
    expect(text(entry.fields.get('Password'))).toBe('old history secret');
    expect(entry.fields.get('Password')).toBeInstanceOf(kdbx.ProtectedValue);
    expect(text(entry.fields.get('Notes'))).toBe('Old protected notes\nsecond line');
    expect(entry.fields.get('Notes')).toBeInstanceOf(kdbx.ProtectedValue);
    expect(entry.fields.get('Old field')).toBe('Only in first version');
    expect(entry.fields.has('New field')).toBe(false);
    expect(entry.tags).toEqual(['old']);
    expect(binary(entry, 'old-proof.bin')).toEqual(oldBytes);
    expect(entry.binaries.has('current-proof.bin')).toBe(false);
    expect(entry.history).toHaveLength(deleted ? 2 : 3);
    expect(entry.history.some(version => text(version.fields.get('Password')) === 'current history secret')).toBe(true);
    const formerCurrent = entry.history.find(version => text(version.fields.get('Password')) === 'current history secret')!;
    expect(binary(formerCurrent, 'current-proof.bin')).toEqual(newBytes);
    expect(entry.history.some(version => text(version.fields.get('Password')) === 'middle history secret')).toBe(!deleted);
    expect(text(entries(db).find(entry => entry.uuid.id === source.siblingId)!.fields.get('Password'))).toBe('sibling secret');
    expect(db.deletedObjects).toHaveLength(0);
}

// Real encrypted peer, matching next-sync-safety; no production model hooks.
async function peer(source: Fixture) {
    let data = source.data;
    let revision = Date.UTC(2026, 10, 13);
    let writes = 0;
    const replace = (next: Buffer) => { data = Buffer.from(next); revision += 1000; };
    const server = createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, HEAD, PUT');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Cache-Control, Content-Type, If-Match, If-None-Match');
        res.setHeader('Access-Control-Expose-Headers', 'Last-Modified, ETag');
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
        if (req.method === 'PUT') {
            const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
            replace(Buffer.concat(chunks)); ++writes; res.writeHead(200).end(); return;
        }
        res.setHeader('Last-Modified', new Date(revision).toUTCString());
        res.setHeader('ETag', `"${revision}"`);
        res.writeHead(200).end(req.method === 'GET' ? data : undefined);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/history.kdbx`,
        data: () => data, writes: () => writes, replace,
        async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test.describe('New entry history', () => {
    test.setTimeout(90_000);
    test('direct history is read-only, masks secrets, shows differences, and preserves an editor draft', async ({ page, browserName }) => {
        const source = await fixture();
        await open(page, source);
        await showHistory(page);
        await expect(history(page).getByRole('combobox')).toHaveValue('2');
        await expect(history(page).getByRole('button', { name: 'Restore version', exact: true })).toHaveCount(0);
        await expect(field(page, 'Password').locator('dd')).toHaveText('••••••••••••');
        await expect(field(page, 'Protection change')).toContainText('Protection changed');
        await expect(history(page).getByRole('region', { name: 'History attachments', exact: true })).toContainText('old-proof.bin — Removed');
        await history(page).getByRole('button', { name: 'Previous version', exact: true }).click();
        await expect(field(page, 'Old field')).toContainText('Removed');
        await history(page).getByRole('button', { name: 'Previous version', exact: true }).click();
        await history(page).getByRole('button', { name: 'Show Password', exact: true }).click();
        await expect(field(page, 'Password').locator('dd')).toHaveText('old history secret');
        if (browserName === 'chromium') {
            await history(page).getByRole('button', { name: 'Copy Password', exact: true }).click();
            await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('old history secret');
        }
        await history(page).getByRole('button', { name: 'Next version', exact: true }).click();
        await expect(field(page, 'Password').locator('dd')).toHaveText('••••••••••••');
        await page.keyboard.press('Escape');
        await expect(page.getByRole('button', { name: 'History', exact: true })).toBeFocused();
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        await editor(page).getByLabel('Title', { exact: true }).fill('Unsaved title remains');
        await showHistory(page);
        await expect(field(page, 'Title').locator('dd')).toHaveText(title);
        await history(page).getByRole('button', { name: 'Close History', exact: true }).click();
        await expect(editor(page).getByLabel('Title', { exact: true })).toHaveValue('Unsaved title remains');
        await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click();
        const exported = await download(page);
        expect(entries(exported.db).map(semantic)).toEqual(entries(await decode(source.data)).map(semantic));
    });

    test('editor deletion preserves a draft; confirmed restore resets its fields and save baseline', async ({ page }) => {
        const source = await fixture();
        await open(page, source);
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        await editor(page).getByLabel('Title', { exact: true }).fill('Keep this draft until confirmed restore');
        await showHistory(page);
        await version(page, 1);
        await history(page).getByRole('button', { name: 'Delete version', exact: true }).click();
        await history(page).getByRole('button', { name: 'Confirm delete', exact: true }).click();
        await expect(editor(page).getByLabel('Title', { exact: true })).toHaveValue('Keep this draft until confirmed restore');
        await expect(editor(page).getByLabel('Password', { exact: true })).toHaveValue('current history secret');
        await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
        await showHistory(page);
        await version(page, 0);
        await page.screenshot({ path: test.info().outputPath('history-version.png'), fullPage: true });
        await history(page).getByRole('button', { name: 'Restore version', exact: true }).click();
        await expect(history(page)).toContainText('Restoring also discards the unsaved changes for this entry.');
        await history(page).getByRole('button', { name: 'Cancel', exact: true }).click();
        await history(page).getByRole('button', { name: 'Close History', exact: true }).click();
        await expect(editor(page).getByLabel('Title', { exact: true })).toHaveValue('Keep this draft until confirmed restore');
        await showHistory(page);
        await version(page, 0);
        await history(page).getByRole('button', { name: 'Restore version', exact: true }).click();
        await history(page).getByRole('button', { name: 'Confirm restore', exact: true }).click();
        await expect(editor(page).getByLabel('Title', { exact: true })).toHaveValue(title);
        await expect(editor(page).getByLabel('Password', { exact: true })).toHaveValue('old history secret');
        await editor(page).getByRole('button', { name: 'Show Notes', exact: true }).click();
        await expect(editor(page).getByLabel('Notes', { exact: true })).toHaveValue('Old protected notes\nsecond line');
        await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
        await expect(editor(page)).toHaveCount(0);
        restored((await download(page)).db, source, true);
    });

    for (const mobile of [false, true]) for (const colorScheme of ['light', 'dark'] as const) {
        test.describe(`${mobile ? '320px touch' : 'desktop'} ${colorScheme}`, () => {
            test.use({ viewport: mobile ? { width: 320, height: 350 } : { width: 1280, height: 800 }, hasTouch: mobile, colorScheme });
            test('confirmed restore and deletion survive encrypted export and fresh reopen; cancel is inert', async ({ page, browser }) => {
                const source = await fixture();
                await open(page, source);
                const notes = page.getByRole('region', { name: 'Notes', exact: true });
                await activate(notes.getByRole('button', { name: 'Edit notes', exact: true }), mobile);
                await notes.getByRole('textbox').fill('Unsaved notes: explicitly discard only on restore');
                await showHistory(page, mobile);
                await version(page, 0);
                await page.screenshot({ path: test.info().outputPath('history-version.png'), fullPage: true });
                await activate(history(page).getByRole('button', { name: 'Restore version', exact: true }), mobile);
                await expect(history(page)).toContainText('Restoring also discards the unsaved changes for this entry.');
                await expect(history(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
                await activate(history(page).getByRole('button', { name: 'Cancel', exact: true }), mobile);
                await expect(history(page).getByRole('button', { name: 'Restore version', exact: true })).toBeFocused();
                await activate(history(page).getByRole('button', { name: 'Close History', exact: true }), mobile);
                await expect(notes.getByRole('textbox')).toHaveValue('Unsaved notes: explicitly discard only on restore');
                await showHistory(page, mobile);
                await version(page, 0);
                await activate(history(page).getByRole('button', { name: 'Restore version', exact: true }), mobile);
                expect(await history(page).evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
                await page.screenshot({ path: test.info().outputPath('history-restore-confirm.png'), fullPage: true });
                await activate(history(page).getByRole('button', { name: 'Confirm restore', exact: true }), mobile);
                await expect(history(page)).toHaveCount(0);
                await expect(notes.getByRole('textbox')).toHaveCount(0);
                await expect(notes).toContainText('Old protected notes');
                restored((await download(page, mobile)).db, source);
                await showHistory(page, mobile);
                await version(page, 1);
                await activate(history(page).getByRole('button', { name: 'Delete version', exact: true }), mobile);
                await page.keyboard.press('Escape');
                await expect(history(page).getByRole('button', { name: 'Delete version', exact: true })).toBeFocused();
                await activate(history(page).getByRole('button', { name: 'Delete version', exact: true }), mobile);
                await page.screenshot({ path: test.info().outputPath('history-delete-confirm.png'), fullPage: true });
                await activate(history(page).getByRole('button', { name: 'Confirm delete', exact: true }), mobile);
                const result = await download(page, mobile);
                restored(result.db, source, true);
                const fresh = await browser.newContext({ baseURL: page.url() });
                try {
                    const next = await fresh.newPage();
                    await open(next, { ...source, data: result.bytes });
                    await showHistory(next);
                    await expect(history(next).getByRole('combobox').locator('option')).toHaveCount(3);
                    await history(next).getByRole('button', { name: 'Show Password', exact: true }).click();
                    await expect(field(next, 'Password').locator('dd')).toHaveText('old history secret');
                } finally { await fresh.close(); }
            });
        });
    }

    for (const action of ['restore', 'delete'] as const) {
        test(`stale ${action} confirmation rejects a real encrypted remote history replacement`, async ({ page }) => {
            const source = await fixture();
            const dav = await peer(source);
            try {
                await page.clock.install();
                await page.goto('/index.html?ui=classic');
                await page.locator('#open__icon-more').click();
                await page.locator('#open__icon-settings').click();
                await page.locator('#settings__general-auto-save-interval').selectOption('1');
                await page.clock.runFor(100);
                await page.goto('/next.html');
                await page.locator('#open-webdav').click();
                await page.locator('#webdav-url').fill(dav.url);
                await page.locator('#webdav-user').fill('tester');
                await page.locator('#webdav-pass').fill('test password');
                await page.locator('#webdav-next').click();
                await page.locator('#password').fill(password);
                await page.locator('#unlock').click();
                await expect(target(page)).toBeVisible({ timeout });
                await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
                await target(page).click();
                await showHistory(page);
                await version(page, 0);
                await history(page).getByRole('button', { name: action === 'restore' ? 'Restore version' : 'Delete version', exact: true }).click();
                const remote = await decode(dav.data());
                const entry = entries(remote).find(entry => entry.uuid.id === source.entryId)!;
                entry.removeHistory(0);
                entry.fields.set('Password', kdbx.ProtectedValue.fromString('Remote replacement secret'));
                entry.times.update();
                remote.createEntry(remote.groups[0]).fields.set('Title', 'Remote marker');
                dav.replace(Buffer.from(await remote.save()));
                await page.clock.fastForward(61_000);
                await expect(page.locator('.entry-row').filter({ hasText: 'Remote marker' })).toHaveCount(1, { timeout });
                await expect(history(page).getByRole('alert')).toContainText('changed');
                await expect(history(page).getByRole('button', { name: action === 'restore' ? 'Confirm restore' : 'Confirm delete', exact: true })).toHaveCount(0);
                const before = Buffer.from(dav.data()); const writes = dav.writes();
                await page.keyboard.press('Enter');
                expect(dav.data().equals(before)).toBe(true); expect(dav.writes()).toBe(writes);
                await page.screenshot({ path: test.info().outputPath('stale-history-denied.png'), fullPage: true });
            } finally { await dav.close(); }
        });
    }

    for (const ttl of [10, 0]) test(`held clipboard write after suspension honors TTL ${ttl} without acknowledging the stale copy`, async ({ page, browserName }) => {
        test.skip(browserName !== 'chromium', 'Native clipboard read/write permissions are Chromium-only in root config.');
        const source = await fixture();
        await page.clock.install();
        await open(page, source);
        await page.locator('#open-settings').click();
        await page.getByRole('tab', { name: 'Security', exact: true }).click();
        await page.locator('#setting-auto-lock').selectOption('5');
        await page.locator('#setting-clipboard').selectOption(String(ttl));
        await page.locator('#settings-back').click();
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        await editor(page).getByRole('button', { name: 'Add field', exact: true }).click();
        await editor(page).getByLabel('Field name', { exact: true }).last().fill('Title');
        await editor(page).getByLabel('Field value', { exact: true }).last().fill('Invalid draft retains the suspended dialog');
        await showHistory(page);
        await version(page, 0);
        // Hold only the browser write, then invoke the real native clipboard API.
        // No app/model hooks: real UI/idle recovery and native clipboard readback remain the oracle.
        await page.evaluate(() => {
            const nativeWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
            const state = { started: false, completed: false, release: () => {} };
            const held = new Promise<void>(resolve => { state.release = resolve; });
            Object.assign(window, { historyClipboardTest: state });
            navigator.clipboard.writeText = async (value: string) => {
                state.started = true;
                await held;
                await nativeWrite(value);
                state.completed = true;
            };
        });
        await history(page).getByRole('button', { name: 'Copy Password', exact: true }).click();
        await expect.poll(() => page.evaluate(() => (window as any).historyClipboardTest.started)).toBe(true);
        await page.clock.fastForward(6 * 60_000);
        const retained = page.locator('dialog.entry-history');
        await expect(retained).toBeHidden();
        await expect(retained).toHaveJSProperty('open', false);
        await expect(retained.locator('xpath=ancestor::*[@hidden and @inert]')).toHaveCount(1);
        await expect(page.getByRole('form', { name: `Verify database: ${vaultName}`, exact: true })).toBeVisible();
        await page.evaluate(() => (window as any).historyClipboardTest.release());
        await expect.poll(() => page.evaluate(() => (window as any).historyClipboardTest.completed)).toBe(true);
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('old history secret');
        await expect(retained).not.toContainText('Copied Password');
        // No new immediate-clear behavior; cleanup uses the configured delay from completion.
        await page.clock.runFor(9_000);
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('old history secret');
        await page.clock.runFor(2_000);
        expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ttl ? '' : 'old history secret');
        await expect(retained).not.toContainText('Copied Password');
        await expect(retained).toBeHidden();
        await page.screenshot({ path: test.info().outputPath(`held-clipboard-ttl-${ttl}.png`), fullPage: true });
    });

    test('idle recovery hides history and invalidates restore confirmation, preserving the editor draft', async ({ page }) => {
        const source = await fixture();
        await page.clock.install();
        await open(page, source);
        await page.locator('#open-settings').click();
        await page.getByRole('tab', { name: 'Security', exact: true }).click();
        await page.locator('#setting-auto-lock').selectOption('5');
        await page.locator('#settings-back').click();
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        await editor(page).getByLabel('Title', { exact: true }).fill('Unapplied recovery draft');
        await editor(page).getByRole('button', { name: 'Add field', exact: true }).click();
        await editor(page).getByLabel('Field name', { exact: true }).last().fill('Title');
        await editor(page).getByLabel('Field value', { exact: true }).last().fill('Invalid duplicate field');
        await showHistory(page);
        await version(page, 0);
        await history(page).getByRole('button', { name: 'Restore version', exact: true }).click();
        await page.clock.fastForward(6 * 60_000);
        const retained = page.locator('dialog.entry-history');
        await expect(retained).toBeHidden();
        await expect(retained).toHaveJSProperty('open', false);
        await expect(retained.locator('xpath=ancestor::*[@hidden and @inert]')).toHaveCount(1);
        await expect(history(page)).toHaveCount(0);
        const gate = page.getByRole('form', { name: `Verify database: ${vaultName}`, exact: true });
        await expect(gate).toBeVisible({ timeout });
        await gate.getByLabel('Master password', { exact: true }).fill('wrong');
        await gate.getByLabel('Master password', { exact: true }).press('Enter');
        await expect(gate.getByRole('alert')).toContainText('Verification failed');
        await expect(retained).toBeHidden();
        await gate.getByLabel('Master password', { exact: true }).fill(password);
        await gate.getByLabel('Master password', { exact: true }).press('Enter');
        await page.getByRole('button', { name: 'Return to unsaved changes', exact: true }).click();
        await expect(history(page).getByRole('alert')).toContainText('session changed');
        await expect(history(page).getByRole('button', { name: 'Confirm restore', exact: true })).toHaveCount(0);
        await history(page).getByRole('button', { name: 'Close History', exact: true }).click();
        await expect(editor(page).getByLabel('Title', { exact: true })).toHaveValue('Unapplied recovery draft');
        await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click();
        expect(entries((await download(page)).db).map(semantic)).toEqual(entries(await decode(source.data)).map(semantic));
    });
});
