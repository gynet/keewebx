import { expect, type Page } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';
export { kdbx };
export const password = 'Disposable lifecycle master';
export const timeout = 30_000;
export async function png(page: Page, color = 'blue', width = 300, height = 96) {
    return Buffer.from(await page.evaluate(({ color, width, height }) => {
        const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
        const context = canvas.getContext('2d')!; context.fillStyle = color; context.fillRect(0, 0, width, height);
        return canvas.toDataURL('image/png').split(',')[1];
    }, { color, width, height }), 'base64');
}
export async function fixture(page: Page, trash = true, website = 'https://icons.example.test/path?private=omitted') {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)), 'Lifecycle');
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    db.meta.recycleBinEnabled = trash;
    const work = db.createGroup(db.groups[0], 'Work'), sibling = db.createGroup(db.groups[0], 'Sibling');
    const custom = kdbx.KdbxUuid.random(), bytes = await png(page, 'red', 16, 16);
    db.meta.customIcons.set(custom.id, { data: new Uint8Array(bytes).buffer });
    work.customIcon = custom; sibling.customIcon = custom;
    const entry = db.createEntry(work); entry.fields.set('Title', 'Existing account'); entry.fields.set('URL', website);
    entry.fields.set('Password', kdbx.ProtectedValue.fromString('Keep!ExistingSecret789')); entry.customIcon = custom; entry.pushHistory();
    const group = db.createGroup(db.groups[0], 'Templates'); db.meta.entryTemplatesGroup = group.uuid;
    const template = db.createEntry(group); template.fields.set('Title', 'Account template'); template.fields.set('Password', kdbx.ProtectedValue.fromString('Reusable!Secret123')); template.pushHistory();
    template.binaries.set('proof.bin', await db.createBinary(new Uint8Array([1, 4, 9]).buffer));
    const clone = db.createEntry(work); clone.fields.set('Title', 'Created instance'); clone.fields.set('Password', kdbx.ProtectedValue.fromString('Reusable!Secret123'));
    return { bytes: Buffer.from(await db.save()), work: work.uuid.id, sibling: sibling.uuid.id, entry: entry.uuid.id,
        template: template.uuid.id, templateGroup: group.uuid.id, clone: clone.uuid.id, icon: custom.id, png: bytes };
}
export async function open(page: Page, trash = true, website?: string) {
    const source = await fixture(page, trash, website); await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles({ name: 'lifecycle.kdbx', mimeType: 'application/octet-stream', buffer: source.bytes });
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout }); return source;
}
export async function browse(page: Page) {
    const groups = page.getByRole('dialog', { name: 'Groups', exact: true });
    if (await groups.isVisible()) await groups.getByRole('button', { name: 'Show entries', exact: true }).click();
    const settingsBack = page.getByRole('button', { name: 'Back to vault', exact: true });
    await expect.poll(async () => await settingsBack.isVisible() || await page.getByRole('navigation', { name: 'Vault', exact: true }).isVisible() || await page.getByRole('button', { name: 'Browse vault', exact: true }).isVisible(), { timeout }).toBe(true);
    if (await settingsBack.isVisible()) await settingsBack.click();
    if (!await page.getByRole('navigation', { name: 'Vault', exact: true }).isVisible()) await page.getByRole('button', { name: 'Browse vault', exact: true }).click();
}
export async function download(page: Page) {
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    await browse(page); await page.locator('#open-settings').click(); await page.getByRole('tab', { name: 'Database', exact: true }).click();
    const pending = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download KDBX', exact: true }).click();
    const stream = await (await pending).createReadStream(); if (!stream) throw new Error('Missing encrypted data');
    const chunks: Buffer[] = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    return kdbx.Kdbx.load(new Uint8Array(Buffer.concat(chunks)).buffer, new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)));
}
export const find = (db: kdbx.Kdbx, id: string) => [...db.groups[0].allEntries()].find(entry => entry.uuid.id === id)!;
export async function back(page: Page) { await page.locator('#settings-back:visible, .settings__phone-back:visible').click(); }
export async function selectGroup(page: Page, name = 'Work') {
    await browse(page); await page.getByRole('navigation', { name: 'Vault', exact: true }).getByRole('button', { name, exact: true }).click();
}
export async function groupActions(page: Page, name = 'Work') {
    await selectGroup(page, name); await browse(page);
    await page.getByRole('button', { name: 'Manage groups', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Groups', exact: true });
    if (await sheet.isVisible()) await sheet.getByRole('button', { name: 'Group actions', exact: true }).click();
    return page.getByRole('group', { name: `Group actions: ${name}`, exact: true });
}
