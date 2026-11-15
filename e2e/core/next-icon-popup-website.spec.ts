import { test as base, expect, type Page } from '@playwright/test';
import { createServer } from 'node:http';
import { open, download, find, png, back } from './presentation-lifecycle-fixture';

const test = base.extend<{ website: { url: string; requests: string[]; missing: boolean } }>({
    website: async ({ page }, use) => {
        const image = await png(page, 'green', 120, 60);
        const website = { url: '', requests: [] as string[], missing: true };
        const server = createServer((request, response) => {
            website.requests.push(request.url!);
            expect(request.headers.referer).toBeUndefined();
            expect(request.headers.cookie).toBeUndefined();
            response.writeHead(website.missing ? 404 : 200, { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' });
            response.end(website.missing ? 'missing' : image);
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        website.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/private/account?secret=omitted`;
        try { await use(website); } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    }
});
async function appearance(page: Page) {
    await page.getByRole('button', { name: 'Change icon and color', exact: true }).click();
    return page.getByRole('dialog', { name: 'Entry appearance', exact: true });
}
// Read-only is a model capability without a UI toggle. Keep the actual component,
// network, draft and persistence paths; only supply that capability to the model.
async function readOnly(page: Page, value: boolean, render = true) {
    await page.evaluate(({ value, render }) => {
        type Node = { props?: { model?: unknown; entry?: { file: { readOnly?: boolean } } }; __k?: Node[]; __e?: Element; __c?: { forceUpdate(): void } };
        const visit = (node?: Node): Node | undefined => {
            if (node?.props?.model && node.props.entry && node.__c && node.__e?.classList?.contains('entry-icon-trigger')) return node;
            for (const child of node?.__k ?? []) { const found = visit(child); if (found) return found; }
        };
        const node = visit((document.querySelector('#root') as Element & { __k?: Node }).__k);
        if (!node?.props?.entry) throw new Error('Mounted entry component not found');
        Object.defineProperty(node.props.entry.file, 'readOnly', { value, writable: true, configurable: true });
        if (render) node.__c!.forceUpdate();
    }, { value, render });
}
for (const width of [390, 1280]) test(`website icon belongs to appearance, retries and cancels its draft at ${width}px`, async ({ page, website }) => {
    await page.setViewportSize({ width, height: 844 });
    const source = await open(page, true, website.url); await page.locator('[data-entry="Existing account"]').click();
    await expect(page.getByRole('button', { name: 'Download website icon…', exact: true })).toHaveCount(0);
    const modal = await appearance(page);
    await expect(modal.getByRole('group', { name: 'Built-in icon', exact: true })).toBeVisible();
    await expect(modal.getByLabel('Upload icon', { exact: true })).toBeAttached();
    await modal.getByRole('button', { name: 'Download website icon…', exact: true }).click();
    expect(website.requests).toEqual([]);
    await modal.getByRole('button', { name: 'Download icon', exact: true }).click();
    await expect(modal.getByRole('alert')).toContainText('could not be downloaded');
    website.missing = false;
    await modal.getByRole('button', { name: 'Download icon', exact: true }).click();
    await expect(modal.getByRole('img', { name: 'Website icon preview', exact: true })).toBeVisible();
    expect(website.requests).toEqual(['/favicon.ico', '/favicon.ico']);
    await page.screenshot({ path: test.info().outputPath(`icon-popup-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    let db = await download(page);
    expect(find(db, source.entry).customIcon?.id).toBe(source.icon);
    expect(find(db, source.entry).history).toHaveLength(1); expect(db.meta.customIcons.size).toBe(1);
    await back(page);
    const retry = await appearance(page);
    await retry.getByRole('button', { name: 'Download website icon…', exact: true }).click();
    await retry.getByRole('button', { name: 'Download icon', exact: true }).click();
    await expect(retry.getByRole('img', { name: 'Website icon preview', exact: true })).toBeVisible();
    await retry.getByRole('button', { name: 'Apply appearance', exact: true }).click();
    db = await download(page);
    expect(find(db, source.entry).customIcon?.id).not.toBe(source.icon);
    expect(db.meta.customIcons.size).toBe(2);
});

test('read-only blocks opening and applying a downloaded website icon draft', async ({ page, website }) => {
    const source = await open(page, true, website.url); await page.locator('[data-entry="Existing account"]').click();
    await readOnly(page, true);
    await expect(page.getByRole('button', { name: 'Change icon and color', exact: true })).toBeDisabled();
    expect(website.requests).toEqual([]);
    await readOnly(page, false);
    const modal = await appearance(page); website.missing = false;
    await modal.getByRole('button', { name: 'Download website icon…', exact: true }).click();
    await modal.getByRole('button', { name: 'Download icon', exact: true }).click();
    await expect(modal.getByRole('img', { name: 'Website icon preview', exact: true })).toBeVisible();
    await readOnly(page, true, false);
    await modal.getByRole('button', { name: 'Apply appearance', exact: true }).click();
    await expect(modal.getByRole('alert').filter({ hasText: 'This database is read-only.' })).toHaveText('This database is read-only.');
    await modal.getByRole('button', { name: 'Cancel', exact: true }).click();
    await readOnly(page, false);
    const db = await download(page);
    expect(find(db, source.entry).customIcon?.id).toBe(source.icon);
    expect(find(db, source.entry).history).toHaveLength(1); expect(db.meta.customIcons.size).toBe(1);
});
