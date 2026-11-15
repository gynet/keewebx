import { expect, type Page } from '@playwright/test';

/** Follow the visible application controls on desktop, phone and the locked start screen. */
export async function activateVaultUtility(page: Page, name: string, options: { touch?: boolean; browseName?: string; start?: boolean } = {}) {
    // Wait for the requested surface: unlock/demo loading may still show Start's Settings.
    if (options.start) await expect(page.locator('.start')).toBeVisible();
    else await expect(page.locator('.vault')).toBeAttached({ timeout: 30_000 });
    const action = page.getByRole('button', { name, exact: true }).filter({ visible: true });
    const browse = page.getByRole('button', { name: options.browseName ?? 'Browse vault', exact: true });
    await expect.poll(async () => await action.isVisible() || await browse.isVisible()).toBe(true);
    if (!await action.isVisible()) {
        const closeActions = page.getByRole('group', { name: 'Entry actions', exact: true })
            .getByRole('button', { name: 'Close actions', exact: true });
        if (await closeActions.isVisible()) {
            if (options.touch) await closeActions.tap(); else await closeActions.click();
        }
        if (options.touch) await browse.tap(); else await browse.click();
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
