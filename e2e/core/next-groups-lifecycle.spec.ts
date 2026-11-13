import { test, expect, type Locator, type Page } from '@playwright/test';
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
    if (touch) await control.tap();
    else await control.click();
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
