import { expect, type Page } from '@playwright/test';

/** Reveal detail actions only when hidden; editor History remains directly available. */
export async function revealEntryAction(page: Page, name: string, touch = false) {
    const action = page.getByRole('button', { name, exact: true });
    const more = page.getByRole('button', { name: 'More actions', exact: true });
    await expect.poll(async () => await action.isVisible() || await more.isVisible()).toBe(true);
    if (!await action.isVisible()) {
        if (touch) await more.tap(); else await more.click();
    }
    await expect(action).toBeVisible();
    return action;
}

export async function activateEntryAction(page: Page, name: string, touch = false) {
    const action = await revealEntryAction(page, name, touch);
    if (touch) await action.tap(); else await action.click();
}

/** Complete the visible recycle workflow; tests of cancellation use the action directly. */
export async function recycleEntry(page: Page) {
    const { narrow, touch } = await page.evaluate(() => ({ narrow: matchMedia('(max-width: 900px)').matches, touch: navigator.maxTouchPoints > 0 }));
    await activateEntryAction(page, 'Recycle', touch);
    const dialog = page.getByRole('dialog', { name: 'Move entry to Trash', exact: true });
    if (narrow) {
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
        await expect(dialog).toContainText('You can restore this entry, its history and its attachments from Trash.');
        const confirm = dialog.getByRole('button', { name: 'Move to Trash', exact: true });
        if (touch) await confirm.tap(); else await confirm.click();
    }
    await expect(dialog).toHaveCount(0);
}
