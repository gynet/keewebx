import { test, expect, type Locator, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as kdbxweb from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

// Follow next-groups/next-export's real encrypted fixture and download patterns.
// No app-model injection: all mutations after uploading the fixture use visible UI.
// Vault's Manage groups route exposes GroupActions for the selected group/root.
// Missing controls are failures, not skips or a fallback to model calls.
const password = 'group lifecycle password';
const timeout = 30_000;
const proof = Buffer.from([0, 1, 10, 127, 128, 200, 255]);
const navigation = (page: Page) => page.getByRole('navigation', { name: 'Vault', exact: true });
const actions = (page: Page, name: string) => page.getByRole('group', { name: `Group actions: ${name}`, exact: true });
const entryRow = (page: Page, title: string) => page.locator('.entry-row').filter({
    has: page.getByText(title, { exact: true })
});

async function fixture(name = 'Group lifecycle', trashEnabled = true, nestedBin = false) {
    kdbxweb.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password)), name);
    const root = db.groups[0];
    const parent = db.createGroup(root, 'Parent');
    const child = db.createGroup(parent, 'Child');
    const leaf = db.createGroup(child, 'Leaf');
    const sibling = db.createGroup(root, 'Sibling');
    parent.notes = 'Keep group notes';
    child.icon = 3;
    child.enableSearching = true;
    const makeEntry = (group: kdbxweb.KdbxGroup, title: string) => {
        const entry = db.createEntry(group);
        entry.fields.set('Title', title);
        entry.fields.set('UserName', `${name} user`);
        entry.fields.set('Password', kdbxweb.ProtectedValue.fromString(`${title} secret`));
        entry.tags = ['group-fidelity'];
        return entry;
    };
    const parentEntry = makeEntry(parent, 'Parent account');
    const leafEntry = makeEntry(leaf, 'Earlier leaf account');
    leafEntry.pushHistory();
    leafEntry.fields.set('Title', 'Leaf account');
    leafEntry.fields.set('Password', kdbxweb.ProtectedValue.fromString('Current leaf secret'));
    leafEntry.fields.set('Recovery code', kdbxweb.ProtectedValue.fromString('Protected group recovery'));
    leafEntry.binaries.set('proof.bin', await db.createBinary(new Uint8Array(proof).buffer));
    const siblingEntry = makeEntry(sibling, 'Unchanged sibling account');
    const bin = db.getGroup(db.meta.recycleBinUuid!)!;
    if (nestedBin) db.move(bin, db.createGroup(root, 'Bin container'));
    // Keep an existing bin UUID even when disabled: deletion must obey the flag.
    db.meta.recycleBinEnabled = trashEnabled;
    return {
        name, data: Buffer.from(await db.save()), trashEnabled,
        ids: {
            root: root.uuid.id, parent: parent.uuid.id, child: child.uuid.id,
            leaf: leaf.uuid.id, sibling: sibling.uuid.id, bin: bin.uuid.id,
            parentEntry: parentEntry.uuid.id, leafEntry: leafEntry.uuid.id, siblingEntry: siblingEntry.uuid.id
        }
    };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const allEntries = (db: kdbxweb.Kdbx) => db.groups.flatMap((group) => [...group.allEntries()]);
const text = (entry: kdbxweb.KdbxEntry, field: string) => {
    const value = entry.fields.get(field);
    return value instanceof kdbxweb.ProtectedValue ? value.getText() : value;
};
function groups(db: kdbxweb.Kdbx): kdbxweb.KdbxGroup[] {
    const visit = (group: kdbxweb.KdbxGroup): kdbxweb.KdbxGroup[] => [group, ...group.groups.flatMap(visit)];
    return db.groups.flatMap(visit);
}
function requireGroup(db: kdbxweb.Kdbx, id: string): kdbxweb.KdbxGroup {
    const found = db.getGroup(id);
    expect(found, `Group ${id} must survive the encrypted roundtrip`).toBeDefined();
    if (!found) throw new Error(`Missing group ${id}`);
    return found;
}
function expectSeedEntries(db: kdbxweb.Kdbx, source: Fixture) {
    const entries = allEntries(db);
    expect(entries).toHaveLength(3);
    const leaf = entries.find((entry) => entry.uuid.id === source.ids.leafEntry);
    expect(leaf).toBeDefined();
    if (!leaf) throw new Error('Lost leaf entry');
    expect(text(leaf, 'Title')).toBe('Leaf account');
    expect(text(leaf, 'UserName')).toBe(`${source.name} user`);
    expect(text(leaf, 'Password')).toBe('Current leaf secret');
    expect(leaf.fields.get('Password')).toBeInstanceOf(kdbxweb.ProtectedValue);
    expect(text(leaf, 'Recovery code')).toBe('Protected group recovery');
    expect(leaf.fields.get('Recovery code')).toBeInstanceOf(kdbxweb.ProtectedValue);
    expect(leaf.tags).toEqual(['group-fidelity']);
    expect(leaf.parentGroup?.uuid.id).toBe(source.ids.leaf);
    expect(leaf.history).toHaveLength(1);
    expect(text(leaf.history[0], 'Title')).toBe('Earlier leaf account');
    expect(text(leaf.history[0], 'Password')).toBe('Earlier leaf account secret');
    const binary = leaf.binaries.get('proof.bin');
    expect(kdbxweb.KdbxBinaries.isKdbxBinaryWithHash(binary)).toBe(true);
    if (!kdbxweb.KdbxBinaries.isKdbxBinaryWithHash(binary)) throw new Error('Lost attachment reference');
    const bytes = binary.value instanceof kdbxweb.ProtectedValue ? binary.value.getBinary() : new Uint8Array(binary.value);
    expect(Buffer.from(bytes)).toEqual(proof);
    for (const [id, parentId, title] of [
        [source.ids.parentEntry, source.ids.parent, 'Parent account'],
        [source.ids.siblingEntry, source.ids.sibling, 'Unchanged sibling account']
    ]) {
        const entry = entries.find((item) => item.uuid.id === id);
        expect(entry).toBeDefined();
        expect(entry?.parentGroup?.uuid.id).toBe(parentId);
        expect(text(entry!, 'Title')).toBe(title);
        expect(text(entry!, 'Password')).toBe(`${title} secret`);
        expect(entry!.fields.get('Password')).toBeInstanceOf(kdbxweb.ProtectedValue);
    }
    expect(requireGroup(db, source.ids.parent).notes).toBe('Keep group notes');
    expect(requireGroup(db, source.ids.child).icon).toBe(3);
    expect(requireGroup(db, source.ids.child).enableSearching).toBe(true);
    expect(requireGroup(db, source.ids.child).parentGroup?.uuid.id).toBe(source.ids.parent);
    expect(requireGroup(db, source.ids.leaf).parentGroup?.uuid.id).toBe(source.ids.child);
}

