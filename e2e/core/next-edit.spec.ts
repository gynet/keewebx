import { test, expect, type Locator, type Page } from '@playwright/test';
import path from 'path';

const FIXTURE = path.resolve(__dirname, '../../modules/db/resources/KDBX4.1.kdbx');
const editor = (page: Page) => page.locator('.entry-editor');
const entryRow = (page: Page, title: string) => page.locator('.entry-row').filter({
    has: page.getByText(title, { exact: true })
});

async function openFixture(page: Page): Promise<void> {
    await page.goto('/next.html');
    await page.setInputFiles('#open-file-input', FIXTURE);
    await expect(page.locator('.card__title')).toHaveText('KDBX4.1.kdbx');
    await page.fill('#password', 'test');
    await page.click('#unlock');
    await expect(page.locator('.entry-row').first()).toBeVisible({ timeout: 30_000 });
}

async function lockAndReopen(page: Page): Promise<void> {
    await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout: 30_000 });
    await page.click('#lock');
    await expect(page.locator('.entry-row')).toHaveCount(0, { timeout: 30_000 });
    await page.reload();
    await page.locator('.vault-row[data-vault="KDBX4.1"]').click();
    await page.fill('#password', 'test');
    await page.click('#unlock');
    await expect(page.locator('.entry-row').first()).toBeVisible({ timeout: 30_000 });
}

async function startEdit(page: Page): Promise<Locator> {
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(editor(page)).toBeVisible();
    return editor(page);
}

async function snapshot(form: Locator) {
    return form.locator('input, textarea').evaluateAll((elements) => elements.map((element) => {
        const input = element as HTMLInputElement;
        return { type: input.type, value: input.value, checked: input.type === 'checkbox' && input.checked };
    }));
}

async function addField(form: Locator, name: string, value: string, protectedValue = false): Promise<void> {
    await form.getByRole('button', { name: 'Add field', exact: true }).click();
    const field = form.locator('.entry-editor__custom-row').last();
    await field.getByLabel('Field name', { exact: true }).fill(name);
    await field.getByLabel('Field value', { exact: true }).fill(value);
    await field.getByLabel('Protected', { exact: true }).setChecked(protectedValue);
}

