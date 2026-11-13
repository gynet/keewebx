import { test as base, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as kdbxweb from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const password = 'sync safety';
const targetTitle = 'Original entry';
const draftTitle = 'Local unsaved title';
const remoteMarker = 'Remote revision received';
const timeout = 30_000;

async function decrypt(data: Buffer) {
    kdbxweb.CryptoEngine.setArgon2Impl(argon2);
    return kdbxweb.Kdbx.load(new Uint8Array(data).buffer,
        new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password)));
}
const allEntries = (db: kdbxweb.Kdbx) => db.groups.flatMap((group) => [...group.allEntries()]);
const text = (entry: kdbxweb.KdbxEntry, field: string) => {
    const value = entry.fields.get(field);
    return value instanceof kdbxweb.ProtectedValue ? value.getText() : value;
};

// A real HTTP peer supplies encrypted revisions and delayed network responses.
// No application globals, synthetic model events or injected app hooks are used.
async function startDav() {
    kdbxweb.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password)), 'Safety vault');
    const entry = db.createEntry(db.groups[0]);
    entry.fields.set('Title', targetTitle);
    entry.fields.set('Password', kdbxweb.ProtectedValue.fromString('original password'));
    entry.fields.set('Notes', 'Original notes');
    const files = new Map<string, { data: Buffer; modified: string }>();
    let revision = Date.UTC(2026, 10, 12);
    const write = (pathname: string, data: Buffer) => {
        revision += 1000;
        files.set(pathname, { data: Buffer.from(data), modified: new Date(revision).toUTCString() });
    };
    write('/vault.kdbx', Buffer.from(await db.save()));
    let held: { method: string; entered: boolean; promise: Promise<void>; release: () => void } | undefined;
    const gates: (() => void)[] = [];
    const server = createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, HEAD, PUT, MOVE, DELETE');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Cache-Control, Content-Type, Destination, Overwrite, If-Match, If-None-Match');
        res.setHeader('Access-Control-Expose-Headers', 'Last-Modified, ETag');
        res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
        const pathname = new URL(req.url!, 'http://localhost').pathname;
        const gate = held?.method === req.method ? held : undefined;
        if (gate) { held = undefined; gate.entered = true; await gate.promise; }
        if (req.method === 'PUT') {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            write(pathname, Buffer.concat(chunks));
            res.writeHead(201).end();
            return;
        }
        const file = files.get(pathname);
        if (!file) { res.writeHead(404).end(); return; }
        if (req.method === 'GET' || req.method === 'HEAD') {
            res.setHeader('Last-Modified', file.modified);
            res.setHeader('ETag', `"${file.modified}"`);
            res.writeHead(200).end(req.method === 'GET' ? file.data : undefined);
        } else if (req.method === 'MOVE') {
            const destination = new URL(String(req.headers.destination), 'http://localhost').pathname;
            write(destination, file.data);
            files.delete(pathname);
            res.writeHead(204).end();
        } else if (req.method === 'DELETE') {
            files.delete(pathname);
            res.writeHead(204).end();
        } else res.writeHead(405).end();
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/vault.kdbx`,
        remote: () => files.get('/vault.kdbx')!.data,
        replace: (data: Buffer) => write('/vault.kdbx', data),
        holdNext(method: 'HEAD' | 'PUT') {
            let release!: () => void;
            const promise = new Promise<void>((resolve) => { release = resolve; });
            const gate = { method, entered: false, promise, release };
            held = gate;
            gates.push(release);
            return gate;
        },
        async close() {
            gates.forEach((release) => release());
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    };
}

type Dav = Awaited<ReturnType<typeof startDav>>;
const test = base.extend<{ dav: Dav }>({
    dav: async ({}, use) => {
        const dav = await startDav();
        try { await use(dav); } finally { await dav.close(); }
    }
});

const synced = (page: Page) => expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
async function connect(page: Page, dav: Dav) {
    await page.goto('/next.html');
    await page.locator('#open-webdav').click();
    await page.locator('#webdav-url').fill(dav.url);
    await page.locator('#webdav-user').fill('tester');
    await page.locator('#webdav-pass').fill('test-dav-password');
    await page.locator('#webdav-next').click();
    await page.locator('#password').fill(password);
    await page.locator('#unlock').click();
    await expect(page.locator('.entry-row[data-entry="Original entry"]')).toBeVisible({ timeout });
    await synced(page);
}

async function createEntry(page: Page, title: string) {
    await page.getByRole('button', { name: 'New entry', exact: true }).click();
    const editor = page.locator('.entry-editor');
    await editor.getByLabel('Title', { exact: true }).fill(title);
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#entry-title')).toHaveText(title);
}

async function settings(page: Page) {
    await page.locator('#open-settings').click();
    await page.getByRole('tab', { name: 'Database', exact: true }).click();
    const form = page.getByRole('form', { name: /^Database settings: / });
    await form.getByText('Advanced', { exact: true }).click();
    return form;
}

async function enablePeriodicSync(page: Page) {
    await page.clock.install();
    await page.goto('/index.html?ui=classic');
    await page.locator('#open__icon-more').click();
    await page.locator('#open__icon-settings').click();
    await page.locator('#settings__general-auto-save-interval').selectOption('1');
    // Give the normal settings persistence timer a turn before navigation.
    await page.clock.runFor(100);
}

test.describe('Sync and draft data safety', () => {
    test.setTimeout(120_000);

    for (const method of ['HEAD', 'PUT'] as const) {
        test(`rejects KDF changes while ${method} is pending, then safely retries`, async ({ page, dav }) => {
            await connect(page, dav);
            const original = await decrypt(dav.remote());
            const originalIterations = Number(original.header.kdfParameters!.get('I'));
            const gate = dav.holdNext(method);
            await createEntry(page, 'Triggers autosave');
            await expect.poll(() => gate.entered, { timeout }).toBe(true);
            const form = await settings(page);
            const originalKdf = await form.getByLabel('Key derivation function', { exact: true }).inputValue();
            await form.getByLabel('Vault name', { exact: true }).fill('Blocked rename');
            await form.getByLabel('Key derivation function', { exact: true }).selectOption('Argon2id');
            await form.getByLabel('Iterations', { exact: true }).fill('7');
            await expect(form.getByRole('button', { name: 'Save database settings', exact: true })).toBeDisabled();
            // A synthetic submit must still hit the shared guard, even though the UI disables Save.
            await form.evaluate(node => node.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
            await expect(form.getByRole('status')).toContainText('A save is in progress');
            await expect(form.getByRole('heading', { level: 3, name: 'vault', exact: true })).toHaveText('vault');
            await form.getByRole('button', { name: 'Cancel', exact: true }).click();
            await expect(form).toHaveCount(0);
            await expect(page.locator('#settings-back')).toHaveCount(0);
            await settings(page);
            await expect(form.getByLabel('Vault name', { exact: true })).toHaveValue('vault');
            await expect(form.getByLabel('Key derivation function', { exact: true })).toHaveValue(originalKdf);
            await expect(form.getByLabel('Iterations', { exact: true })).toHaveValue(String(originalIterations));
            gate.release();
            await synced(page);
            const firstSave = await decrypt(dav.remote());
            expect(Number(firstSave.header.kdfParameters!.get('I'))).toBe(originalIterations);
            expect(allEntries(firstSave).some((entry) => text(entry, 'Title') === 'Triggers autosave')).toBe(true);

            await form.getByLabel('Key derivation function', { exact: true }).selectOption('Argon2id');
            await form.getByLabel('Iterations', { exact: true }).fill('7');
            await form.getByRole('button', { name: 'Save database settings', exact: true }).click();
            await expect(form.getByRole('status')).toHaveText('Database settings saved.', { timeout });
            const retry = await decrypt(dav.remote());
            expect(Number(retry.header.kdfParameters!.get('I'))).toBe(7);
            expect(kdbxweb.ByteUtils.bytesToBase64(retry.header.kdfParameters!.get('$UUID') as ArrayBuffer)).toBe(kdbxweb.Consts.KdfId.Argon2id);
        });
    }

    test('lock prevents further typing during an active upload and saves the pre-lock draft', async ({ page, dav }) => {
        await connect(page, dav);
        const gate = dav.holdNext('PUT');
        await createEntry(page, 'Triggers autosave');
        await expect.poll(() => gate.entered, { timeout }).toBe(true);
        await page.locator('.entry-row[data-entry="Original entry"]').click();
        await page.getByRole('button', { name: 'Edit', exact: true }).click();
        const input = page.locator('.entry-editor').getByLabel('Title', { exact: true });
        await input.fill('Saved before lock');
        await page.locator('#lock').click();
        await expect(page.locator('[inert][hidden] .entry-editor')).toHaveCount(1);
        await expect(page.locator('.entry-editor')).toBeHidden();
        await expect(page.getByRole('heading', { name: 'Securing your vaults', exact: true })).toBeVisible();
        // Real keyboard input must not reach the editor while synchronization is held.
        await page.keyboard.press('Tab');
        await page.keyboard.type('Must not enter the draft');
        await expect(input).toHaveValue('Saved before lock');
        await expect(page.locator('#password')).toHaveCount(0);
        gate.release();
        await expect(page.locator('#password')).toBeVisible({ timeout });
        const saved = await decrypt(dav.remote());
        expect(allEntries(saved).some((entry) => text(entry, 'Title') === 'Saved before lock')).toBe(true);
        await page.reload();
        await page.locator('#password').fill(password);
        await page.locator('#unlock').click();
        await expect(page.locator('.entry-row[data-entry="Saved before lock"]')).toBeVisible({ timeout });
    });

    for (const scenario of ['entry', 'notes', 'settings', 'deleted entry', 'deleted notes'] as const) {
        test(`preserves the ${scenario} draft and rejects stale save after a remote revision`, async ({ page, dav }) => {
            await enablePeriodicSync(page);
            await connect(page, dav);
            const isSettings = scenario === 'settings';
            const isNotes = scenario.includes('notes');
            const isDeletion = scenario.startsWith('deleted');
            if (!isSettings) await page.locator('.entry-row[data-entry="Original entry"]').click();
            const editor = isSettings ? await settings(page)
                : isNotes ? page.getByRole('region', { name: 'Notes', exact: true }) : page.locator('.entry-editor');
            if (isSettings) await editor.getByLabel('Vault name', { exact: true }).fill(draftTitle);
            else if (isNotes) {
                await editor.getByRole('button', { name: 'Edit notes', exact: true }).click();
                await editor.getByRole('textbox', { name: 'Notes', exact: true }).fill('Local unsaved notes');
            } else {
                await page.getByRole('button', { name: 'Edit', exact: true }).click();
                await editor.getByLabel('Title', { exact: true }).fill(draftTitle);
            }

            const remote = await decrypt(dav.remote());
            const target = allEntries(remote).find((entry) => text(entry, 'Title') === targetTitle)!;
            if (isDeletion) remote.move(target, undefined);
            else if (isSettings) remote.meta.defaultUser = 'Remote default user';
            else {
                target.fields.set('Password', kdbxweb.ProtectedValue.fromString('Remote password'));
                target.fields.set('Notes', 'Remote notes');
                target.fields.set('Remote addition', 'Preserve this field');
                target.times.update();
            }
            remote.createEntry(remote.groups[0]).fields.set('Title', remoteMarker);
            dav.replace(Buffer.from(await remote.save()));
            await page.clock.fastForward(61_000);
            // This marker confirms the changed encrypted revision reached the live model.
            await expect(page.locator('.entry-row[data-entry="Remote revision received"]')).toHaveCount(1, { timeout });
            await synced(page);
            const beforeRejectedSave = Buffer.from(dav.remote());
            await expect(editor).toBeVisible();
            const save = editor.getByRole('button', { name: isSettings ? 'Save database settings' : 'Save', exact: true });
            await save.click();
            // EntryEditor rejects the replaced database identity before checking field changes.
            // Notes/settings retain their specific conflict message; all byte/draft oracles below stay strict.
            const rejection = !isSettings && !isNotes
                ? 'This entry is no longer available for editing.' : 'changed while you were editing';
            await expect(editor.getByRole(isSettings ? 'status' : 'alert')).toContainText(rejection);
            if (isNotes) await expect(editor.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue('Local unsaved notes');
            else await expect(editor.getByLabel(isSettings ? 'Vault name' : 'Title', { exact: true })).toHaveValue(draftTitle);
            expect(dav.remote().equals(beforeRejectedSave)).toBe(true);
            const persisted = await decrypt(dav.remote());
            expect(allEntries(persisted).some((entry) => text(entry, 'Title') === draftTitle)).toBe(false);
            const persistedTarget = allEntries(persisted).find((entry) => entry.uuid.equals(target.uuid));
            if (isDeletion) expect(persistedTarget).toBeUndefined();
            else if (isSettings) expect(persisted.meta.defaultUser).toBe('Remote default user');
            else {
                expect(text(persistedTarget!, 'Password')).toBe('Remote password');
                expect(text(persistedTarget!, 'Notes')).toBe('Remote notes');
                expect(text(persistedTarget!, 'Remote addition')).toBe('Preserve this field');
            }
            if (scenario === 'notes') {
                // A conflicting Notes draft must not defeat lock or disappear during recovery.
                await page.locator('#lock').click();
                const retainedNotes = page.locator('.entry-notes');
                await expect(retainedNotes).toHaveCount(1);
                await expect(retainedNotes).toBeHidden();
                await expect(retainedNotes.locator('xpath=ancestor::*[@hidden and @inert]')).toHaveCount(1);
                await expect(retainedNotes.locator('textarea')).toHaveValue('Local unsaved notes');
                const recovery = page.getByRole('form', { name: 'Verify database: vault', exact: true });
                await expect(recovery).toBeVisible({ timeout });
                await expect(page.getByRole('button', { name: 'Return to unsaved changes', exact: true })).toBeDisabled();
                await recovery.getByLabel('Master password', { exact: true }).fill(password);
                await recovery.getByRole('button', { name: 'Verify', exact: true }).click();
                await expect(recovery.getByRole('status')).toHaveText('Verified');
                await page.getByRole('button', { name: 'Return to unsaved changes', exact: true }).click();
                await expect(editor).toBeVisible();
                await expect(editor.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue('Local unsaved notes');
                expect(dav.remote().equals(beforeRejectedSave)).toBe(true);
            }
            await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
            if (isSettings) {
                await expect(editor).toHaveCount(0);
                await expect(page.locator('#settings-back')).toHaveCount(0);
                await expect((await settings(page)).getByLabel('Default user', { exact: true })).toHaveValue('Remote default user');
            }
            if (isDeletion) await expect(page.locator('.entry-row[data-entry="Original entry"]')).toHaveCount(0);
        });
    }
});
