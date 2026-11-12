import { test, expect, type Locator, type Page } from '@playwright/test';
import * as kdbxweb from '../../modules/db/lib';
import { argon2 } from '../../modules/db/test/test-support/argon2';

const longTag = 'UnbrokenTag'.repeat(24);

async function openFixture(page: Page) {
    // Seed a real encrypted file, then exercise only the public UI after upload.
    kdbxweb.CryptoEngine.setArgon2Impl(argon2);
    const db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('navigation')), 'Navigation vault');
    const work = db.createGroup(db.groups[0], 'Work');
    const personal = db.createGroup(db.groups[0], 'Personal');
    const tagged = db.createEntry(work);
    tagged.fields.set('Title', 'Tagged work entry');
    tagged.tags = [longTag];
    db.createEntry(personal).fields.set('Title', 'Personal entry');
    const removed = db.createEntry(work);
    removed.fields.set('Title', 'Trashed entry');
    db.remove(removed);
    await page.goto('/next.html');
    await page.setInputFiles('#open-file-input', {
        name: 'navigation.kdbx', mimeType: 'application/octet-stream', buffer: Buffer.from(await db.save())
    });
    await page.locator('#password').fill('navigation');
    await page.locator('#unlock').click();
    await expect(page.locator('.entry-row')).toHaveCount(2, { timeout: 30_000 });
}

async function expectNoHorizontalOverflow(panel: Locator) {
    await expect(panel).toBeVisible();
    const dimensions = await panel.evaluate((element) => ({
        client: element.clientWidth, scroll: element.scrollWidth,
        left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
        viewport: innerWidth
    }));
    expect(dimensions.client).toBeGreaterThan(0);
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client + 1);
    expect(dimensions.left).toBeGreaterThanOrEqual(0);
    expect(dimensions.right).toBeLessThanOrEqual(dimensions.viewport + 1);
}

for (const width of [320, 390]) {
    test(`Browse vault filters groups, long tags and trash without internal overflow at ${width}px`, async ({ page, browserName }) => {
        await page.setViewportSize({ width, height: 740 });
        await openFixture(page);
        const browse = page.getByRole('button', { name: 'Browse vault', exact: true, includeHidden: true });
        const navigation = page.getByRole('navigation', { name: 'Vault', exact: true });
        const search = page.locator('#search');
        const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : undefined;
        const expectNativeSearchExposed = async (exposed: boolean) => {
            // Playwright 1.59's role engine does not account for inert. Use Chromium's
            // native AX tree; Firefox still runs all inert, focus and interaction checks.
            if (!cdp) return;
            const { nodes } = await cdp.send('Accessibility.getFullAXTree');
            const searches = nodes.filter((node) => !node.ignored && node.role?.value === 'searchbox' && node.name?.value === 'Search');
            expect(searches).toHaveLength(exposed ? 1 : 0);
            if (!exposed) expect(nodes.filter((node) => !node.ignored && node.name?.value === 'New entry')).toHaveLength(0);
        };
        const openNavigation = async () => {
            await browse.click();
            await expect(browse).toHaveAttribute('aria-expanded', 'true');
            await expect(navigation).toBeVisible();
            expect(await search.evaluate((element) => !!element.closest('[inert]'))).toBe(true);
            expect(await page.locator('.entry-list__create').evaluate((element) => !!element.closest('[inert]'))).toBe(true);
            await expectNativeSearchExposed(false);
            await search.focus();
            await expect(navigation.getByRole('button', { name: 'Close navigation', exact: true })).toBeFocused();
            await expectNoHorizontalOverflow(navigation.locator('.side__content'));
        };
        const expectClosed = async () => {
            await expect(navigation).toBeHidden();
            await expect(browse).toHaveAttribute('aria-expanded', 'false');
            await expect(browse).toBeFocused();
            await expect(page.getByRole('searchbox', { name: 'Search', exact: true })).toHaveCount(1);
            expect(await search.evaluate((element) => !!element.closest('[inert]'))).toBe(false);
            await expectNativeSearchExposed(true);
        };

        await expect(navigation).toBeHidden();
        await openNavigation();
        const close = navigation.getByRole('button', { name: 'Close navigation', exact: true });
        await expect(close).toBeFocused();
        // Keyboard users must remain inside the drawer and return to its trigger.
        await page.keyboard.press('Shift+Tab');
        await expect(navigation.getByRole('button', { name: 'Lock', exact: true })).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(close).toBeFocused();
        await page.keyboard.press('Escape');
        await expectClosed();

        await openNavigation();
        await navigation.getByRole('button', { name: 'Personal', exact: true }).click();
        await expectClosed();
        await expect(page.locator('.entry-row')).toHaveCount(1);
        await expect(page.locator('.entry-row')).toHaveAttribute('data-entry', 'Personal entry');

        await openNavigation();
        await navigation.getByRole('button', { name: 'Work', exact: true }).click();
        await expectClosed();
        await expect(page.locator('.entry-row')).toHaveCount(1);
        await expect(page.locator('.entry-row')).toHaveAttribute('data-entry', 'Tagged work entry');

        await openNavigation();
        const tag = navigation.getByRole('button', { name: longTag, exact: true });
        await expect(tag).toBeVisible();
        await expectNoHorizontalOverflow(tag);
        await tag.click();
        await expectClosed();
        await expect(page.locator('.entry-row')).toHaveCount(1);
        await page.locator('.entry-row[data-entry="Tagged work entry"]').click();
        const detail = page.getByRole('main', { name: 'Tagged work entry', exact: true });
        await expect(detail.locator('.tag__text')).toHaveText(longTag);
        await expectNoHorizontalOverflow(detail);
        await expectNoHorizontalOverflow(detail.locator('.tag'));
        await detail.getByRole('button', { name: 'Back', exact: true }).click();

        await openNavigation();
        await expect(tag).toHaveAttribute('aria-pressed', 'true');
        await navigation.getByRole('button', { name: 'Trash', exact: true }).click();
        await expectClosed();
        await expect(page.locator('.entry-row')).toHaveCount(1);
        await expect(page.locator('.entry-row')).toHaveAttribute('data-entry', 'Trashed entry');
        await page.locator('.entry-row').click();
        await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Back', exact: true }).click();

        await openNavigation();
        await navigation.getByRole('button', { name: 'All items', exact: true }).click();
        await expectClosed();
        await expect(page.locator('.entry-row')).toHaveCount(2);
        await expect(page.locator('.entry-row[data-entry="Trashed entry"]')).toHaveCount(0);
    });
}