test.describe('New interface entry editing', () => {
    test.setTimeout(120_000);

    test('cancel leaves all fixture fields unchanged after lock and reload', async ({ page }) => {
        await openFixture(page);
        await page.locator('.entry-row').first().click();
        const title = await page.locator('#entry-title').innerText();
        let form = await startEdit(page);
        const original = await snapshot(form);
        for (const label of ['Title', 'Username', 'Password', 'Website', 'Notes', 'Tags']) {
            await form.getByLabel(label, { exact: true }).fill(`Canceled ${label}`);
        }
        const existingCustom = form.locator('.entry-editor__custom-row');
        if (await existingCustom.count()) {
            await existingCustom.first().getByRole('button', { name: 'Remove field', exact: true }).click();
        }
        await addField(form, 'Canceled custom field', 'canceled secret', true);
        await form.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(page.locator('#entry-title')).toHaveText(title);
        form = await startEdit(page);
        expect(await snapshot(form)).toEqual(original);
        await form.getByRole('button', { name: 'Cancel', exact: true }).click();

        await lockAndReopen(page);
        await entryRow(page, title).click();
        form = await startEdit(page);
        expect(await snapshot(form)).toEqual(original);
    });

    test('saves core fields and protected custom fields and preserves them across subsequent edits and reopen', async ({ page }) => {
        await openFixture(page);
        await page.locator('.entry-row').first().click();
        let form = await startEdit(page);
        await form.getByLabel('Title', { exact: true }).fill('Edited fixture entry');
        await form.getByLabel('Username', { exact: true }).fill('edited-user');
        await form.getByLabel('Password', { exact: true }).fill('Saved password !42');
        await form.getByLabel('Website', { exact: true }).fill('https://example.com/edited');
        const markdown = '# Entry notes\n\n**Saved source**\nsecond line';
        await form.getByLabel('Notes', { exact: true }).fill(markdown);
        await form.getByLabel('Tags', { exact: true }).fill('edited, persisted');
        await addField(form, 'Public account', 'visible value');
        await addField(form, 'Private account', 'protected value', true);
        await addField(form, 'Temporary field', 'remove me');
        await form.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(page.locator('#entry-title')).toHaveText('Edited fixture entry');
        await expect(page.locator('[data-field="user"] .field__value')).toHaveText('edited-user');
        await expect(page.locator('[data-field="password"] .field__value')).toHaveText(/•/);
        await expect(page.locator('[data-field="field:Private account"] .field__value')).toHaveText(/•/);
        await expect(page.locator('[data-field="url"] a')).toHaveAttribute('href', 'https://example.com/edited');
        await expect(page.locator('.entry-notes .markdown h1')).toHaveText('Entry notes');
        await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout: 30_000 });

        // Editing unrelated fields must preserve both password and custom-field protection.
        form = await startEdit(page);
        await expect(form.getByLabel('Password', { exact: true })).toHaveValue('Saved password !42');
        await form.getByLabel('Username', { exact: true }).fill('second-user');
        const custom = form.locator('.entry-editor__custom-row');
        for (const field of await custom.all()) {
            const name = await field.getByLabel('Field name', { exact: true }).inputValue();
            if (name === 'Public account') {
                await field.getByLabel('Field name', { exact: true }).fill('Renamed account');
            } else if (name === 'Temporary field') {
                await field.getByRole('button', { name: 'Remove field', exact: true }).click();
            }
        }
        await form.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(page.locator('[data-field="field:Public account"]')).toHaveCount(0);
        await expect(page.locator('[data-field="field:Temporary field"]')).toHaveCount(0);
        await expect(page.locator('[data-field="field:Renamed account"] .field__value')).toHaveText('visible value');

        await lockAndReopen(page);
        await entryRow(page, 'Edited fixture entry').click();
        form = await startEdit(page);
        await expect(form.getByLabel('Username', { exact: true })).toHaveValue('second-user');
        await expect(form.getByLabel('Password', { exact: true })).toHaveValue('Saved password !42');
        await expect(form.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'password');
        await expect(form.getByLabel('Website', { exact: true })).toHaveValue('https://example.com/edited');
        await expect(form.getByLabel('Notes', { exact: true })).toHaveValue(markdown);
        await expect(form.getByLabel('Tags', { exact: true })).toHaveValue('edited, persisted');
        const names = await form.getByLabel('Field name', { exact: true }).evaluateAll((inputs) =>
            inputs.map((input) => (input as HTMLInputElement).value));
        expect(names).toContain('Renamed account');
        expect(names).not.toContain('Public account');
        expect(names).not.toContain('Temporary field');
        const privateField = form.locator('.entry-editor__custom-row').nth(names.indexOf('Private account'));
        await expect(privateField.getByLabel('Field value', { exact: true })).toHaveValue('protected value');
        await expect(privateField.getByLabel('Field value', { exact: true })).toHaveAttribute('type', 'password');
        await expect(privateField.getByLabel('Protected', { exact: true })).toBeChecked();
        await form.getByRole('button', { name: 'Cancel', exact: true }).click();

        // The existing Notes editor still receives the original Markdown source.
        const notes = page.getByRole('region', { name: 'Notes', exact: true });
        await notes.getByRole('button', { name: 'Edit notes', exact: true }).click();
        await expect(notes.getByLabel('Notes', { exact: true })).toHaveValue(markdown);
    });

    test('cancels creation without a blank entry and persists a new entry, trash and restore', async ({ page }) => {
        await openFixture(page);
        const initialCount = await page.locator('.entry-row').count();
        await page.getByRole('button', { name: 'New entry', exact: true }).click();
        await editor(page).getByLabel('Title', { exact: true }).fill('Canceled new entry');
        await editor(page).getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(page.locator('.entry-row')).toHaveCount(initialCount);

        await page.getByRole('button', { name: 'New entry', exact: true }).click();
        let form = editor(page);
        await form.getByLabel('Title', { exact: true }).fill('Created fixture entry');
        await form.getByLabel('Username', { exact: true }).fill('new-user');
        await form.getByLabel('Password', { exact: true }).fill('New protected password');
        await form.getByLabel('Website', { exact: true }).fill('https://example.com/new');
        await form.getByLabel('Notes', { exact: true }).fill('New entry notes');
        await form.getByLabel('Tags', { exact: true }).fill('new-tag');
        await addField(form, 'Recovery key', 'new protected custom value', true);
        await form.getByLabel('Field name', { exact: true }).fill('Password');
        await form.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(form.getByRole('alert')).toContainText('unique names');
        await expect(page.locator('.entry-row')).toHaveCount(initialCount);
        await form.getByLabel('Field name', { exact: true }).fill('Recovery key');
        await form.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(page.locator('#entry-title')).toHaveText('Created fixture entry');
        await expect(page.locator('.entry-row')).toHaveCount(initialCount + 1);

        await lockAndReopen(page);
        await expect(entryRow(page, 'Canceled new entry')).toHaveCount(0);
        await expect(page.locator('.entry-row')).toHaveCount(initialCount + 1);
        await entryRow(page, 'Created fixture entry').click();
        form = await startEdit(page);
        await expect(form.getByLabel('Username', { exact: true })).toHaveValue('new-user');
        await expect(form.getByLabel('Password', { exact: true })).toHaveValue('New protected password');
        await expect(form.getByLabel('Website', { exact: true })).toHaveValue('https://example.com/new');
        await expect(form.getByLabel('Notes', { exact: true })).toHaveValue('New entry notes');
        await expect(form.getByLabel('Tags', { exact: true })).toHaveValue('new-tag');
        await expect(form.getByLabel('Field value', { exact: true })).toHaveValue('new protected custom value');
        await expect(form.getByLabel('Protected', { exact: true })).toBeChecked();
        await form.getByRole('button', { name: 'Cancel', exact: true }).click();
        await page.getByRole('button', { name: 'Move to Trash', exact: true }).click();
        await expect(entryRow(page, 'Created fixture entry')).toHaveCount(0);
        await lockAndReopen(page);
        await expect(entryRow(page, 'Created fixture entry')).toHaveCount(0);
        await page.getByRole('button', { name: 'Trash', exact: true }).click();
        await entryRow(page, 'Created fixture entry').click();
        await page.getByRole('button', { name: 'Restore', exact: true }).click();
        await page.getByRole('dialog', { name: 'Restore entry to group', exact: true })
            .getByRole('button', { name: 'Restore', exact: true }).click();
        await expect(page.locator('#entry-title')).toHaveText('Created fixture entry');
        await expect(page.locator('.entry-row')).toHaveCount(initialCount + 1);
        await lockAndReopen(page);
        await expect(entryRow(page, 'Created fixture entry')).toBeVisible();
        await page.getByRole('button', { name: 'Trash', exact: true }).click();
        await expect(entryRow(page, 'Created fixture entry')).toHaveCount(0);
    });
});
