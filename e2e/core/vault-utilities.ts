import { expect, type Page } from '@playwright/test';

/** Follow the visible application controls on desktop, phone and the locked start screen. */
export async function activateVaultUtility(page: Page, name: string, options: { touch?: boolean; browseName?: string; start?: boolean } = {}) {
    // Wait for the requested surface: unlock/demo loading may still show Start's Settings.
    if (options.start) await expect(page.locator('.start')).toBeVisible();
    else await expect(page.locator('.vault')).toBeAttached({ timeout: 30_000 });
    const action = page.getByRole('button', { name, exact: true }).filter({ visible: true });
    const browse = page.getByRole('button', { name: options.browseName ?? 'Browse vault', exact: true });
    const reveal = page.locator('.mobile-toolbar__reveal');
    const menu = page.locator('.mobile-toolbar > .entry-more > button');
    await expect.poll(async () => await action.isVisible() || await browse.isVisible() || await reveal.isVisible()).toBe(true);
    if (!await action.isVisible()) {
        const closeActions = page.getByRole('group', { name: 'Entry actions', exact: true })
            .getByRole('button', { name: 'Close actions', exact: true });
        if (await closeActions.isVisible()) {
            if (options.touch) await closeActions.tap(); else await closeActions.click();
        }
        if (await reveal.isVisible()) {
            if (options.touch) await reveal.tap(); else await reveal.click();
        }
        const menuAction = page.locator('.mobile-toolbar > .entry-more').getByRole('button', { name, exact: true, includeHidden: true });
        const launcher = await menu.isVisible() && await menuAction.count() ? menu : browse;
        if (options.touch) await launcher.tap(); else await launcher.click();
    }
    await expect(action).toHaveCount(1);
    if (options.touch) await action.tap();
    else if (page.context().browser()?.browserType().name() === 'firefox' &&
        await action.evaluate(button => !!button.closest('.side__foot'))) {
        // Firefox can report a bottom-edge click without delivering native pointer
        // events. Use the footer button's real keyboard activation in that driver.
        await action.focus();
        await expect(action).toBeFocused();
        await action.press('Enter');
    } else await action.click();
}

/** The small-screen utility menu contains the real inline selector; desktop retains its popover. */
export async function revealVaultTheme(page: Page) {
    const reveal = page.locator('.mobile-toolbar__reveal');
    if (await reveal.isVisible()) await reveal.click();
    const menu = page.locator('.mobile-toolbar > .entry-more > button');
    if (await menu.isVisible()) {
        const picker = page.locator('.mobile-toolbar').getByRole('combobox', { name: 'Theme', exact: true });
        if (!await picker.isVisible()) await menu.click();
        await expect(picker).toBeVisible();
        return picker;
    }
    await activateVaultUtility(page, 'Theme');
    return page.getByRole('dialog', { name: 'Theme', exact: true }).getByRole('combobox', { name: 'Theme', exact: true });
}
