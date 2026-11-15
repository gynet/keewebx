import { expect, type Page } from '@playwright/test';
import * as kdbx from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';
export { kdbx };
export const password = 'Disposable mobile groups master';
export async function groupFixture() {
    kdbx.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbx.Kdbx.create(new kdbx.Credentials(kdbx.ProtectedValue.fromString(password)), 'Team vault');
    db.header.kdfParameters!.set('M', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(32 * 1024));
    db.header.kdfParameters!.set('I', kdbx.VarDictionary.ValueType.UInt64, kdbx.Int64.from(2));
    const projects = db.createGroup(db.groups[0], 'Projects');
    let leaf = projects;
    for (const title of ['Operations', 'Europe', 'Customer accounts', 'Production', 'Access and recovery']) leaf = db.createGroup(leaf, title);
    const entry = db.createEntry(leaf); entry.fields.set('Title', 'Recovery account'); entry.fields.set('Password', kdbx.ProtectedValue.fromString('Synthetic!Secret789')); entry.pushHistory();
    for (let i = 1; i <= 45; i++) {
        const group = db.createGroup(db.groups[0], `Folder ${String(i).padStart(2, '0')}${i === 31 ? ' — a long shared name that must wrap on a phone' : ''}`);
        db.createEntry(group).fields.set('Title', `Account ${i}`);
    }
    return { bytes: Buffer.from(await db.save()), root: db.groups[0].uuid.id, projects: projects.uuid.id, leaf: leaf.uuid.id, entry: entry.uuid.id };
}
export async function openGroups(page: Page) {
    const source = await groupFixture(); await page.goto('/next.html');
    await page.locator('#open-file-input').setInputFiles({ name: 'team.kdbx', mimeType: 'application/octet-stream', buffer: source.bytes });
    await page.locator('#password').fill(password); await page.locator('#unlock').click();
    await expect(page.locator('#sync-state')).toHaveText('Up to date'); return source;
}
