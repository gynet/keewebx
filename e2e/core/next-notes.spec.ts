import { test, expect } from '@playwright/test';
import path from 'path';

const KDBX4_FILE = path.resolve(__dirname, '../../modules/db/resources/KDBX4.1.kdbx');

test.describe('New interface notes', () => {
    test('renders Markdown through the shared sanitizer and edits the original source', async ({ page }) => {
        await page.goto('/next.html');
        await page.click('#open-demo');
        await page.locator('.entry-row[data-entry="GitHub"]').click();

        const notes = page.getByRole('region', { name: 'Notes', exact: true });
        const markdown = [
            '# Markdown notes',
            '',
            '**Bold** and `code`',
            'second line',
            '',
            '- First item',
            '- Second item',
            '',
            '[Safe link](https://example.com/notes)',
            '[Unsafe link](javascript:window.notesXss=true)',
            '<script>window.notesXss=true</script>',
            '<img src="/missing-notes-image" onerror="window.notesXss=true">',
            '<iframe src="javascript:window.notesXss=true"></iframe>'
        ].join('\n');

        await notes.getByRole('button', { name: 'Edit notes', exact: true }).click();
        await notes.getByRole('textbox', { name: 'Notes', exact: true }).fill(markdown);
        await notes.getByRole('button', { name: 'Save', exact: true }).click();

        const preview = notes.locator('.markdown');
        await expect(preview.getByRole('heading', { name: 'Markdown notes', exact: true })).toBeVisible();
        await expect(preview.locator('strong')).toHaveText('Bold');
        await expect(preview.locator('code')).toHaveText('code');
        await expect(preview.locator('li')).toHaveText(['First item', 'Second item']);
        await expect(preview.locator('br').first()).toBeAttached();
        const safeLink = preview.getByRole('link', { name: 'Safe link', exact: true });
        await expect(safeLink).toHaveAttribute('href', 'https://example.com/notes');
        await expect(safeLink).toHaveAttribute('target', '_blank');
        await expect(safeLink).toHaveAttribute('rel', 'noreferrer noopener');
        await expect(preview.locator('script, iframe, [onerror], a[href^="javascript:"]')).toHaveCount(0);
        expect(await page.evaluate(() => Reflect.get(window, 'notesXss'))).toBeUndefined();

        await notes.getByRole('button', { name: 'Edit notes', exact: true }).click();
        await expect(notes.getByRole('textbox', { name: 'Notes', exact: true })).toHaveValue(markdown);
        await notes.getByRole('button', { name: 'Cancel', exact: true }).click();
    });

    test('discards drafts when switching entries', async ({ page }) => {
        await page.goto('/next.html');
        await page.click('#open-demo');
        await page.locator('.entry-row[data-entry="GitHub"]').click();
        const notes = page.getByRole('region', { name: 'Notes', exact: true });
        await notes.getByRole('button', { name: 'Edit notes', exact: true }).click();
        const editor = notes.getByRole('textbox', { name: 'Notes', exact: true });
        const original = await editor.inputValue();
        await editor.fill('Unsaved draft for GitHub');
        page.once('dialog', (dialog) => dialog.accept());
        await page.locator('.entry-row').filter({ hasNot: page.getByText('GitHub', { exact: true }) }).first().click();
        await expect(editor).toHaveCount(0);
        await page.locator('.entry-row[data-entry="GitHub"]').click();
        await notes.getByRole('button', { name: 'Edit notes', exact: true }).click();
        await expect(editor).toHaveValue(original);
    });

    test('saves local fixture notes, cancels a later edit, and preserves them after lock and reload', async ({ page }) => {
        test.setTimeout(90_000);
        await page.goto('/next.html');
        await page.setInputFiles('#open-file-input', KDBX4_FILE);
        await expect(page.locator('.card__title')).toHaveText('KDBX4.1.kdbx');
        await page.fill('#password', 'test');
        await page.click('#unlock');
        const firstEntry = page.locator('.entry-row').first();
        await expect(firstEntry).toBeVisible({ timeout: 30_000 });
        await firstEntry.click();
        const title = await page.locator('#entry-title').innerText();
        const notes = page.getByRole('region', { name: 'Notes', exact: true });
        const editor = notes.getByRole('textbox', { name: 'Notes', exact: true });
        const markdown = '# Persisted notes\n\n**Saved to the local vault**\nsecond line';

        await notes.getByRole('button', { name: 'Edit notes', exact: true }).click();
        await editor.fill(markdown);
        await notes.getByRole('button', { name: 'Save', exact: true }).click();
        await expect(notes.locator('.markdown h1')).toHaveText('Persisted notes');
        await expect(page.locator('#sync-state')).toHaveText('Up to date', { timeout: 30_000 });

        await notes.getByRole('button', { name: 'Edit notes', exact: true }).click();
        await expect(editor).toHaveValue(markdown);
        await editor.fill('Canceled replacement');
        await notes.getByRole('button', { name: 'Cancel', exact: true }).click();
        await expect(notes.locator('.markdown h1')).toHaveText('Persisted notes');
        await expect(notes).not.toContainText('Canceled replacement');

        await page.click('#lock');
        await expect(page.locator('.vault-row[data-vault="KDBX4.1"]')).toBeVisible({ timeout: 30_000 });
        await expect(page.locator('.entry-row')).toHaveCount(0);
        await page.reload();
        await page.locator('.vault-row[data-vault="KDBX4.1"]').click();
        await page.fill('#password', 'test');
        await page.click('#unlock');
        await expect(firstEntry).toBeVisible({ timeout: 30_000 });
        await firstEntry.click();
        await expect(page.locator('#entry-title')).toHaveText(title);
        await expect(notes.locator('.markdown h1')).toHaveText('Persisted notes');
        await expect(notes.locator('.markdown strong')).toHaveText('Saved to the local vault');
        await notes.getByRole('button', { name: 'Edit notes', exact: true }).click();
        await expect(editor).toHaveValue(markdown);
    });
});
