import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

test('database settings Save waits for an in-flight provider save and becomes available afterward', async ({ page }) => {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const password = 'Disposable settings save state';
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)), 'Settings sync');
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    db.createEntry(db.groups[0]).fields.set('Title', 'Before save');
    let revision = Date.UTC(2026, 0, 1);
    const files = new Map([['/settings.kdbx', { bytes: Buffer.from(await db.save()), revision }]]);
    let hold = false, entered = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const server = createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'OPTIONS,GET,HEAD,PUT,MOVE,DELETE');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization,Cache-Control,Content-Type,If-Match,If-None-Match,Destination,Overwrite');
        res.setHeader('Access-Control-Expose-Headers', 'Last-Modified,ETag');
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
        const path = new URL(req.url!, 'http://localhost').pathname;
        if (req.method === 'PUT') {
            const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
            if (hold) { entered = true; await gate; }
            files.set(path, { bytes: Buffer.concat(chunks), revision: (revision += 1000) });
            res.writeHead(201).end(); return;
        }
        const file = files.get(path);
        if (!file) { res.writeHead(404).end(); return; }
        if (req.method === 'MOVE') {
            files.set(new URL(String(req.headers.destination), 'http://localhost').pathname, file);
            files.delete(path); res.writeHead(201).end(); return;
        }
        res.setHeader('Last-Modified', new Date(file.revision).toUTCString());
        res.setHeader('ETag', `"${file.revision}"`);
        res.writeHead(200).end(req.method === 'HEAD' ? undefined : file.bytes);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        await page.goto('/next.html'); await page.locator('#open-webdav').click();
        await page.locator('#webdav-url').fill(`http://127.0.0.1:${(server.address() as AddressInfo).port}/settings.kdbx`);
        await page.locator('#webdav-next').click(); await page.locator('#password').fill(password); await page.locator('#unlock').click();
        await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout: 30_000 });
        hold = true;
        await page.locator('.entry-row').first().click(); await page.getByRole('button', { name: 'Edit', exact: true }).click();
        await page.locator('.entry-editor').getByLabel('Title', { exact: true }).fill('After save');
        await page.locator('.entry-editor').getByRole('button', { name: 'Save', exact: true }).click();
        await expect.poll(() => entered, { timeout: 30_000 }).toBe(true);
        await page.locator('#open-settings').click(); await page.getByRole('tab', { name: 'Database', exact: true }).click();
        const save = page.getByRole('button', { name: 'Save database settings', exact: true });
        await expect(save).toBeDisabled();
        hold = false; release();
        await expect(save).toBeEnabled({ timeout: 30_000 });
        await save.click(); await expect(page.getByRole('status')).toHaveText('Database settings saved.', { timeout: 30_000 });
        const reopened = await kdbx.Kdbx.load(new Uint8Array(files.get('/settings.kdbx')!.bytes).buffer,
            new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)));
        expect(reopened.groups[0].entries[0].fields.get('Title')).toBe('After save');
    } finally { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