async function activate(control: Locator, touch = false) {
    await expect(control).toBeVisible();
    await expect(control).toBeEnabled();
    if (touch) await control.tap({ timeout: 10_000 });
    else await control.click({ timeout: 10_000 });
}
async function showNavigation(page: Page, touch = false) {
    if (!await navigation(page).isVisible()) {
        await activate(page.getByRole('button', { name: 'Browse vault', exact: true }), touch);
    }
    await expect(navigation(page)).toBeVisible();
}
async function chooseGroup(page: Page, path: string[], touch = false) {
    await showNavigation(page, touch);
    for (const ancestor of path.slice(0, -1)) {
        const expand = navigation(page).getByRole('button', { name: `Expand ${ancestor}`, exact: true });
        if (await expand.isVisible()) await activate(expand, touch);
        // Absence of both states fails: an unintegrated navigation is not a skip.
        await expect(navigation(page).getByRole('button', { name: `Collapse ${ancestor}`, exact: true })).toBeVisible();
    }
    await activate(navigation(page).getByRole('button', { name: path[path.length - 1], exact: true }), touch);
}
async function openManager(page: Page, touch = false) {
    await showNavigation(page, touch);
    await activate(navigation(page).getByRole('button', { name: 'Manage groups', exact: true }), touch);
    await expect(page.locator('details').filter({ has: page.locator('summary', { hasText: /^Manage groups$/ }) }))
        .toHaveAttribute('open', '');
}
async function actionBar(page: Page, group: string, touch = false) {
    await openManager(page, touch);
    const bar = actions(page, group);
    await expect(bar).toBeVisible();
    return bar;
}
async function screenshot(page: Page, name: string) {
    const path = test.info().outputPath(`${name}.png`);
    await page.screenshot({ path, fullPage: true });
    await test.info().attach(name, { path, contentType: 'image/png' });
}
async function openFixture(page: Page, source: Fixture) {
    await page.goto('/next.html');
    await page.setInputFiles('#open-file-input', {
        name: `${source.name}.kdbx`, mimeType: 'application/octet-stream', buffer: source.data
    });
    await page.locator('#password').fill(password);
    await page.locator('#unlock').click();
    await expect(page.locator('.entry-row')).toHaveCount(3, { timeout });
}
async function lock(page: Page, touch = false) {
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    await showNavigation(page, touch);
    await activate(navigation(page).getByRole('button', { name: 'Lock', exact: true }), touch);
    await expect(page.locator('#password')).toBeVisible({ timeout });
}
async function openRecent(page: Page, source: Fixture, touch = false) {
    await activate(page.locator('.vault-row').filter({ has: page.getByText(`${source.name}.kdbx`, { exact: true }) }), touch);
    await page.locator('#password').fill(password);
    await activate(page.locator('#unlock'), touch);
    await expect(page.locator('#search')).toBeVisible({ timeout });
}
async function reopen(page: Page, source: Fixture, touch = false) {
    await lock(page, touch);
    await page.reload();
    await openRecent(page, source, touch);
}
async function downloadVault(page: Page, source: Fixture, touch = false) {
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    await showNavigation(page, touch);
    await activate(navigation(page).getByRole('button', { name: 'Settings', exact: true }), touch);
    await activate(page.getByRole('tab', { name: 'Database', exact: true }), touch);
    const form = page.getByRole('form', { name: `Database settings: ${source.name}`, exact: true });
    await expect(form).toBeVisible();
    const pending = page.waitForEvent('download', { timeout });
    await activate(form.getByRole('button', { name: 'Download KDBX', exact: true }), touch);
    const download = await pending;
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toBe(`${source.name}.kdbx`);
    const stream = await download.createReadStream();
    if (!stream) throw new Error('No encrypted download stream');
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    await test.info().attach('downloaded-kdbx', { body: bytes, contentType: 'application/octet-stream' });
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([3, 217, 162, 154, 103, 251, 75, 181]));
    expect(bytes.includes(Buffer.from('Current leaf secret'))).toBe(false);
    const db = await kdbxweb.Kdbx.load(new Uint8Array(bytes).buffer,
        new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password)));
    expect(db.meta.name).toBe(source.name);
    expect(db.groups[0].uuid.id).toBe(source.ids.root);
    expect(db.meta.recycleBinUuid?.id).toBe(source.ids.bin);
    expect(db.meta.recycleBinEnabled).toBe(source.trashEnabled);
    await activate(page.locator('#settings-back:visible, .settings__phone-back:visible'), touch);
    return db;
}
async function begin(page: Page, source: Fixture, group: string, action: 'New group' | 'Rename group' | 'Delete group', touch = false) {
    const bar = await actionBar(page, group, touch);
    await activate(bar.getByRole('button', { name: action, exact: true }), touch);
    const title = action === 'Delete group'
        ? source.trashEnabled ? 'Move group to trash' : 'Permanently delete group'
        : action;
    const dialog = page.getByRole('dialog', { name: title, exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('aria-modal', 'true');
    await expect(dialog.getByText(`Database: ${source.name}`, { exact: true })).toBeVisible();
    return dialog;
}
async function createGroup(page: Page, source: Fixture, parent: string, name: string, touch = false) {
    const dialog = await begin(page, source, parent, 'New group', touch);
    await expect(dialog.getByText(`Parent group: ${parent}`, { exact: true })).toBeVisible();
    await dialog.getByLabel('Group name', { exact: true }).fill(name);
    await activate(dialog.getByRole('button', { name: 'Create group', exact: true }), touch);
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
}

test.describe('New interface group lifecycle', () => {
    test.setTimeout(120_000);

    for (const touch of [false, true]) {
        test.describe(touch ? '320px touch' : 'desktop', () => {
            test.use(touch ? { hasTouch: true, viewport: { width: 320, height: 740 } } : { viewport: { width: 1280, height: 800 } });

            test('creates nested groups, cancels and commits rename, and preserves encrypted data after reopen', async ({ page }) => {
                const source = await fixture();
                await openFixture(page, source);
                await chooseGroup(page, ['Parent'], touch);
                let dialog = await begin(page, source, 'Parent', 'New group', touch);
                await dialog.getByLabel('Group name', { exact: true }).fill('Canceled creation');
                await activate(dialog.getByRole('button', { name: 'Cancel', exact: true }), touch);
                await expect(dialog).toHaveCount(0);
                await createGroup(page, source, 'Parent', 'New child', touch);
                await chooseGroup(page, ['Parent', 'New child'], touch);
                const nestedName = touch ? 'Nested-'.repeat(12) : 'New grandchild';
                await createGroup(page, source, 'New child', nestedName, touch);
                const created = await downloadVault(page, source, touch);
                expect(groups(created).some((group) => group.name === 'Canceled creation')).toBe(false);
                const newChild = requireGroup(created, source.ids.parent).groups.find((group) => group.name === 'New child');
                expect(newChild).toBeDefined();
                expect(newChild!.groups.map((group) => group.name)).toEqual([nestedName]);
                const nestedId = newChild!.groups[0].uuid.id;
                await chooseGroup(page, ['Parent', 'New child', nestedName], touch);
                dialog = await begin(page, source, nestedName, 'Rename group', touch);
                const input = dialog.getByLabel('Group name', { exact: true });
                await expect(input).toHaveValue(nestedName);
                await input.fill('Canceled rename');
                await activate(dialog.getByRole('button', { name: 'Cancel', exact: true }), touch);
                dialog = await begin(page, source, nestedName, 'Rename group', touch);
                await dialog.getByLabel('Group name', { exact: true }).fill('   ');
                await activate(dialog.getByRole('button', { name: 'Save name', exact: true }), touch);
                await expect(dialog.getByRole('alert')).toHaveText('Enter a group name between 1 and 1024 characters.');
                await dialog.getByLabel('Group name', { exact: true }).fill('  Renamed nested group  ');
                if (touch) {
                    const bounds = await dialog.boundingBox();
                    expect(bounds).not.toBeNull();
                    expect(bounds!.x).toBeGreaterThanOrEqual(0);
                    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(321);
                    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
                }
                await screenshot(page, touch ? 'group-rename-320' : 'group-rename-desktop');
                await activate(dialog.getByRole('button', { name: 'Save name', exact: true }), touch);
                await expect(dialog).toHaveCount(0);
                await reopen(page, source, touch);
                await chooseGroup(page, ['Parent', 'New child', 'Renamed nested group'], touch);
                const saved = await downloadVault(page, source, touch);
                expect(requireGroup(saved, nestedId).name).toBe('Renamed nested group');
                expect(requireGroup(saved, nestedId).parentGroup?.uuid.id).toBe(newChild!.uuid.id);
                expect(requireGroup(saved, newChild!.uuid.id).parentGroup?.uuid.id).toBe(source.ids.parent);
                expect(groups(saved)).toHaveLength(groups(created).length);
                expect(groups(saved).some((group) => group.name === 'Canceled rename')).toBe(false);
                expectSeedEntries(saved, source);
                await screenshot(page, touch ? 'group-reopened-320' : 'group-reopened-desktop');

                if (touch) {
                    // Destructive controls must be reachable without hover or a drag gesture.
                    await chooseGroup(page, ['Parent', 'New child'], true);
                    dialog = await begin(page, source, 'New child', 'Delete group', true);
                    await activate(dialog.getByRole('button', { name: 'Cancel', exact: true }), true);
                    dialog = await begin(page, source, 'New child', 'Delete group', true);
                    await screenshot(page, 'group-trash-confirmation-320');
                    await activate(dialog.getByRole('button', { name: 'Move to trash', exact: true }), true);
                    await expect(dialog).toHaveCount(0);
                    await reopen(page, source, true);
                    const trashed = await downloadVault(page, source, true);
                    expect(requireGroup(trashed, newChild!.uuid.id).parentGroup?.uuid.id).toBe(source.ids.bin);
                    expect(requireGroup(trashed, nestedId).parentGroup?.uuid.id).toBe(newChild!.uuid.id);
                    expectSeedEntries(trashed, source);
                }
            });
        });
    }

    test('canceling group trash is inert; confirmation moves all descendants with identities and contents intact', async ({ page }) => {
        const source = await fixture();
        await openFixture(page, source);
        await chooseGroup(page, ['Parent']);
        let dialog = await begin(page, source, 'Parent', 'Delete group');
        await expect(dialog.getByText('Move “Parent” and all its subgroups and entries to trash?', { exact: true })).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
        await activate(dialog.getByRole('button', { name: 'Cancel', exact: true }));
        await expect(dialog).toHaveCount(0);
        const canceled = await downloadVault(page, source);
        expect(requireGroup(canceled, source.ids.parent).parentGroup?.uuid.id).toBe(source.ids.root);
        expect(canceled.deletedObjects).toHaveLength(0);
        expectSeedEntries(canceled, source);
        dialog = await begin(page, source, 'Parent', 'Delete group');
        await screenshot(page, 'group-cascade-trash-confirmation');
        await activate(dialog.getByRole('button', { name: 'Move to trash', exact: true }));
        await expect(dialog).toHaveCount(0);
        await chooseGroup(page, ['All items']);
        await expect(page.locator('.entry-row')).toHaveCount(1);
        await expect(entryRow(page, 'Unchanged sibling account')).toBeVisible();
        await expect(navigation(page).getByRole('button', { name: 'Parent', exact: true })).toHaveCount(0);
        await chooseGroup(page, ['Trash']);
        await expect(page.locator('.entry-row')).toHaveCount(2);
        await expect(entryRow(page, 'Parent account')).toBeVisible();
        await expect(entryRow(page, 'Leaf account')).toBeVisible();
        await screenshot(page, 'group-cascade-trash-entries');
        await reopen(page, source);
        await chooseGroup(page, ['Trash']);
        await expect(page.locator('.entry-row')).toHaveCount(2);
        const saved = await downloadVault(page, source);
        expect(requireGroup(saved, source.ids.parent).parentGroup?.uuid.id).toBe(source.ids.bin);
        expect(requireGroup(saved, source.ids.sibling).parentGroup?.uuid.id).toBe(source.ids.root);
        expect(saved.deletedObjects).toHaveLength(0);
        expectSeedEntries(saved, source);
    });

    test('trash-disabled deletion requires confirmation; cancel and Escape preserve data, confirm creates cascade tombstones', async ({ page }) => {
        const source = await fixture('Permanent groups', false);
        await openFixture(page, source);
        await chooseGroup(page, ['Parent']);
        let dialog = await begin(page, source, 'Parent', 'Delete group');
        await expect(dialog).toContainText('Trash is unavailable for this database. This cannot be undone.');
        await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
        await expect(actions(page, 'Parent').getByRole('button', { name: 'Delete group', exact: true })).toBeFocused();
        dialog = await begin(page, source, 'Parent', 'Delete group');
        await activate(dialog.getByRole('button', { name: 'Cancel', exact: true }));
        await expect(dialog).toHaveCount(0);
        await reopen(page, source);
        const canceled = await downloadVault(page, source);
        expect(requireGroup(canceled, source.ids.parent).parentGroup?.uuid.id).toBe(source.ids.root);
        expect(canceled.deletedObjects).toHaveLength(0);
        expectSeedEntries(canceled, source);
        await chooseGroup(page, ['Parent']);
        dialog = await begin(page, source, 'Parent', 'Delete group');
        await screenshot(page, 'group-permanent-delete-confirmation');
        await activate(dialog.getByRole('button', { name: 'Delete permanently', exact: true }));
        await expect(dialog).toHaveCount(0);
        await chooseGroup(page, ['All items']);
        await expect(page.locator('.entry-row')).toHaveCount(1);
        await chooseGroup(page, ['Trash']);
        await expect(page.locator('.entry-row')).toHaveCount(0);
        await reopen(page, source);
        const saved = await downloadVault(page, source);
        const removed = [source.ids.parent, source.ids.child, source.ids.leaf, source.ids.parentEntry, source.ids.leafEntry];
        expect(saved.deletedObjects.map((object) => object.uuid?.id).sort()).toEqual([...removed].sort());
        for (const id of [source.ids.parent, source.ids.child, source.ids.leaf]) expect(saved.getGroup(id)).toBeUndefined();
        expect(allEntries(saved).map((entry) => entry.uuid.id)).toEqual([source.ids.siblingEntry]);
        expect(text(allEntries(saved)[0], 'Password')).toBe('Unchanged sibling account secret');
        expect(requireGroup(saved, source.ids.bin).groups).toHaveLength(0);
        expect(requireGroup(saved, source.ids.bin).entries).toHaveLength(0);
    });

    test('database root and recycle bin cannot be renamed or deleted through group actions', async ({ page }) => {
        const source = await fixture();
        await openFixture(page, source);
        await chooseGroup(page, ['All items']);
        await openManager(page);
        // The wrapping label contains option text; use the combobox's accessible
        // name (confirmed by the failure snapshot), not its full label text.
        const rootChoice = page.getByRole('combobox', { name: 'Choose a vault root', exact: true });
        await expect(rootChoice).toHaveValue('');
        await expect(page.getByRole('group', { name: /^Group actions: / })).toHaveCount(0);
        await rootChoice.selectOption({ label: `${source.name}.kdbx (vault 1) — root 1: ${source.name}` });
        const root = await actionBar(page, source.name);
        await expect(root.getByRole('button', { name: 'New group', exact: true })).toBeEnabled();
        for (const action of ['Rename group', 'Delete group']) {
            await expect(root.getByRole('button', { name: action, exact: true })).toBeDisabled();
            await expect(root.getByRole('button', { name: action, exact: true })).toHaveAttribute('title', 'The database root cannot be renamed or deleted here.');
        }
        await screenshot(page, 'group-root-protected');
        await chooseGroup(page, ['Trash']);
        await openManager(page);
        // The bin is deliberately hidden by GroupModel. Trash may omit actions or
        // render disabled ones, but must not expose an enabled root action fallback.
        await expect(page.getByRole('group', { name: /^Group actions: / }).locator('button:enabled')).toHaveCount(0);
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await screenshot(page, 'group-recycle-bin-protected');
        await reopen(page, source);
        const saved = await downloadVault(page, source);
        expect(saved.groups[0].name).toBe(source.name);
        expect(requireGroup(saved, source.ids.bin).parentGroup?.uuid.id).toBe(source.ids.root);
        expect(groups(saved)).toHaveLength(6);
        expect(saved.deletedObjects).toHaveLength(0);
        expectSeedEntries(saved, source);
    });

    test('a group containing the configured recycle bin is protected from cascade deletion', async ({ page }) => {
        const source = await fixture('Nested bin vault', true, true);
        await openFixture(page, source);
        await chooseGroup(page, ['Bin container']);
        const bar = await actionBar(page, 'Bin container');
        await expect(bar.getByRole('button', { name: 'Delete group', exact: true })).toBeDisabled();
        await expect(bar.getByRole('button', { name: 'Delete group', exact: true })).toHaveAttribute('title', 'A group containing the recycle bin cannot be deleted here.');
        await expect(bar.getByRole('button', { name: 'New group', exact: true })).toBeEnabled();
        await screenshot(page, 'group-containing-recycle-bin-protected');
        await reopen(page, source);
        const saved = await downloadVault(page, source);
        expect(requireGroup(saved, source.ids.bin).parentGroup?.name).toBe('Bin container');
        expect(saved.deletedObjects).toHaveLength(0);
        expectSeedEntries(saved, source);
    });

    test('identically named groups mutate only the selected recent database', async ({ page }) => {
        // New currently has no visible add-second-unlocked-vault route. Exercise
        // two independently cached files without manufacturing model.files state.
        // This is NOT simultaneous multi-vault coverage; add that once reachable.
        const first = await fixture('First group vault');
        const second = await fixture('Second group vault');
        await openFixture(page, first);
        await lock(page);
        await openFixture(page, second);
        await lock(page);
        await page.reload();
        await openRecent(page, first);
        await chooseGroup(page, ['Parent']);
        await createGroup(page, first, 'Parent', 'First-only child');
        await lock(page);
        await openRecent(page, second);
        await chooseGroup(page, ['Parent']);
        await createGroup(page, second, 'Parent', 'Second-only child');
        let saved = await downloadVault(page, second);
        expect(requireGroup(saved, second.ids.parent).groups.map((group) => group.name)).toEqual(['Child', 'Second-only child']);
        expect(groups(saved).some((group) => group.name === 'First-only child')).toBe(false);
        expectSeedEntries(saved, second);
        await lock(page);
        await page.reload();
        await openRecent(page, first);
        saved = await downloadVault(page, first);
        expect(requireGroup(saved, first.ids.parent).groups.map((group) => group.name)).toEqual(['Child', 'First-only child']);
        expect(groups(saved).some((group) => group.name === 'Second-only child')).toBe(false);
        expectSeedEntries(saved, first);
        await screenshot(page, 'group-selected-database-fidelity');
    });
});

async function organize(page: Page, group: string, action: string, touch = false) {
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    await openManager(page, touch);
    await activate(page.getByRole('group', { name: `Organize group: ${group}`, exact: true })
        .getByRole('button', { name: action, exact: true }), touch);
    const dialog = page.getByRole('dialog', { name: action, exact: true });
    await expect(dialog).toBeVisible();
    return dialog;
}
async function trashManager(page: Page, touch = false) {
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
    await showNavigation(page, touch);
    await activate(navigation(page).getByRole('button', { name: 'Trash', exact: true }), touch);
    const details = page.locator('details').filter({ has: page.locator('summary', { hasText: /^Manage trash$/ }) });
    if (await details.getAttribute('open') === null) await activate(details.locator('summary'), touch);
    return details;
}
async function chooseOptionBySuffix(select: Locator, suffix: string) {
    const values = await select.locator('option').evaluateAll((options, suffix) => options
        .filter(option => option.textContent?.trim().endsWith(suffix)).map(option => (option as HTMLOptionElement).value), suffix);
    expect(values).toHaveLength(1);
    await select.selectOption(values[0]);
}

test.describe('New group organization and trash recovery', () => {
    test.setTimeout(120_000);
    for (const touch of [false, true]) {
        test.describe(touch ? '320px touch' : 'desktop', () => {
            test.use(touch ? { hasTouch: true, viewport: { width: 320, height: 740 } } : { viewport: { width: 1280, height: 800 } });

            test('moves a populated subtree, rejects cycle choices, reorders and preserves encrypted identity', async ({ page }) => {
                const source = await fixture(); await openFixture(page, source);
                await chooseGroup(page, ['Parent'], touch);
                let dialog = await organize(page, 'Parent', 'Move group', touch);
                const options = await dialog.getByRole('combobox', { name: 'Destination group', exact: true }).locator('option').allTextContents();
                expect(options.some(value => /Parent|Child|Leaf|Recycle Bin/.test(value))).toBe(false);
                await chooseOptionBySuffix(dialog.getByRole('combobox', { name: 'Destination group', exact: true }), 'Sibling');
                await activate(dialog.getByRole('button', { name: 'Cancel', exact: true }), touch);
                expect(requireGroup(await downloadVault(page, source, touch), source.ids.parent).parentGroup?.uuid.id).toBe(source.ids.root);
                dialog = await organize(page, 'Parent', 'Move group', touch);
                await chooseOptionBySuffix(dialog.getByRole('combobox', { name: 'Destination group', exact: true }), 'Sibling');
                await screenshot(page, 'move-group-destination');
                await activate(dialog.getByRole('button', { name: 'Move', exact: true }), touch);
                await reopen(page, source, touch);
                let saved = await downloadVault(page, source, touch);
                expect(requireGroup(saved, source.ids.parent).parentGroup?.uuid.id).toBe(source.ids.sibling);
                expectSeedEntries(saved, source);
                await chooseGroup(page, ['Sibling', 'Parent'], touch);
                dialog = await organize(page, 'Parent', 'Move group', touch);
                await chooseOptionBySuffix(dialog.getByRole('combobox', { name: 'Destination group', exact: true }), source.name);
                await chooseOptionBySuffix(dialog.getByRole('combobox', { name: 'Position', exact: true }), 'Sibling');
                await activate(dialog.getByRole('button', { name: 'Move', exact: true }), touch);
                saved = await downloadVault(page, source, touch);
                expect(saved.groups[0].groups.filter(group => group.uuid.id !== source.ids.bin).map(group => group.uuid.id))
                    .toEqual([source.ids.parent, source.ids.sibling]);
                dialog = await organize(page, 'Parent', 'Move group', touch);
                await activate(dialog.getByRole('button', { name: 'Move', exact: true }), touch);
                await reopen(page, source, touch);
                saved = await downloadVault(page, source, touch);
                expect(saved.groups[0].groups.filter(group => group.uuid.id !== source.ids.bin).map(group => group.uuid.id))
                    .toEqual([source.ids.sibling, source.ids.parent]);
                expectSeedEntries(saved, source);
                expect(saved.deletedObjects).toHaveLength(0);
            });

            test('search exclusion inherits and explicit child inclusion survives encrypted reopen', async ({ page }) => {
                const source = await fixture(); await openFixture(page, source);
                await chooseGroup(page, ['Parent', 'Child'], touch);
                let dialog = await organize(page, 'Child', 'Group search settings', touch);
                await dialog.getByRole('combobox', { name: 'Global search', exact: true }).selectOption('true');
                await activate(dialog.getByRole('button', { name: 'Save search settings', exact: true }), touch);
                await expect(dialog).toHaveCount(0);
                await chooseGroup(page, ['Parent'], touch);
                dialog = await organize(page, 'Parent', 'Group search settings', touch);
                await dialog.getByRole('combobox', { name: 'Global search', exact: true }).selectOption('false');
                await activate(dialog.getByRole('button', { name: 'Save search settings', exact: true }), touch);
                await expect(dialog).toHaveCount(0);
                // Explicitly selected excluded groups still expose their own entries.
                await expect(entryRow(page, 'Parent account')).toBeVisible();
                await showNavigation(page, touch);
                await activate(navigation(page).getByRole('button', { name: 'All items', exact: true }), touch);
                await expect(entryRow(page, 'Parent account')).toHaveCount(0);
                // Seed Child explicitly overrides its excluded parent.
                await expect(entryRow(page, 'Leaf account')).toBeVisible();
                await chooseGroup(page, ['Parent', 'Child'], touch);
                dialog = await organize(page, 'Child', 'Group search settings', touch);
                await dialog.getByRole('combobox', { name: 'Global search', exact: true }).selectOption('inherit');
                await activate(dialog.getByRole('button', { name: 'Save search settings', exact: true }), touch);
                await expect(dialog).toHaveCount(0);
                await showNavigation(page, touch);
                await activate(navigation(page).getByRole('button', { name: 'All items', exact: true }), touch);
                await page.locator('#search').fill('Leaf');
                await expect(page.locator('.entry-row')).toHaveCount(0);
                await page.locator('#search').fill('');
                await chooseGroup(page, ['Parent', 'Child', 'Leaf'], touch);
                await expect(entryRow(page, 'Leaf account')).toBeVisible();
                await chooseGroup(page, ['Parent', 'Child'], touch);
                dialog = await organize(page, 'Child', 'Group search settings', touch);
                await dialog.getByRole('combobox', { name: 'Global search', exact: true }).selectOption('true');
                await activate(dialog.getByRole('button', { name: 'Save search settings', exact: true }), touch);
                await expect(dialog).toHaveCount(0);
                await reopen(page, source, touch);
                await page.locator('#search').fill('account');
                await expect(entryRow(page, 'Parent account')).toHaveCount(0);
                await expect(entryRow(page, 'Leaf account')).toBeVisible();
                const saved = await downloadVault(page, source, touch);
                expect(requireGroup(saved, source.ids.parent).enableSearching).toBe(false);
                expectSeedEntries(saved, source);
            });

            test('restores whole trash hierarchy and an empty group; purge and empty trash require confirmation', async ({ page }) => {
                const source = await fixture(); await openFixture(page, source);
                await chooseGroup(page, ['Parent'], touch);
                await createGroup(page, source, 'Parent', 'Empty recoverable', touch);
                await chooseGroup(page, ['Parent'], touch);
                let dialog = await begin(page, source, 'Parent', 'Delete group', touch);
                await activate(dialog.getByRole('button', { name: 'Move to trash', exact: true }), touch);
                let manager = await trashManager(page, touch);
                await chooseOptionBySuffix(manager.getByRole('combobox', { name: 'Trashed group', exact: true }), 'Parent');
                await activate(manager.getByRole('button', { name: 'Restore group', exact: true }), touch);
                dialog = page.getByRole('dialog', { name: 'Restore group', exact: true });
                await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
                await chooseOptionBySuffix(dialog.getByRole('combobox', { name: 'Destination group', exact: true }), 'Sibling');
                await activate(dialog.getByRole('button', { name: 'Cancel', exact: true }), touch);
                await activate(manager.getByRole('button', { name: 'Restore group', exact: true }), touch);
                await chooseOptionBySuffix(dialog.getByRole('combobox', { name: 'Destination group', exact: true }), 'Sibling');
                await screenshot(page, 'restore-group-hierarchy');
                await activate(dialog.getByRole('button', { name: 'Restore', exact: true }), touch);
                await reopen(page, source, touch);
                let saved = await downloadVault(page, source, touch);
                expect(requireGroup(saved, source.ids.parent).parentGroup?.uuid.id).toBe(source.ids.sibling);
                expectSeedEntries(saved, source);
                await chooseGroup(page, ['Sibling', 'Parent'], touch);
                dialog = await begin(page, source, 'Parent', 'Delete group', touch);
                await activate(dialog.getByRole('button', { name: 'Move to trash', exact: true }), touch);
                manager = await trashManager(page, touch);
                await chooseOptionBySuffix(manager.getByRole('combobox', { name: 'Trashed group', exact: true }), 'Empty recoverable');
                await activate(manager.getByRole('button', { name: 'Restore group', exact: true }), touch);
                dialog = page.getByRole('dialog', { name: 'Restore group', exact: true });
                await expect(dialog).toContainText('vault root is suggested');
                await activate(dialog.getByRole('button', { name: 'Restore', exact: true }), touch);
                await showNavigation(page, touch);
                await expect(navigation(page).getByRole('button', { name: 'Empty recoverable', exact: true })).toHaveCount(1);
                manager = await trashManager(page, touch);
                await chooseOptionBySuffix(manager.getByRole('combobox', { name: 'Trashed group', exact: true }), 'Child');
                await activate(manager.getByRole('button', { name: 'Permanently delete group', exact: true }), touch);
                dialog = page.getByRole('dialog', { name: 'Permanently delete group', exact: true });
                await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
                await activate(dialog.getByRole('button', { name: 'Cancel', exact: true }), touch);
                await activate(manager.getByRole('button', { name: 'Permanently delete group', exact: true }), touch);
                await activate(dialog.getByRole('button', { name: 'Delete permanently', exact: true }), touch);
                saved = await downloadVault(page, source, touch);
                for (const id of [source.ids.child, source.ids.leaf, source.ids.leafEntry]) {
                    expect(saved.deletedObjects.some(item => item.uuid.id === id)).toBe(true);
                }
                expect(requireGroup(saved, source.ids.parent).entries).toHaveLength(1);
                manager = await trashManager(page, touch);
                await activate(manager.getByRole('button', { name: 'Empty trash…', exact: true }), touch);
                dialog = page.getByRole('dialog', { name: 'Empty trash', exact: true });
                await expect(dialog).toContainText(`${source.name}: 1 groups, 1 entries`);
                await activate(dialog.getByRole('button', { name: 'Cancel', exact: true }), touch);
                await activate(manager.getByRole('button', { name: 'Empty trash…', exact: true }), touch);
                await screenshot(page, 'empty-trash-confirmation');
                await activate(dialog.getByRole('button', { name: 'Empty trash', exact: true }), touch);
                await reopen(page, source, touch);
                saved = await downloadVault(page, source, touch);
                expect(requireGroup(saved, source.ids.bin).groups).toHaveLength(0);
                expect(requireGroup(saved, source.ids.bin).entries).toHaveLength(0);
                expect(saved.deletedObjects.map(item => item.uuid.id).sort()).toEqual([
                    source.ids.parent, source.ids.parentEntry, source.ids.child, source.ids.leaf, source.ids.leafEntry
                ].sort());
                expect(allEntries(saved).map(entry => entry.uuid.id)).toEqual([source.ids.siblingEntry]);
                expect(groups(saved).some(group => group.name === 'Empty recoverable')).toBe(true);
                manager = await trashManager(page, touch);
                await expect(manager.getByRole('button', { name: 'Empty trash…', exact: true })).toBeDisabled();
            });

            test('global tag rename validates collisions and removal retains entries after reopen', async ({ page }) => {
                const source = await fixture(); await openFixture(page, source);
                await showNavigation(page, touch);
                await activate(navigation(page).getByRole('button', { name: 'group-fidelity', exact: true }), touch);
                let bar = page.getByRole('group', { name: 'Tag actions: group-fidelity', exact: true });
                await activate(bar.getByRole('button', { name: 'Rename tag', exact: true }), touch);
                let dialog = page.getByRole('dialog', { name: 'Rename tag', exact: true });
                await dialog.getByLabel('Tag name', { exact: true }).fill('bad;tag');
                await activate(dialog.getByRole('button', { name: 'Rename tag', exact: true }), touch);
                await expect(dialog.getByRole('alert')).toContainText('without commas');
                await dialog.getByLabel('Tag name', { exact: true }).fill('GROUP-FIDELITY');
                await activate(dialog.getByRole('button', { name: 'Rename tag', exact: true }), touch);
                await expect(dialog.getByRole('alert')).toContainText('already exists');
                await dialog.getByLabel('Tag name', { exact: true }).fill('Renamed tag');
                await activate(dialog.getByRole('button', { name: 'Rename tag', exact: true }), touch);
                await reopen(page, source, touch);
                let saved = await downloadVault(page, source, touch);
                expect(allEntries(saved).every(entry => entry.tags.join() === 'Renamed tag')).toBe(true);
                await showNavigation(page, touch);
                await activate(navigation(page).getByRole('button', { name: 'Renamed tag', exact: true }), touch);
                bar = page.getByRole('group', { name: 'Tag actions: Renamed tag', exact: true });
                await activate(bar.getByRole('button', { name: 'Remove tag', exact: true }), touch);
                dialog = page.getByRole('dialog', { name: 'Remove tag', exact: true });
                await activate(dialog.getByRole('button', { name: 'Cancel', exact: true }), touch);
                await expect(page.locator('.entry-row')).toHaveCount(3);
                await activate(bar.getByRole('button', { name: 'Remove tag', exact: true }), touch);
                await activate(dialog.getByRole('button', { name: 'Remove tag', exact: true }), touch);
                await reopen(page, source, touch);
                saved = await downloadVault(page, source, touch);
                expect(allEntries(saved).every(entry => entry.tags.length === 0)).toBe(true);
                expect(allEntries(saved).map(entry => entry.uuid.id).sort()).toEqual([source.ids.parentEntry, source.ids.leafEntry, source.ids.siblingEntry].sort());
                expect(saved.deletedObjects).toHaveLength(0);
            });
        });
    }
});

async function groupPeer(source: Fixture) {
    let data = source.data;
    let revision = Date.UTC(2026, 10, 13);
    let writes = 0;
    const replace = (bytes: Buffer) => { data = Buffer.from(bytes); revision += 1000; };
    const server = createServer(async (req, res) => {
        res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.setHeader('Access-Control-Allow-Methods', 'OPTIONS, GET, HEAD, PUT');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Cache-Control, Content-Type, If-Match, If-None-Match');
        res.setHeader('Access-Control-Expose-Headers', 'Last-Modified, ETag');
        res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
        if (req.method === 'PUT') {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(Buffer.from(chunk));
            replace(Buffer.concat(chunks)); ++writes;
            res.writeHead(200).end(); return;
        }
        res.setHeader('Last-Modified', new Date(revision).toUTCString());
        res.setHeader('ETag', `"${revision}"`);
        res.writeHead(200).end(req.method === 'GET' ? data : undefined);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/groups.kdbx`,
        replace, bytes: () => data, writes: () => writes,
        async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    };
}

for (const action of ['Move group', 'Restore group', 'Permanently delete group', 'Empty trash']) {
    test(`group lifecycle rejects stale ${action} after encrypted remote revision`, async ({ page }) => {
        test.setTimeout(120_000);
        const source = await fixture();
        if (action !== 'Move group') {
            const db = await kdbxweb.Kdbx.load(new Uint8Array(source.data).buffer, new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password)));
            db.remove(db.getGroup(source.ids.parent)!);
            source.data = Buffer.from(await db.save());
        }
        const dav = await groupPeer(source);
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
            await page.locator('#webdav-pass').fill('disposable');
            await page.locator('#webdav-next').click();
            await page.locator('#password').fill(password); await page.locator('#unlock').click();
            await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
            if (action === 'Move group') {
                await chooseGroup(page, ['Parent']);
                const dialog = await organize(page, 'Parent', action);
                await chooseOptionBySuffix(dialog.getByRole('combobox', { name: 'Destination group', exact: true }), 'Sibling');
            } else {
                const manager = await trashManager(page);
                if (action === 'Empty trash') await manager.getByRole('button', { name: 'Empty trash…', exact: true }).click();
                else {
                    await chooseOptionBySuffix(manager.getByRole('combobox', { name: 'Trashed group', exact: true }), 'Parent');
                    await manager.getByRole('button', { name: action, exact: true }).click();
                }
            }
            const remote = await kdbxweb.Kdbx.load(new Uint8Array(dav.bytes()).buffer, new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password)));
            if (action === 'Move group') remote.move(remote.getGroup(source.ids.sibling)!, null);
            else if (action === 'Empty trash') remote.createEntry(remote.getGroup(source.ids.bin)!).fields.set('Title', 'New remote trash');
            else remote.move(remote.getGroup(source.ids.parent)!, remote.groups[0]);
            dav.replace(Buffer.from(await remote.save()));
            await page.clock.fastForward(61_000);
            if (action === 'Move group') await expect(navigation(page).getByRole('button', { name: 'Sibling', exact: true })).toHaveCount(0, { timeout });
            else if (action === 'Empty trash') await expect(entryRow(page, 'New remote trash')).toHaveCount(1, { timeout });
            else await expect(navigation(page).getByRole('button', { name: 'Parent', exact: true })).toHaveCount(1, { timeout });
            await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout });
            const dialog = page.getByRole('dialog', { name: action, exact: true });
            if (action === 'Move group' || action === 'Empty trash') {
                await dialog.getByRole('button', { name: action === 'Move group' ? 'Move' : 'Empty trash', exact: true }).click();
                await expect(dialog.getByRole('alert')).toContainText('changed');
            } else await expect(dialog).toHaveCount(0);
            await screenshot(page, `stale-${action.replaceAll(' ', '-')}`);
            const latest = await kdbxweb.Kdbx.load(new Uint8Array(dav.bytes()).buffer, new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password)));
            expect(latest.getGroup(source.ids.parent)).toBeDefined();
            if (action === 'Move group' || action === 'Restore group' || action === 'Permanently delete group') {
                expect(latest.getGroup(source.ids.parent)?.parentGroup?.uuid.id).toBe(source.ids.root);
            } else expect(allEntries(latest).some(entry => text(entry, 'Title') === 'New remote trash')).toBe(true);
        } finally { await dav.close(); }
    });
}

test('group move preserves drafts on cancel and declined discard; closed confirmation cannot mutate', async ({ page }) => {
    test.setTimeout(120_000);
    const source = await fixture(); await openFixture(page, source);
    await chooseGroup(page, ['Parent']); await openManager(page);
    await entryRow(page, 'Parent account').click();
    const notes = page.getByRole('region', { name: 'Notes', exact: true });
    await notes.getByRole('button', { name: 'Edit notes', exact: true }).click();
    await notes.getByRole('textbox').fill('Unapplied group draft');
    const trigger = page.getByRole('group', { name: 'Organize group: Parent', exact: true }).getByRole('button', { name: 'Move group', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Move group', exact: true });
    await chooseOptionBySuffix(dialog.getByRole('combobox', { name: 'Destination group', exact: true }), 'Sibling');
    const move = dialog.getByRole('button', { name: 'Move', exact: true });
    await move.evaluate(button => { button.closest('dialog')!.close(); (button as HTMLButtonElement).click(); });
    const retained = page.locator('dialog[aria-label="Move group"]');
    await retained.evaluate(element => (element as HTMLDialogElement).showModal());
    page.once('dialog', prompt => prompt.dismiss()); await move.click();
    await expect(notes.getByRole('textbox')).toHaveValue('Unapplied group draft');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(notes.getByRole('textbox')).toHaveValue('Unapplied group draft');
    await trigger.click();
    await chooseOptionBySuffix(dialog.getByRole('combobox', { name: 'Destination group', exact: true }), 'Sibling');
    page.once('dialog', prompt => prompt.accept()); await move.click();
    const saved = await downloadVault(page, source);
    expect(saved.getGroup(source.ids.parent)?.parentGroup?.uuid.id).toBe(source.ids.sibling);
    expect(text(allEntries(saved).find(entry => entry.uuid.id === source.ids.parentEntry)!, 'Notes')).not.toBe('Unapplied group draft');
    expectSeedEntries(saved, source);
});

test('group action cannot cross lock recovery or apply a retained hidden confirmation', async ({ page }) => {
    test.setTimeout(120_000);
    const source = await fixture();
    await page.clock.install();
    await page.goto('/index.html?ui=classic');
    await page.locator('#open__icon-more').click(); await page.locator('#open__icon-settings').click();
    await page.locator('#settings__general-auto-save-interval').selectOption('0'); await page.clock.runFor(100);
    await openFixture(page, source);
    await page.locator('#open-settings').click(); await page.getByRole('tab', { name: 'Security', exact: true }).click();
    await page.locator('#setting-auto-lock').selectOption('5'); await page.locator('#settings-back').click();
    await chooseGroup(page, ['Parent']); await openManager(page); await entryRow(page, 'Parent account').click();
    const notes = page.getByRole('region', { name: 'Notes', exact: true });
    await notes.getByRole('button', { name: 'Edit notes', exact: true }).click(); await notes.getByRole('textbox').fill('Saved during lock');
    await page.getByRole('group', { name: 'Organize group: Parent', exact: true }).getByRole('button', { name: 'Move group', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Move group', exact: true });
    await chooseOptionBySuffix(dialog.getByRole('combobox', { name: 'Destination group', exact: true }), 'Sibling');
    await page.evaluate(() => {
        const encrypt = SubtleCrypto.prototype.encrypt;
        (window as any).groupGate = { entered: false, completed: false };
        SubtleCrypto.prototype.encrypt = async function (...args) {
            SubtleCrypto.prototype.encrypt = encrypt;
            const released = new Promise<void>(resolve => window.addEventListener('release-group-save', () => resolve(), { once: true }));
            (window as any).groupGate.entered = true; await released;
            const bytes = await encrypt.apply(this, args); (window as any).groupGate.completed = true; return bytes;
        };
    });
    await page.clock.fastForward(6 * 60_000);
    await expect.poll(() => page.evaluate(() => (window as any).groupGate.entered), { timeout }).toBe(true);
    const retained = page.locator('dialog[aria-label="Move group"]');
    await expect(retained).toBeHidden(); await expect(retained).toHaveJSProperty('open', false);
    await retained.getByText('Move', { exact: true }).evaluate(button => (button as HTMLButtonElement).click());
    await page.clock.fastForward(16_000);
    const recovery = page.getByRole('form', { name: `Verify database: ${source.name}`, exact: true });
    await recovery.getByLabel('Master password', { exact: true }).fill(password);
    await recovery.getByLabel('Master password', { exact: true }).press('Enter');
    await page.getByRole('button', { name: 'Return to unsaved changes', exact: true }).click();
    await dialog.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('session changed');
    await page.evaluate(() => window.dispatchEvent(new Event('release-group-save')));
    await expect.poll(() => page.evaluate(() => (window as any).groupGate.completed), { timeout }).toBe(true);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    // Autosave is disabled and the interrupted lock save failed. Explicitly retry
    // saving by locking again, then verify the persisted cache after reload.
    await navigation(page).getByRole('button', { name: 'Lock', exact: true }).click();
    await expect(page.locator('#password')).toBeVisible({ timeout });
    await page.reload(); await openRecent(page, source);
    const saved = await downloadVault(page, source);
    expect(saved.getGroup(source.ids.parent)?.parentGroup?.uuid.id).toBe(source.ids.root);
    expect(text(allEntries(saved).find(entry => entry.uuid.id === source.ids.parentEntry)!, 'Notes')).toBe('Saved during lock');
    expectSeedEntries(saved, source);
    expect(saved.deletedObjects).toHaveLength(0);
});

test('group destination duplicate paths select the exact UUID through encrypted reopen', async ({ page }) => {
    test.setTimeout(120_000);
    const source = await fixture();
    const db = await kdbxweb.Kdbx.load(new Uint8Array(source.data).buffer, new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password)));
    const first = db.createGroup(db.groups[0], 'Twin');
    const second = db.createGroup(db.groups[0], 'Twin');
    source.data = Buffer.from(await db.save());
    await openFixture(page, source); await chooseGroup(page, ['Parent']);
    const dialog = await organize(page, 'Parent', 'Move group');
    const select = dialog.getByRole('combobox', { name: 'Destination group', exact: true });
    await expect(select.locator('option')).toContainText(['Choose a group', source.name, `${source.name} / Sibling`, `${source.name} / Twin (1)`, `${source.name} / Twin (2)`]);
    await chooseOptionBySuffix(select, 'Twin (2)');
    await dialog.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await reopen(page, source);
    const saved = await downloadVault(page, source);
    expect(saved.getGroup(source.ids.parent)?.parentGroup?.uuid.id).toBe(second.uuid.id);
    expect(saved.getGroup(first.uuid)?.groups).toHaveLength(0);
    expectSeedEntries(saved, source);
});
