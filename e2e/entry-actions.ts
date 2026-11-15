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
