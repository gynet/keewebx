import { test as base, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import * as kdbxweb from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const FIXTURE = path.resolve(__dirname, '../../modules/db/resources/KDBX4.1.kdbx');
const PASSWORD = 'test';
const AUTHORIZATION = `Basic ${Buffer.from('alice:dav-password').toString('base64')}`;
const VAULT_PATH = '/vault.kdbx';
const SYNC_TIMEOUT = 45_000;

interface DavRequest {
    method: string;
    pathname: string;
    authorization?: string;
    origin?: string;
    requestedMethod?: string;
    requestedHeaders?: string;
    destination?: string;
    status: number;
}

interface DavFile {
    data: Buffer;
    modified: string;
}

/** Real HTTP responses let the browser enforce CORS and expose response headers. */
async function startDav() {
    const requests: DavRequest[] = [];
    const files = new Map<string, DavFile>();
    let revision = Date.UTC(2026, 10, 12);
    let rejectWrites = false;
    let unreachable = false;
    let nextPutGate: Promise<void> | undefined;
    let releasePut: (() => void) | undefined;
    const write = (pathname: string, data: Buffer) => {
        revision += 1000;
        files.set(pathname, { data: Buffer.from(data), modified: new Date(revision).toUTCString() });
    };
    write(VAULT_PATH, readFileSync(FIXTURE));

    const server = createServer(async (req, res) => {
        const pathname = decodeURIComponent(new URL(req.url!, 'http://localhost').pathname);
        const request: DavRequest = {
            method: req.method!, pathname,
            authorization: req.headers.authorization,
            origin: req.headers.origin,
            requestedMethod: req.headers['access-control-request-method'] as string | undefined,
            requestedHeaders: req.headers['access-control-request-headers'] as string | undefined,
            destination: req.headers.destination as string | undefined,
            status: 0
        };
        requests.push(request);
        if (unreachable) {
            req.socket.destroy();
            return;
        }
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, HEAD, PUT, MOVE, DELETE');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Cache-Control, Content-Type, Destination, Overwrite, If-Match, If-None-Match');
        res.setHeader('Access-Control-Expose-Headers', 'Last-Modified, ETag');
        res.setHeader('Vary', 'Origin');
        res.setHeader('Cache-Control', 'no-store');
        const finish = (status: number, body?: Buffer) => {
            request.status = status;
            res.writeHead(status).end(body);
        };
        if (req.method === 'OPTIONS') {
            finish(204);
            return;
        }
        if (req.headers.authorization !== AUTHORIZATION) {
            res.setHeader('WWW-Authenticate', 'Basic realm="Test vault"');
            finish(401);
            return;
        }
        if (rejectWrites && (req.method === 'PUT' || req.method === 'MOVE')) {
            req.resume();
            finish(503);
            return;
        }
        if (req.method === 'PUT') {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            const gate = nextPutGate;
            nextPutGate = undefined;
            if (gate) await gate;
            write(pathname, Buffer.concat(chunks));
            finish(201);
            return;
        }
        const file = files.get(pathname);
        if (!file) {
            finish(404);
            return;
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Last-Modified', file.modified);
            res.setHeader('ETag', `"${file.modified}"`);
            finish(200, req.method === 'GET' ? file.data : undefined);
        } else if (req.method === 'MOVE') {
            const destination = request.destination && new URL(request.destination, 'http://localhost');
            if (!destination || !files.has(VAULT_PATH) || destination.pathname !== VAULT_PATH) {
                finish(400);
                return;
            }
            write(destination.pathname, file.data);
            files.delete(pathname);
            finish(204);
        } else if (req.method === 'DELETE') {
            files.delete(pathname);
            finish(204);
        } else {
            finish(405);
        }
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}${VAULT_PATH}`,
        requests, files, write,
        remote: () => files.get(VAULT_PATH)!,
        rejectWrites: (reject: boolean) => { rejectWrites = reject; },
        setUnreachable: (value: boolean) => { unreachable = value; },
        holdNextPut: () => {
            nextPutGate = new Promise<void>((resolve) => { releasePut = resolve; });
            return () => releasePut?.();
        },
        async close() {
            releasePut?.();
            if (!server.listening) return;
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => server.close((err) =>
                err && (err as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING' ? reject(err) : resolve()));
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

async function decrypt(data: Buffer): Promise<kdbxweb.Kdbx> {
    kdbxweb.CryptoEngine.setArgon2Impl(argon2);
    return kdbxweb.Kdbx.load(
        new Uint8Array(data).buffer as ArrayBuffer,
        new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(PASSWORD))
    );
}

const entries = (db: kdbxweb.Kdbx) => db.groups.flatMap((group) => [...group.allEntries()]);
const fieldText = (entry: kdbxweb.KdbxEntry, field: string) => {
    const value = entry.fields.get(field);
    return value instanceof kdbxweb.ProtectedValue ? value.getText() : value;
};
const row = (page: Page, title: string) => page.locator('.entry-row').filter({
    has: page.getByText(title, { exact: true })
});
const synced = (page: Page) => expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout: SYNC_TIMEOUT });
const cached = (page: Page) => expect(page.locator('#sync-state')).toHaveText('Offline, saved on this device', { timeout: SYNC_TIMEOUT });

async function connect(page: Page, dav: Dav): Promise<void> {
    await page.goto('/next.html');
    await page.click('#open-webdav');
    await page.fill('#webdav-url', dav.url);
    await page.fill('#webdav-user', 'alice');
    await page.fill('#webdav-pass', 'dav-password');
    await page.click('#webdav-next');
    await page.fill('#password', PASSWORD);
    await page.click('#unlock');
    await expect(page.locator('.entry-row').first()).toBeVisible({ timeout: 30_000 });
}

async function createEntry(page: Page, title: string, notes = ''): Promise<void> {
    await page.getByRole('button', { name: 'New entry', exact: true }).click();
    const form = page.locator('.entry-editor');
    await form.getByLabel('Title', { exact: true }).fill(title);
    await form.getByLabel('Username', { exact: true }).fill('remote-user');
    await form.getByLabel('Password', { exact: true }).fill('Remote protected password !42');
    await form.getByLabel('Website', { exact: true }).fill('https://example.com/saved');
    await form.getByLabel('Notes', { exact: true }).fill(notes);
    await form.getByLabel('Tags', { exact: true }).fill('remote, roundtrip');
    await form.getByRole('button', { name: 'Add field', exact: true }).click();
    await form.getByLabel('Field name', { exact: true }).fill('Recovery code');
    await form.getByLabel('Field value', { exact: true }).fill('Protected recovery value');
    await form.getByLabel('Protected', { exact: true }).check();
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#entry-title')).toHaveText(title);
}

async function lockAndReload(page: Page): Promise<void> {
    await page.click('#lock');
    await expect(page.locator('.entry-row')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.locator('.vault-row[data-vault="vault"]')).toBeVisible();
    await page.reload();
    await page.locator('.vault-row[data-vault="vault"]').click();
}

async function reopen(page: Page): Promise<void> {
    await page.fill('#password', PASSWORD);
    await page.click('#unlock');
    await expect(page.locator('.entry-row').first()).toBeVisible({ timeout: 30_000 });
}

test.describe('New interface WebDAV persistence', () => {
    test.setTimeout(120_000);

    test('saves an encrypted remote entry with authenticated CORS and reopens it without a local cache', async ({ page, browser, dav }) => {
        const original = dav.remote();
        const baseline = await decrypt(original.data);
        await connect(page, dav);
        const title = 'Saved remote account';
        const notes = '# Remote notes\n\n**Persisted source**\nsecond line';
        await createEntry(page, title, notes);
        await synced(page);

        const remote = dav.remote();
        expect(remote.data.equals(original.data)).toBe(false);
        expect(remote.modified).not.toBe(original.modified);
        const db = await decrypt(remote.data);
        expect([db.header.versionMajor, db.header.versionMinor]).toEqual([4, 1]);
        const saved = entries(db).find((entry) => fieldText(entry, 'Title') === title)!;
        expect(saved).toBeDefined();
        expect(fieldText(saved, 'UserName')).toBe('remote-user');
        expect(fieldText(saved, 'Password')).toBe('Remote protected password !42');
        expect(fieldText(saved, 'URL')).toBe('https://example.com/saved');
        expect(fieldText(saved, 'Notes')).toBe(notes);
        expect(saved.tags).toEqual(['remote', 'roundtrip']);
        expect(saved.fields.get('Password')).toBeInstanceOf(kdbxweb.ProtectedValue);
        expect(saved.fields.get('Recovery code')).toBeInstanceOf(kdbxweb.ProtectedValue);
        expect(fieldText(saved, 'Recovery code')).toBe('Protected recovery value');
        for (const entry of entries(baseline)) {
            expect(entries(db).some((candidate) => candidate.uuid.equals(entry.uuid))).toBe(true);
        }
        expect(remote.data.includes(Buffer.from('Remote protected password !42'))).toBe(false);
        expect(remote.data.includes(Buffer.from('Protected recovery value'))).toBe(false);

        const actual = dav.requests.filter((request) => request.method !== 'OPTIONS');
        expect(actual.every((request) => request.authorization === AUTHORIZATION)).toBe(true);
        const preflights = dav.requests.filter((request) => request.method === 'OPTIONS');
        expect(preflights.length).toBeGreaterThan(0);
        expect(preflights.some((request) => request.requestedHeaders?.includes('authorization'))).toBe(true);
        expect(preflights.every((request) => request.status === 204)).toBe(true);
        const put = actual.find((request) => request.method === 'PUT')!;
        const move = actual.find((request) => request.method === 'MOVE')!;
        expect(put.status).toBe(201);
        expect(put.pathname).not.toBe(VAULT_PATH);
        expect(move.pathname).toBe(put.pathname);
        expect(move.status).toBe(204);
        expect(new URL(move.destination!).pathname).toBe(VAULT_PATH);
        expect([...dav.files.keys()]).toEqual([VAULT_PATH]);

        // A new browser context must fetch the saved file, not a previous cache.
        const fresh = await browser.newContext({ baseURL: new URL(page.url()).origin });
        try {
            const secondPage = await fresh.newPage();
            const requestsBefore = dav.requests.length;
            await connect(secondPage, dav);
            await row(secondPage, title).click();
            await expect(secondPage.locator('[data-field="user"] .field__value')).toHaveText('remote-user');
            await expect(secondPage.locator('.entry-notes .markdown h1')).toHaveText('Remote notes');
            await expect(secondPage.locator('[data-field="password"] .field__value')).toHaveText(/•/);
            expect(dav.requests.slice(requestsBefore).some((request) => request.method === 'GET' && request.status === 200)).toBe(true);
        } finally { await fresh.close(); }
    });

    test('keeps offline edits through lock, reload and wrong-password retry, then uploads them on reconnect', async ({ page, context, dav }) => {
        await connect(page, dav);
        const original = dav.remote().data;
        await context.setOffline(true);
        await createEntry(page, 'Offline account', '# Offline notes\n\nSaved before locking');
        await cached(page);
        expect(dav.remote().data.equals(original)).toBe(true);
        // Keep the app origin reachable for reload while the DAV service is down.
        dav.setUnreachable(true);
        await page.click('#lock');
        await expect(page.locator('.entry-row')).toHaveCount(0, { timeout: 30_000 });
        await context.setOffline(false);
        await page.reload();
        await page.locator('.vault-row[data-vault="vault"]').click();
        await page.fill('#password', 'wrong-password');
        await page.click('#unlock');
        await expect(page.locator('#unlock-error')).toHaveText('Wrong password', { timeout: 30_000 });
        await expect(page.locator('.entry-row')).toHaveCount(0);
        await reopen(page);
        await row(page, 'Offline account').click();
        await expect(page.locator('.entry-notes .markdown h1')).toHaveText('Offline notes');
        await expect(page.locator('[data-field="user"] .field__value')).toHaveText('remote-user');
        await cached(page);
        expect(dav.remote().data.equals(original)).toBe(true);

        dav.setUnreachable(false);
        await context.setOffline(true);
        await context.setOffline(false);
        await synced(page);
        const saved = entries(await decrypt(dav.remote().data)).find((entry) => fieldText(entry, 'Title') === 'Offline account')!;
        expect(saved).toBeDefined();
        expect(fieldText(saved, 'Password')).toBe('Remote protected password !42');
        expect(fieldText(saved, 'Notes')).toBe('# Offline notes\n\nSaved before locking');
        await lockAndReload(page);
        await reopen(page);
        await expect(row(page, 'Offline account')).toBeVisible();
    });

    test('preserves the original remote file on HTTP write failure and retries the cached edit', async ({ page, dav }) => {
        await connect(page, dav);
        const original = dav.remote().data;
        dav.rejectWrites(true);
        await createEntry(page, 'Retried account');
        await expect.poll(() => dav.requests.some((request) => request.method === 'PUT' && request.status === 503), { timeout: SYNC_TIMEOUT }).toBe(true);
        await cached(page);
        expect(dav.remote().data.equals(original)).toBe(true);
        expect(dav.requests.some((request) => request.method === 'MOVE')).toBe(false);

        await lockAndReload(page);
        await reopen(page);
        await expect(row(page, 'Retried account')).toBeVisible();
        await cached(page);
        dav.rejectWrites(false);
        await synced(page);
        const saved = entries(await decrypt(dav.remote().data)).find((entry) => fieldText(entry, 'Title') === 'Retried account')!;
        expect(saved).toBeDefined();
        expect(fieldText(saved, 'Recovery code')).toBe('Protected recovery value');
        expect(dav.requests.some((request) => request.method === 'MOVE' && request.status === 204)).toBe(true);
    });

    test('merges an independently saved remote change without dropping the local edit', async ({ page, dav }) => {
        await connect(page, dav);
        const remote = await decrypt(dav.remote().data);
        const other = remote.createEntry(remote.getDefaultGroup());
        other.fields.set('Title', 'Account from another device');
        other.fields.set('UserName', 'other-device-user');
        other.fields.set('Password', kdbxweb.ProtectedValue.fromString('Other device password'));
        dav.write(VAULT_PATH, Buffer.from(await remote.save()));
        const requestsBefore = dav.requests.length;
        await createEntry(page, 'Account from this device');
        await synced(page);

        const db = await decrypt(dav.remote().data);
        const all = entries(db);
        expect(all.filter((entry) => fieldText(entry, 'Title') === 'Account from this device')).toHaveLength(1);
        const merged = all.filter((entry) => fieldText(entry, 'Title') === 'Account from another device');
        expect(merged).toHaveLength(1);
        expect(fieldText(merged[0], 'Password')).toBe('Other device password');
        expect(dav.requests.slice(requestsBefore).some((request) => request.method === 'GET' && request.status === 200)).toBe(true);
        await expect(row(page, 'Account from another device')).toBeVisible();
        await lockAndReload(page);
        await reopen(page);
        await expect(row(page, 'Account from another device')).toBeVisible();
        await expect(row(page, 'Account from this device')).toBeVisible();
    });

    test('saves a second change made while the first upload is still in flight', async ({ page, dav }) => {
        await connect(page, dav);
        const original = dav.remote().data;
        const release = dav.holdNextPut();
        try {
            await createEntry(page, 'First in-flight account');
            await expect.poll(() => dav.requests.some((request) => request.method === 'PUT'), { timeout: SYNC_TIMEOUT }).toBe(true);
            await expect(page.locator('#sync-state')).toHaveText('Saving…');
            await createEntry(page, 'Second in-flight account');
            expect(dav.remote().data.equals(original)).toBe(true);
        } finally { release(); }
        await synced(page);
        const db = await decrypt(dav.remote().data);
        const titles = entries(db).map((entry) => fieldText(entry, 'Title'));
        expect(titles.filter((title) => title === 'First in-flight account')).toHaveLength(1);
        expect(titles.filter((title) => title === 'Second in-flight account')).toHaveLength(1);
        expect(dav.requests.filter((request) => request.method === 'MOVE' && request.status === 204).length).toBeGreaterThanOrEqual(2);
        await lockAndReload(page);
        await reopen(page);
        await expect(row(page, 'First in-flight account')).toBeVisible();
        await expect(row(page, 'Second in-flight account')).toBeVisible();
    });
});


test('forgetting a remote vault removes only this browser record and preserves the server database', async ({ page, dav }) => {
    await connect(page, dav);
    await synced(page);
    await lockAndReload(page);
    const before = Buffer.from(dav.remote().data);
    const boundary = dav.requests.length;
    const remove = page.getByRole('button', { name: 'Remove vault.kdbx from this browser', exact: true });
    await page.locator('.vault-row-wrap').hover();
    page.once('dialog', async dialog => {
        expect(dialog.message()).toContain('remote database will not be deleted');
        await dialog.dismiss();
    });
    await remove.click();
    await expect(remove).toHaveCount(1);
    page.once('dialog', dialog => dialog.accept());
    await remove.click();
    await expect(page.locator('.vault-row[data-vault="vault"]')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('.vault-row[data-vault="vault"]')).toHaveCount(0);
    expect(dav.remote().data.equals(before)).toBe(true);
    expect(dav.requests.slice(boundary).filter(request => ['DELETE','PUT','MOVE'].includes(request.method))).toEqual([]);
    // A fresh connection still opens the original remote file.
    await connect(page, dav);
    await expect(page.locator('.entry-row').first()).toBeVisible();
});
