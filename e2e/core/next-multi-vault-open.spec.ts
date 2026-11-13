import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const payload = (buffer: Buffer, name: string) => ({ buffer, name: `${name}.kdbx`, mimeType: 'application/octet-stream' });
const picker = (page: Page) => page.getByRole('dialog', { name: 'Open another vault', exact: true });
const row = (page: Page, name: string) => page.locator('.entry-row').filter({ hasText: `${name} entry` });
const editor = (page: Page) => page.locator('.entry-editor');
const notes = 'Unsaved A draft: keep it through another unlock';

async function fixture(name: string, factors: 'password' | 'password-key' | 'key-only' = 'password') {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const password = factors === 'key-only' ? '' : `${name} independent master password`;
    const key = factors === 'password' ? undefined : await kdbx.Credentials.createRandomKeyFile(2);
    const db = kdbx.Kdbx.create(new kdbx.Credentials(password ? kdbx.ProtectedValue.fromString(password) : null, key), name);
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set('Title', `${name} entry`);
    entry.fields.set('Password', kdbx.ProtectedValue.fromString(`${name} protected secret`));
    entry.fields.set('Notes', `${name} original notes`);
    entry.pushHistory();
    return { name, password, key, id: entry.uuid.id, root: db.getDefaultGroup().uuid.id, buffer: Buffer.from(await db.save()) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function passwordOpen(page: Page, password: string) {
    await page.locator('#password').fill(password);
    await page.locator('#unlock').click();
}

async function openA(page: Page, a: Fixture) {
    await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles(payload(a.buffer, a.name));
    await passwordOpen(page, a.password);
    await row(page, a.name).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await editor(page).getByLabel('Notes', { exact: true }).fill(notes);
}

async function openPicker(page: Page) {
    await page.getByRole('button', { name: 'Open another vault', exact: true }).click();
    await expect(picker(page)).toBeVisible();
    // The modal excludes the existing editor (and its plaintext draft) from accessibility navigation.
    await expect(page.getByRole('main', { name: 'Edit entry', exact: true })).toHaveCount(0);
    await expect(picker(page).locator('.vault-row[data-vault="A"]')).toHaveCount(0);
}

async function assertDraft(page: Page) {
    await expect(picker(page)).toHaveCount(0);
    await expect(editor(page).getByLabel('Notes', { exact: true })).toHaveValue(notes);
    await expect(editor(page).getByLabel('Title', { exact: true })).toHaveValue('A entry');
}

async function settings(page: Page) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Database', exact: true }).click();
}

async function download(page: Page, name: string) {
    const pending = page.waitForEvent('download');
    await page.getByRole('form', { name: `Database settings: ${name}`, exact: true })
        .getByRole('button', { name: 'Download KDBX', exact: true }).click();
    const result = await pending;
    expect(await result.failure()).toBeNull();
    const stream = await result.createReadStream();
    if (!stream) throw new Error('Missing encrypted export');
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}

async function assertExport(bytes: Buffer, source: Fixture, other: Fixture, expectedNotes: string) {
    expect(bytes.includes(Buffer.from(`${source.name} protected secret`))).toBe(false);
    const credentials = (password: string, key?: Uint8Array) => new kdbx.Credentials(password ? kdbx.ProtectedValue.fromString(password) : null, key);
    await expect(kdbx.Kdbx.load(new Uint8Array(bytes).buffer, credentials(other.password, other.key))).rejects.toThrow();
    const db = await kdbx.Kdbx.load(new Uint8Array(bytes).buffer, credentials(source.password, source.key));
    expect(db.meta.name).toBe(source.name);
    expect(db.getDefaultGroup().uuid.id).toBe(source.root);
    const all = [...db.getDefaultGroup().allEntries()];
    expect(all.map(entry => entry.uuid.id)).toEqual([source.id]);
    const entry = all[0];
    expect(entry.fields.get('Title')).toBe(`${source.name} entry`);
    expect(entry.fields.get('Notes')).toBe(expectedNotes);
    expect(entry.fields.get('Password')).toBeInstanceOf(kdbx.ProtectedValue);
    expect((entry.fields.get('Password') as kdbx.ProtectedValue).getText()).toBe(`${source.name} protected secret`);
    expect(entry.history.length).toBeGreaterThanOrEqual(1);
    expect(all.some(value => value.uuid.id === other.id)).toBe(false);
}

/** Synthetic authenticated loopback DAV; no real credentials or remote services. */
async function dav(source: Fixture, responseReady: Promise<void> = Promise.resolve()) {
    const requests: string[] = [];
    const server = createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, HEAD');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Cache-Control, Content-Type');
        res.setHeader('Access-Control-Expose-Headers', 'Last-Modified, ETag');
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
        requests.push(req.method!);
        if (req.headers.authorization !== `Basic ${Buffer.from('test:disposable').toString('base64')}`) {
            res.writeHead(401).end(); return;
        }
        if (req.method === 'GET') await responseReady;
        res.setHeader('Last-Modified', new Date(Date.UTC(2026, 10, 13)).toUTCString());
        res.setHeader('ETag', '"fixture-1"');
        res.writeHead(200).end(req.method === 'GET' ? source.buffer : undefined);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        requests, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/${source.name}.kdbx`,
        async close() {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        }
    };
}

for (const kind of ['local', 'WebDAV'] as const) test(`${kind}: cancel, wrong key and duplicate preserve A draft; independent encrypted A/B round trips`, async ({ page }) => {
    const a = await fixture('A'), b = await fixture('B');
    const remote = kind === 'WebDAV' ? await dav(b) : undefined;
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    try {
        await openA(page, a);
        await openPicker(page);
        await picker(page).getByRole('button', { name: 'Cancel', exact: true }).click();
        await assertDraft(page);
        await expect(page.getByRole('button', { name: 'Open another vault', exact: true })).toBeFocused();
        await openPicker(page);
        await page.locator('#open-file-input').setInputFiles(payload(a.buffer, a.name));
        await passwordOpen(page, a.password);
        await expect(page.locator('#unlock-error-details')).toContainText('Duplicate file id');
        await page.keyboard.press('Escape');
        await assertDraft(page);
        await expect(row(page, 'A')).toHaveCount(1);
        await openPicker(page);
        if (remote) {
            await page.locator('#open-webdav').click();
            await page.locator('#webdav-url').fill(remote.url);
            await page.locator('#webdav-user').fill('test');
            await page.locator('#webdav-pass').fill('disposable');
            await page.locator('#webdav-next').click();
        } else await page.locator('#open-file-input').setInputFiles(payload(b.buffer, b.name));
        await passwordOpen(page, a.password);
        await expect(page.locator('#unlock-error')).toHaveText('Wrong password');
        await expect(editor(page).getByLabel('Notes', { exact: true })).toHaveValue(notes);
        await passwordOpen(page, b.password);
        await assertDraft(page);
        await expect(row(page, 'A')).toHaveCount(1);
        await expect(row(page, 'B')).toHaveCount(1);
        await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
        await row(page, 'B').click();
        await expect(page.locator('#entry-title')).toHaveText('B entry');
        await page.getByRole('button', { name: 'Show password', exact: true }).click();
        await expect(page.locator('[data-field="password"] .field__value')).toHaveText('B protected secret');
        await row(page, 'A').click();
        await expect(page.locator('#entry-title')).toHaveText('A entry');
        await page.getByRole('button', { name: 'Show password', exact: true }).click();
        await expect(page.locator('[data-field="password"] .field__value')).toHaveText('A protected secret');
        await settings(page);
        await expect(page.getByRole('form', { name: /^Database settings: / })).toHaveCount(2);
        await assertExport(await download(page, 'A'), a, b, notes);
        await assertExport(await download(page, 'B'), b, a, 'B original notes');
        if (remote) expect(remote.requests).toContain('GET');
        expect(errors).toEqual([]);
    } finally { await remote?.close(); }
});

test('320px: create another vault preserves the current editor and produces two independent databases', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 568 });
    const a = await fixture('A');
    await openA(page, a);
    await openPicker(page);
    await page.locator('#create-vault').click();
    const form = picker(page).getByRole('form', { name: 'Create a vault', exact: true });
    await form.getByLabel('Vault name', { exact: true }).fill('Created B');
    await form.getByLabel('Master password', { exact: true }).fill('new B master password');
    await form.getByLabel('Confirm password', { exact: true }).fill('new B master password');
    expect(await picker(page).evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('mobile-create.png'), fullPage: true });
    await form.getByRole('button', { name: 'Create vault', exact: true }).click();
    await assertDraft(page);
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await settings(page);
    await expect(page.getByRole('form', { name: /^Database settings: / })).toHaveCount(2);
    const bytes = await download(page, 'Created B');
    const created = await kdbx.Kdbx.load(new Uint8Array(bytes).buffer,
        new kdbx.Credentials(kdbx.ProtectedValue.fromString('new B master password')));
    expect(created.meta.name).toBe('Created B');
    expect(created.getDefaultGroup().uuid.id).not.toBe(a.root);
    expect([...created.getDefaultGroup().allEntries()]).toHaveLength(0);
    await assertExport(await download(page, 'A'), a, { ...a, password: 'new B master password', id: 'absent' }, notes);
});

async function holdDecrypt(page: Page) {
    await page.evaluate(() => {
        const decrypt = crypto.subtle.decrypt.bind(crypto.subtle);
        crypto.subtle.decrypt = async (...args) => {
            const result = await decrypt(...args);
            const algorithm = typeof args[0] === 'string' ? args[0] : args[0].name;
            if (algorithm !== 'AES-CBC') return result;
            crypto.subtle.decrypt = decrypt;
            (window as any).__held = true;
            return new Promise(resolve => { (window as any).__release = () => resolve(result); });
        };
    });
}

async function releaseDecrypt(page: Page) {
    await page.evaluate(() => {
        const parse = DOMParser.prototype.parseFromString;
        DOMParser.prototype.parseFromString = function (...args) {
            const result = parse.apply(this, args);
            DOMParser.prototype.parseFromString = parse;
            (window as any).__parsed = true;
            return result;
        };
        (window as any).__release();
    });
    await expect.poll(() => page.evaluate(() => !!(window as any).__parsed)).toBe(true);
}

for (const destination of ['cancel', 'different pane', 'lock'] as const) test(`late second-vault decrypt after ${destination} cannot admit B or navigate to passkey setup`, async ({ page }) => {
    const a = await fixture('A'), b = await fixture('B');
    await openA(page, a);
    await openPicker(page);
    await page.locator('#open-file-input').setInputFiles(payload(b.buffer, b.name));
    await page.getByRole('checkbox', { name: 'Set up passkey after unlocking', exact: true }).check();
    await holdDecrypt(page);
    await passwordOpen(page, b.password);
    await expect.poll(() => page.evaluate(() => !!(window as any).__held)).toBe(true);
    if (destination === 'different pane') await page.locator('#open-webdav').click();
    else {
        await picker(page).getByRole('button', { name: 'Cancel', exact: true }).click();
        await assertDraft(page);
        if (destination === 'lock') {
            await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
            await page.getByRole('button', { name: 'Lock', exact: true }).click();
            await expect(page.locator('.vault-row[data-vault="A"]')).toBeVisible();
        }
    }
    await releaseDecrypt(page);
    await expect(page.getByRole('tab', { name: 'Database', exact: true })).toHaveCount(0);
    await expect(row(page, 'B')).toHaveCount(0);
    if (destination === 'lock') {
        await expect(page.locator('.entry-row')).toHaveCount(0);
        await expect(page.locator('.vault-row[data-vault="B"]')).toHaveCount(0);
        await passwordOpen(page, a.password);
        await expect(row(page, 'A')).toBeVisible();
    } else {
        if (destination === 'different pane') {
            await expect(picker(page).getByRole('heading', { name: 'Connect to WebDAV', exact: true })).toBeVisible();
            await page.keyboard.press('Escape');
        }
        await assertDraft(page);
        await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
        await settings(page);
        await expect(page.getByRole('form', { name: /^Database settings: / })).toHaveCount(1);
    }
});

async function connect(page: Page, url: string) {
    await page.locator('#open-webdav').click();
    await page.locator('#webdav-url').fill(url);
    await page.locator('#webdav-user').fill('test');
    await page.locator('#webdav-pass').fill('disposable');
    await page.locator('#webdav-next').click();
}

async function selectKey(page: Page, key: Uint8Array) {
    await page.locator('#unlock-key-file').setInputFiles({
        name: 'B.keyx', mimeType: 'application/octet-stream', buffer: Buffer.from(key)
    });
    await expect(page.getByRole('button', { name: 'Key file: B.keyx', exact: true })).toBeVisible();
}

for (const kind of ['local', 'WebDAV'] as const) {
    for (const factors of ['password-key', 'key-only'] as const) {
        test(`${kind}: ${factors} remain specific to B through open, export and recent reopen`, async ({ page }) => {
            const a = await fixture('A'), b = await fixture('B', factors);
            const remote = kind === 'WebDAV' ? await dav(b) : undefined;
            try {
                await openA(page, a);
                await openPicker(page);
                if (remote) await connect(page, remote.url);
                else await page.locator('#open-file-input').setInputFiles(payload(b.buffer, b.name));
                await passwordOpen(page, b.password);
                await expect(page.locator('#unlock-error')).toHaveText('Wrong password');
                await selectKey(page, await kdbx.Credentials.createRandomKeyFile(2));
                await passwordOpen(page, b.password);
                await expect(page.locator('#unlock-error')).toHaveText('Wrong password');
                await selectKey(page, b.key!);
                await passwordOpen(page, a.password);
                await expect(page.locator('#unlock-error')).toHaveText('Wrong password');
                await passwordOpen(page, b.password);
                await assertDraft(page);
                await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
                await settings(page);
                const bytes = await download(page, 'B');
                await assertExport(bytes, b, a, 'B original notes');
                await expect(kdbx.Kdbx.load(new Uint8Array(bytes).buffer,
                    new kdbx.Credentials(b.password ? kdbx.ProtectedValue.fromString(b.password) : null))).rejects.toThrow();
                await assertExport(await download(page, 'A'), a, b, notes);
                await page.getByRole('button', { name: 'Back to vault', exact: true }).click();
                await page.getByRole('button', { name: 'Lock', exact: true }).click();
                await expect(page.locator('.vault-row[data-vault="A"]')).toBeVisible();
                await page.reload();
                await page.locator('.vault-row[data-vault="A"]').click();
                await passwordOpen(page, a.password);
                await row(page, 'A').click();
                await page.getByRole('button', { name: 'Edit', exact: true }).click();
                await openPicker(page);
                await picker(page).locator('.vault-row[data-vault="B"]').click();
                await selectKey(page, b.key!);
                await passwordOpen(page, b.password);
                await assertDraft(page);
                await expect(row(page, 'B')).toHaveCount(1);
            } finally { await remote?.close(); }
        });
    }
}

test('idle lock revokes an open picker and a held decrypt, saving the existing draft', async ({ page }) => {
    await page.clock.install();
    await page.addInitScript(() => localStorage.setItem('appSettings', JSON.stringify({ idleMinutes: 1 })));
    const a = await fixture('A'), b = await fixture('B');
    await openA(page, a);
    await openPicker(page);
    await page.locator('#open-file-input').setInputFiles(payload(b.buffer, b.name));
    await holdDecrypt(page);
    await passwordOpen(page, b.password);
    await expect.poll(() => page.evaluate(() => !!(window as any).__held)).toBe(true);
    await page.clock.fastForward(125_000);
    await expect(picker(page)).toHaveCount(0);
    await expect(page.locator('.vault-row[data-vault="A"]')).toBeVisible();
    await releaseDecrypt(page);
    await expect(page.locator('.vault-row[data-vault="B"]')).toHaveCount(0);
    await expect(page.locator('.entry-row')).toHaveCount(0);
    await passwordOpen(page, a.password);
    await row(page, 'A').click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await assertDraft(page);
});

test('a canceled WebDAV response cannot enter a later picker or publish a recent record', async ({ page }) => {
    const a = await fixture('A'), b = await fixture('B');
    let release!: () => void;
    const remote = await dav(b, new Promise<void>(resolve => { release = resolve; }));
    try {
        await openA(page, a);
        await openPicker(page);
        await connect(page, remote.url);
        await passwordOpen(page, b.password);
        await expect.poll(() => remote.requests.includes('GET')).toBe(true);
        await picker(page).getByRole('button', { name: 'Cancel', exact: true }).click();
        await assertDraft(page);
        await openPicker(page);
        const response = page.waitForResponse(remote.url);
        release();
        await (await response).finished();
        await expect(picker(page).getByRole('heading', { name: 'Open a vault', exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await assertDraft(page);
        await expect(row(page, 'B')).toHaveCount(0);
        expect(await page.evaluate(() => JSON.parse(localStorage.getItem('fileInfo') || '[]').map((info: any) => info.name))).toEqual(['A']);
    } finally { release(); await remote.close(); }
});

test('passkey setup targets B without enrolling, then recent passkey open preserves A and rejects canceled decrypt', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'Chromium CDP virtual authenticator required');
    await page.addInitScript(() => {
        (window as any).__keewebx_passkey_capability_override = { prf: 'supported', reason: 'Virtual authenticator test',
            platform: { os: 'macos', browser: 'chrome', osVersion: '15.0.0' } };
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
        protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true,
        hasPrf: true, isUserVerified: true, automaticPresenceSimulation: true
    } });
    const a = await fixture('A'), b = await fixture('B', 'password-key');
    await openA(page, a);
    await openPicker(page);
    await page.locator('#open-file-input').setInputFiles(payload(b.buffer, b.name));
    await selectKey(page, b.key!);
    await page.getByRole('checkbox', { name: 'Set up passkey after unlocking', exact: true }).check();
    await passwordOpen(page, b.password);
    await expect(picker(page)).toHaveCount(0);
    const form = page.getByRole('form', { name: 'Database settings: B', exact: true });
    const region = form.getByRole('region', { name: 'Local passkey unlock', exact: true });
    await expect(region).toBeFocused();
    expect((await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials).toHaveLength(0);
    await region.getByLabel('Current master password', { exact: true }).fill(b.password);
    await region.getByLabel('Current key file (if required)', { exact: true }).setInputFiles({
        name: 'B.keyx', mimeType: 'application/octet-stream', buffer: Buffer.from(b.key!)
    });
    await region.getByRole('button', { name: 'Enable local passkey', exact: true }).click();
    await expect(region.getByRole('status')).toContainText('Passkey unlock saved in this browser');
    const records = await page.evaluate(() => JSON.parse(localStorage.getItem('fileInfo') || '[]'));
    expect(records.find((info: any) => info.name === 'A').passkeyCredentialId).toBeFalsy();
    expect(records.find((info: any) => info.name === 'B').passkeyCredentialId).toBeTruthy();
    await page.getByRole('button', { name: 'Back to vault', exact: true }).click();
    await assertDraft(page);
    await page.getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.locator('.vault-row[data-vault="A"]')).toBeVisible();
    await page.locator('.vault-row[data-vault="A"]').click();
    await passwordOpen(page, a.password);
    await row(page, 'A').click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await openPicker(page);
    await picker(page).locator('.vault-row[data-vault="B"]').click();
    await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
    await expect(page.locator('#unlock-error')).toContainText('Select the key file first');
    await selectKey(page, b.key!);
    await holdDecrypt(page);
    await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
    await expect.poll(() => page.evaluate(() => !!(window as any).__held)).toBe(true);
    await picker(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await releaseDecrypt(page);
    await assertDraft(page);
    await expect(row(page, 'B')).toHaveCount(0);
    await openPicker(page);
    await picker(page).locator('.vault-row[data-vault="B"]').click();
    await selectKey(page, b.key!);
    await page.getByRole('button', { name: 'Unlock with passkey', exact: true }).click();
    await assertDraft(page);
    await expect(row(page, 'B')).toHaveCount(1);
});

test('retrying a failed create save retains one new vault and the existing draft', async ({ page }) => {
    const a = await fixture('A');
    await openA(page, a);
    await openPicker(page);
    await page.locator('#create-vault').click();
    const form = picker(page).getByRole('form', { name: 'Create a vault', exact: true });
    await form.getByLabel('Vault name', { exact: true }).fill('Created B');
    await form.getByLabel('Master password', { exact: true }).fill('new B master password');
    await form.getByLabel('Confirm password', { exact: true }).fill('different');
    await form.getByRole('button', { name: 'Create vault', exact: true }).click();
    await expect(form.getByRole('alert')).toHaveText('Passwords do not match.');
    await form.getByLabel('Confirm password', { exact: true }).fill('new B master password');
    // Exercise a serializer failure, independently of cache availability policy.
    await page.evaluate(() => {
        const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
        crypto.subtle.encrypt = (...args) => {
            const algorithm = typeof args[0] === 'string' ? args[0] : args[0].name;
            if (algorithm === 'AES-CBC') return Promise.reject(new Error('Synthetic encryption failure'));
            return encrypt(...args);
        };
        (window as any).__restoreEncrypt = () => { crypto.subtle.encrypt = encrypt; };
    });
    await form.getByRole('button', { name: 'Create vault', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('Synthetic encryption failure');
    await page.evaluate(() => (window as any).__restoreEncrypt());
    await expect(form.getByLabel('Vault name', { exact: true })).toBeDisabled();
    await expect(form.getByRole('status')).toContainText('initial save failed');
    await form.getByRole('button', { name: 'Retry saving', exact: true }).click();
    await assertDraft(page);
    await editor(page).getByRole('button', { name: 'Save', exact: true }).click();
    await settings(page);
    await expect(page.getByRole('form', { name: 'Database settings: Created B', exact: true })).toHaveCount(1);
    await expect(page.getByRole('form', { name: /^Database settings: / })).toHaveCount(2);
    const bytes = await download(page, 'Created B');
    const created = await kdbx.Kdbx.load(new Uint8Array(bytes).buffer,
        new kdbx.Credentials(kdbx.ProtectedValue.fromString('new B master password')));
    expect(created.meta.name).toBe('Created B');
    expect([...created.getDefaultGroup().allEntries()]).toHaveLength(0);
    await assertExport(await download(page, 'A'), a, { ...a, password: 'new B master password', id: 'absent' }, notes);
});
