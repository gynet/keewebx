import { test as base, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFile } from 'node:fs/promises';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const password = 'settings parity password';
const title = 'Settings record';
const notes = '# Heading\n\n**Keep this source** & <literal>\n中文 notes';
const timeout = 30_000;
const entries = (db: kdbx.Kdbx) => db.groups.flatMap(group => [...group.allEntries()]);
const text = (entry: kdbx.KdbxEntry, field: string) => {
    const value = entry.fields.get(field);
    return value instanceof kdbx.ProtectedValue ? value.getText() : value;
};
async function fixture(withKey = false) {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const key = withKey ? await kdbx.Credentials.createRandomKeyFile(2) : undefined;
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password), key), 'Preferences');
    const entry = db.createEntry(db.groups[0]);
    entry.fields.set('Title', title);
    entry.fields.set('Notes', kdbx.ProtectedValue.fromString(notes));
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('Original secret'));
    entry.pushHistory();
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('Current secret'));
    return { key, bytes: Buffer.from(await db.save()), id: entry.uuid.id };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function decrypt(bytes: Buffer, key?: Uint8Array) {
    return kdbx.Kdbx.load(new Uint8Array(bytes).buffer, new kdbx.Credentials(kdbx.ProtectedValue.fromString(password), key));
}
// Real encrypted HTTP peer, following next-webdav / next-sync-safety. No model injection.
async function peer() {
    const source = await fixture();
    const files = new Map<string, { bytes: Buffer; revision: number }>();
    let revision = Date.UTC(2026, 10, 13);
    let rejectWrites = false;
    const requests: { method: string; path: string }[] = [];
    let held: { entered: boolean; promise: Promise<void>; release: () => void } | undefined;
    const releases: (() => void)[] = [];
    const replace = (bytes: Buffer, path = '/preferences.kdbx') => files.set(path, { bytes: Buffer.from(bytes), revision: (revision += 1000) });
    replace(source.bytes);
    const server = createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, HEAD, PUT, MOVE, DELETE');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Cache-Control, Content-Type, Destination, Overwrite, If-Match, If-None-Match');
        res.setHeader('Access-Control-Expose-Headers', 'Last-Modified, ETag');
        res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
        const path = new URL(req.url!, 'http://localhost').pathname;
        requests.push({ method: req.method!, path });
        if (req.method === 'PUT') {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            if (rejectWrites) { res.writeHead(503).end(); return; }
            replace(Buffer.concat(chunks), path); res.writeHead(201).end(); return;
        }
        if (req.method === 'GET' && held) { const gate = held; held = undefined; gate.entered = true; await gate.promise; }
        const file = files.get(path);
        if (!file) { res.writeHead(404).end(); return; }
        if (req.method === 'GET' || req.method === 'HEAD') {
            res.setHeader('Last-Modified', new Date(file.revision).toUTCString());
            res.setHeader('ETag', `"${file.revision}"`);
            res.writeHead(200).end(req.method === 'GET' ? file.bytes : undefined);
        } else if (req.method === 'MOVE') {
            replace(file.bytes, new URL(String(req.headers.destination), 'http://localhost').pathname);
            files.delete(path); res.writeHead(204).end();
        } else if (req.method === 'DELETE') { files.delete(path); res.writeHead(204).end(); }
        else res.writeHead(405).end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        source, requests, replace, reject: (value: boolean) => { rejectWrites = value; },
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/preferences.kdbx`,
        bytes: () => files.get('/preferences.kdbx')!.bytes,
        writes: () => requests.filter(req => req.method === 'PUT').length,
        holdNextGet() {
            let release!: () => void;
            const promise = new Promise<void>(resolve => { release = resolve; });
            held = { entered: false, promise, release }; releases.push(release); return held;
        },
        async close() { releases.forEach(release => release()); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    };
}
type Dav = Awaited<ReturnType<typeof peer>>;
const test = base.extend<{ dav: Dav }>({ dav: async ({}, use) => {
    const dav = await peer(); try { await use(dav); } finally { await dav.close(); }
} });
const preferences = (page: Page) => page.getByRole('region', { name: 'Saving and content', exact: true });
const status = (page: Page) => preferences(page).getByRole('status');
async function browse(page: Page) {
    const show = page.getByRole('button', { name: 'Show menu', exact: true });
    if (await show.isVisible()) await show.click();
    if (!await page.getByRole('navigation', { name: 'Vault', exact: true }).isVisible())
        await page.getByRole('button', { name: 'Browse vault', exact: true }).click();
}
async function settings(page: Page) {
    await browse(page); await page.locator('#open-settings').click();
    await page.getByRole('tab', { name: 'Saving and content', exact: true }).click();
}
async function back(page: Page) { await page.locator('#settings-back:visible, .settings__phone-back:visible').click(); }
async function collapse(page: Page) {
    const menu = page.getByRole('button', { name: 'Move menu', exact: true });
    if (await menu.isVisible()) await menu.click();
}
async function unlock(page: Page, key?: Uint8Array) {
    await page.locator('#password').fill(password);
    if (key) await page.locator('#unlock-key-file').setInputFiles({ name: 'preferences.keyx', mimeType: 'application/octet-stream', buffer: Buffer.from(key) });
    await page.locator('#unlock').click();
    await expect(page.locator('.entry-row').first()).toBeVisible({ timeout });
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    await collapse(page);
}
async function open(page: Page, source: Fixture) {
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles({ name: 'preferences.kdbx', mimeType: 'application/octet-stream', buffer: source.bytes });
    await unlock(page, source.key);
}
async function connect(page: Page, dav: Dav) {
    await page.goto('/next.html'); await page.locator('#open-webdav').click();
    await page.locator('#webdav-url').fill(dav.url); await page.locator('#webdav-user').fill('tester');
    await page.locator('#webdav-pass').fill('disposable'); await page.locator('#webdav-next').click();
    await unlock(page);
}
async function lockReload(page: Page) {
    await browse(page); await page.locator('#lock').click();
    await expect(page.locator('#password')).toBeVisible({ timeout });
    await page.reload(); await expect(page.locator('#password')).toBeVisible();
}
async function mode(page: Page, value: string) {
    await settings(page);
    await page.getByRole('tab', { name: 'Security', exact: true }).click();
    await page.locator('#setting-auto-lock').selectOption('0');
    await page.getByRole('tab', { name: 'Saving and content', exact: true }).click();
    await page.locator('#setting-auto-save').selectOption(value);
    await back(page);
}
async function editNotes(page: Page, value: string, apply = true) {
    await page.locator(`.entry-row[data-entry="${title}"]`).click();
    const region = page.getByRole('region', { name: 'Notes', exact: true });
    await region.getByRole('button', { name: 'Edit notes', exact: true }).click();
    await region.getByRole('textbox').fill(value);
    if (apply) await region.getByRole('button', { name: 'Save', exact: true }).click();
}
async function download(page: Page, key?: Uint8Array) {
    await page.getByRole('tab', { name: 'Database', exact: true }).click();
    const waiting = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download KDBX', exact: true }).click();
    const file = await waiting; expect(await file.failure()).toBeNull();
    const stream = await file.createReadStream(); if (!stream) throw new Error('Missing encrypted download');
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks); const path = test.info().outputPath('downloaded-preferences.kdbx');
    await writeFile(path, bytes); await test.info().attach('downloaded-preferences.kdbx', { path, contentType: 'application/octet-stream' });
    await page.getByRole('tab', { name: 'Saving and content', exact: true }).click();
    return decrypt(bytes, key);
}
async function stored(page: Page, suffix: string) {
    return page.evaluate(suffix => {
        const key = Object.keys(localStorage).find(key => key === suffix || key.endsWith(`:${suffix}`));
        return key ? JSON.parse(localStorage.getItem(key)!) : null;
    }, suffix);
}

test.describe('New general preferences', () => {
    test.setTimeout(90_000);
    test('Off stops queued autosave; on-change saves existing dirty data and persists across reload', async ({ page, dav }) => {
        await page.clock.install(); await connect(page, dav);
        await settings(page); await expect(page.locator('#setting-auto-save')).toHaveValue('-1');
        await page.getByRole('tab', { name: 'Security', exact: true }).click();
        await page.locator('#setting-auto-lock').selectOption('0'); await back(page);
        // Pause relative to the browser clock: reload can put it ahead of the host clock.
        await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
        const before = dav.writes();
        await editNotes(page, 'Pending queued change');
        await settings(page); await page.locator('#setting-auto-save').selectOption('0');
        await page.clock.fastForward(3_600_000);
        expect(dav.writes()).toBe(before);
        expect(text(entries(await decrypt(dav.bytes()))[0], 'Notes')).toBe(notes);
        await page.locator('#setting-auto-save').selectOption('-1');
        await page.clock.runFor(10);
        await expect.poll(() => dav.writes(), { timeout }).toBeGreaterThan(before);
        await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
        expect(text(entries(await decrypt(dav.bytes()))[0], 'Notes')).toBe('Pending queued change');
        await page.clock.resume();
        await back(page); await lockReload(page); await unlock(page); await settings(page);
        await expect(page.locator('#setting-auto-save')).toHaveValue('-1');
        await page.locator('#setting-auto-save').selectOption('0'); await back(page); await lockReload(page); await unlock(page); await settings(page);
        await expect(page.locator('#setting-auto-save')).toHaveValue('0');
    });
    for (const minutes of [1, 5, 15, 30, 60]) test(`${minutes}-minute sync persists, saves on schedule, fetches a clean remote change, and stops when Off`, async ({ page, dav }) => {
        await page.clock.install(); await connect(page, dav); await mode(page, String(minutes));
        await lockReload(page); await unlock(page); await settings(page);
        await expect(page.locator('#setting-auto-save')).toHaveValue(String(minutes)); await back(page);
        // Pause relative to the browser clock: reload can put it ahead of the host clock.
        await page.clock.pauseAt(await page.evaluate(() => Date.now()) + 1000);
        const before = dav.writes();
        await editNotes(page, `Timed ${minutes}`);
        await page.clock.fastForward(2000); expect(dav.writes()).toBe(before);
        await page.clock.fastForward(minutes * 60_000);
        await expect.poll(() => dav.writes(), { timeout }).toBeGreaterThan(before);
        await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
        const remote = await decrypt(dav.bytes());
        expect(text(entries(remote)[0], 'Notes')).toBe(`Timed ${minutes}`);
        const extra = remote.createEntry(remote.groups[0]); extra.fields.set('Title', `Remote only ${minutes}`);
        dav.replace(Buffer.from(await remote.save()));
        const getCount = dav.requests.filter(r => r.method === 'GET').length;
        await page.clock.fastForward(minutes * 60_000);
        await expect(page.locator(`.entry-row[data-entry="Remote only ${minutes}"]`)).toBeVisible({ timeout });
        expect(dav.requests.filter(r => r.method === 'GET').length).toBeGreaterThan(getCount);
        await mode(page, '0');
        const requests = dav.requests.length;
        await page.clock.fastForward(minutes * 60_000 + 1000);
        expect(dav.requests).toHaveLength(requests);
    });
    test('manual save applies a notes draft with autosave off, reports failed remote write, and retries encrypted data', async ({ page, dav }) => {
        await connect(page, dav); await mode(page, '0');
        await editNotes(page, 'Draft saved explicitly', false);
        await settings(page); dav.reject(true);
        await preferences(page).getByRole('button', { name: 'Save now', exact: true }).click();
        await expect(status(page)).toContainText('could not synchronize', { timeout });
        expect(text(entries(await decrypt(dav.bytes()))[0], 'Notes')).toBe(notes);
        dav.reject(false);
        await preferences(page).getByRole('button', { name: 'Retry save', exact: true }).click();
        await expect(status(page)).toContainText('synchronized.', { timeout });
        const saved = entries(await decrypt(dav.bytes())).find(e => e.uuid.id === dav.source.id)!;
        expect(text(saved, 'Notes')).toBe('Draft saved explicitly');
        expect(saved.fields.get('Notes')).toBeInstanceOf(kdbx.ProtectedValue);
        expect(text(saved, 'Password')).toBe('Current secret');
        expect(saved.history.some(e => text(e, 'Password') === 'Original secret')).toBe(true);
        await test.info().attach('remote-after-retry.kdbx', { body: dav.bytes(), contentType: 'application/octet-stream' });
    });
    test('manual save refuses invalid database settings and credential drafts without remote writes', async ({ page, dav }) => {
        await connect(page, dav); await mode(page, '0'); await settings(page);
        await page.getByRole('tab', { name: 'Database', exact: true }).click();
        const form = page.getByRole('form', { name: /^Database settings: / });
        await form.getByLabel('Vault name', { exact: true }).fill('');
        const before = dav.writes();
        await page.getByRole('tab', { name: 'Saving and content', exact: true }).click();
        await preferences(page).getByRole('button', { name: 'Save now', exact: true }).click();
        await expect(status(page)).toContainText('Apply or discard invalid or credential edits');
        expect(dav.writes()).toBe(before);
        await page.getByRole('tab', { name: 'Database', exact: true }).click();
        await form.getByLabel('Vault name', { exact: true }).fill('preferences');
        await form.getByLabel('New master password', { exact: true }).fill('unfinished password');
        await page.getByRole('tab', { name: 'Saving and content', exact: true }).click();
        await preferences(page).getByRole('button', { name: 'Retry save', exact: true }).click();
        await expect(status(page)).toContainText('Apply or discard invalid or credential edits');
        expect(dav.writes()).toBe(before);
        expect(text(entries(await decrypt(dav.bytes()))[0], 'Notes')).toBe(notes);
    });
    test('manual save waits for an actual attachment read before uploading', async ({ page, dav }) => {
        await connect(page, dav); await mode(page, '0');
        await page.locator(`.entry-row[data-entry="${title}"]`).click();
        let entered = false;
        await page.exposeFunction('sdetPreferenceReadEntered', () => { entered = true; });
        await page.evaluate(() => {
            const read = File.prototype.arrayBuffer;
            File.prototype.arrayBuffer = async function () {
                File.prototype.arrayBuffer = read;
                await (window as unknown as { sdetPreferenceReadEntered(): Promise<void> }).sdetPreferenceReadEntered();
                await new Promise<void>(resolve => window.addEventListener('sdet-preferences-release', () => resolve(), { once: true }));
                return read.call(this);
            };
        });
        const binary = Buffer.from([0, 255, 4, 128, 10]);
        await page.getByLabel('Attachment file', { exact: true }).setInputFiles({ name: 'pending.bin', mimeType: 'application/octet-stream', buffer: binary });
        await expect.poll(() => entered).toBe(true);
        await settings(page); const before = dav.writes();
        await preferences(page).getByRole('button', { name: 'Save now', exact: true }).click();
        await expect(preferences(page).getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
        expect(dav.writes()).toBe(before);
        await page.evaluate(() => window.dispatchEvent(new Event('sdet-preferences-release')));
        await expect(status(page)).toContainText('synchronized.', { timeout });
        const db = await decrypt(dav.bytes()); const saved = entries(db).find(e => e.uuid.id === dav.source.id)!;
        const ref = saved.binaries.get('pending.bin') as { ref: string; value: ArrayBuffer };
        expect(Buffer.from(ref.value)).toEqual(binary);
    });
    test('manual save rejects a database replaced by a remote refresh while waiting for the existing writer', async ({ page, dav }) => {
        await page.clock.install(); await connect(page, dav); await mode(page, '1');
        const remote = await decrypt(dav.bytes());
        remote.createEntry(remote.groups[0]).fields.set('Title', 'Arrived during save');
        dav.replace(Buffer.from(await remote.save()));
        const gate = dav.holdNextGet();
        await page.clock.fastForward(61_000);
        await expect.poll(() => gate.entered, { timeout }).toBe(true);
        await settings(page);
        await preferences(page).getByRole('button', { name: 'Save now', exact: true }).click();
        await expect(preferences(page).getByRole('button', { name: 'Saving…', exact: true })).toBeDisabled();
        const requests = dav.requests.length;
        gate.release();
        await expect(status(page)).toContainText('The open vaults changed', { timeout });
        expect(dav.requests).toHaveLength(requests);
        expect(dav.writes()).toBe(0);
        await preferences(page).getByRole('button', { name: 'Retry save', exact: true }).click();
        await expect(status(page)).toContainText('synchronized.', { timeout });
        await back(page); await expect(page.locator('.entry-row[data-entry="Arrived during save"]')).toBeVisible();
    });
    test('pending manual save is canceled by idle recovery and cannot resume after reauthentication', async ({ page, dav }) => {
        await page.clock.install(); await connect(page, dav); await mode(page, '0');
        await settings(page);
        await page.getByRole('tab', { name: 'Security', exact: true }).click();
        await page.locator('#setting-auto-lock').selectOption('5'); await back(page);
        await page.locator(`.entry-row[data-entry="${title}"]`).click();
        let entered = false;
        let completed = false;
        await page.exposeFunction('sdetPreferenceGateEntered', () => { entered = true; });
        await page.exposeFunction('sdetPreferenceGateCompleted', () => { completed = true; });
        await page.evaluate(() => {
            const read = File.prototype.arrayBuffer;
            File.prototype.arrayBuffer = async function () {
                File.prototype.arrayBuffer = read;
                await (window as unknown as { sdetPreferenceGateEntered(): Promise<void> }).sdetPreferenceGateEntered();
                await new Promise<void>(resolve => window.addEventListener('sdet-preferences-gate-release', () => resolve(), { once: true }));
                const bytes = await read.call(this);
                await (window as unknown as { sdetPreferenceGateCompleted(): Promise<void> }).sdetPreferenceGateCompleted();
                return bytes;
            };
        });
        await page.getByLabel('Attachment file', { exact: true }).setInputFiles({ name: 'expired.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('expired attachment') });
        await expect.poll(() => entered).toBe(true);
        await settings(page); const before = dav.writes(); const original = Buffer.from(dav.bytes());
        await preferences(page).getByRole('button', { name: 'Save now', exact: true }).click();
        await page.clock.fastForward(6 * 60_000);
        await expect(preferences(page)).toBeHidden();
        await page.clock.fastForward(16_000);
        const form = page.getByRole('form', { name: 'Verify database: preferences', exact: true });
        await expect(form).toBeVisible({ timeout });
        await form.getByLabel('Master password', { exact: true }).fill(password);
        await form.getByLabel('Master password', { exact: true }).press('Enter');
        await page.getByRole('button', { name: 'Return to unsaved changes', exact: true }).click();
        await expect(preferences(page)).toBeVisible();
        await page.evaluate(() => window.dispatchEvent(new Event('sdet-preferences-gate-release')));
        await expect.poll(() => completed).toBe(true);
        await expect(preferences(page).getByRole('button', { name: 'Save now', exact: true })).toBeEnabled();
        await expect(status(page)).toHaveCount(0);
        expect(dav.writes()).toBe(before); expect(dav.bytes().equals(original)).toBe(true);
        const db = await download(page);
        expect(entries(db).find(e => e.uuid.id === dav.source.id)!.binaries.has('expired.bin')).toBe(false);
        await page.screenshot({ path: test.info().outputPath('manual-save-after-recovery.png'), fullPage: true });
    });
    test('remember data reopens without a key; disabling clears all retained key data and requires the key after reload', async ({ page }) => {
        const source = await fixture(true); await open(page, source); await settings(page);
        await expect(page.locator('#setting-remember-key-files')).toHaveValue('path');
        expect((await stored(page, 'appSettings'))?.rememberKeyFiles).toBeUndefined();
        await page.locator('#setting-remember-key-files').selectOption('data');
        expect((await stored(page, 'fileInfo')).every((f: Record<string, unknown>) => !f.keyFileName && !f.keyFilePath && !f.keyFileHash)).toBe(true);
        await preferences(page).getByRole('button', { name: 'Save now', exact: true }).click();
        await expect(status(page)).toContainText('saved in this browser', { timeout });
        expect((await stored(page, 'fileInfo')).some((f: Record<string, unknown>) => !!f.keyFileHash)).toBe(true);
        await back(page); await lockReload(page); await unlock(page); await settings(page);
        await expect(page.locator('#setting-remember-key-files')).toHaveValue('data');
        await page.locator('#setting-remember-key-files').selectOption('none');
        expect((await stored(page, 'appSettings')).rememberKeyFiles).toBe(false);
        expect((await stored(page, 'fileInfo')).every((f: Record<string, unknown>) => !f.keyFileName && !f.keyFilePath && !f.keyFileHash)).toBe(true);
        await back(page); await lockReload(page);
        await page.locator('#password').fill(password); await page.locator('#unlock').click();
        await expect(page.locator('#unlock-error')).toHaveText('Wrong password', { timeout });
        await unlock(page, source.key); await settings(page);
        await expect(page.locator('#setting-remember-key-files')).toHaveValue('none');
        const db = await download(page, source.key);
        expect(text(entries(db).find(e => e.uuid.id === source.id)!, 'Notes')).toBe(notes);
        expect((await stored(page, 'fileInfo')).every((f: Record<string, unknown>) => !f.keyFileHash)).toBe(true);
    });
    for (const colorScheme of ['light', 'dark'] as const) test.describe(`320px ${colorScheme}`, () => {
        test.use({ viewport: { width: 320, height: 740 }, hasTouch: true, colorScheme });
        test('Markdown switches presentation, preserves protected source and persists; all controls are reachable', async ({ page }) => {
            const source = await fixture(); await open(page, source);
            await page.locator(`.entry-row[data-entry="${title}"]`).click();
            await expect(page.locator('.entry-notes h1')).toHaveText('Heading');
            await settings(page); await expect(page.locator('#setting-markdown')).toBeChecked();
            await page.locator('#setting-markdown').uncheck();
            await page.locator('#setting-auto-save').selectOption('0');
            await page.locator('#setting-remember-key-files').selectOption('none');
            for (const control of await preferences(page).locator('select, input, button').all()) {
                await control.scrollIntoViewIfNeeded(); const box = (await control.boundingBox())!;
                expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(321);
            }
            expect(await page.locator('.settings').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
            await preferences(page).screenshot({ path: test.info().outputPath(`settings-320-${colorScheme}.png`) });
            await back(page);
            await expect(page.locator('.entry-notes h1')).toHaveCount(0);
            await expect(page.locator('.entry-notes .notes')).toHaveText(notes);
            await lockReload(page); await unlock(page); await settings(page);
            await expect(page.locator('#setting-markdown')).not.toBeChecked();
            const db = await download(page); const saved = entries(db).find(e => e.uuid.id === source.id)!;
            expect(text(saved, 'Notes')).toBe(notes); expect(saved.fields.get('Notes')).toBeInstanceOf(kdbx.ProtectedValue);
            expect(saved.history).toHaveLength(1);
            await page.locator('#setting-markdown').check(); await back(page); await collapse(page);
            await page.locator(`.entry-row[data-entry="${title}"]`).click();
            await expect(page.locator('.entry-notes h1')).toHaveText('Heading');
        });
    });
});
