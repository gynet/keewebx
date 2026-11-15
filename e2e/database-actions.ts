import { expect, type Page } from '@playwright/test';

/** Open the global or per-file database popover before using Save/Close. */
export async function revealDatabaseAction(page: Page, name: string | RegExp, touch = false) {
    const closeEntryActions = page.getByRole('group', { name: 'Entry actions', exact: true })
        .getByRole('button', { name: 'Close actions', exact: true });
    if (await closeEntryActions.isVisible()) {
        if (touch) await closeEntryActions.tap(); else await closeEntryActions.click();
    }
    const reveal = page.locator('.mobile-toolbar__reveal');
    if (await reveal.isVisible()) { if (touch) await reveal.tap(); else await reveal.click(); }
    const toolbar = page.locator('.mobile-toolbar');
    const mobileAction = toolbar.getByRole('button', { name, exact: typeof name === 'string', includeHidden: true });
    if (await mobileAction.count()) {
        const action = toolbar.getByRole('button', { name, exact: typeof name === 'string' });
        if (!await action.isVisible()) {
            const menu = toolbar.locator(':scope > .entry-more > button');
            if (touch) await menu.tap(); else await menu.click();
        }
        await expect(action).toBeVisible();
        return action;
    }
    const mobileClose = toolbar.getByRole('button', { name: 'Close actions', exact: true });
    if (await mobileClose.isVisible()) { if (touch) await mobileClose.tap(); else await mobileClose.click(); }
    const nav = page.getByRole('navigation', { name: 'Vault', exact: true });
    if (!await nav.isVisible()) {
        const browse = page.getByRole('button', { name: 'Browse vault', exact: true });
        if (touch) await browse.tap(); else await browse.click();
    }
    const action = nav.getByRole('button', { name, exact: typeof name === 'string' });
    if (!await action.isVisible()) {
        const dismiss = page.locator('.command-status').getByRole('button', { name: 'Dismiss', exact: true }).filter({ visible: true });
        if (await dismiss.count()) {
            if (touch) await dismiss.tap(); else await dismiss.click();
        }
        // A previous popover may cover another vault's trigger.
        const close = nav.getByRole('button', { name: 'Close actions', exact: true }).filter({ visible: true });
        if (await close.count()) {
            if (touch) await close.tap(); else await close.click();
        }
        const popover = nav.locator('.entry-more').filter({ has: page.getByRole('button', { name, exact: typeof name === 'string', includeHidden: true }) });
        const trigger = popover.locator(':scope > button');
        if (touch) await trigger.tap(); else await trigger.click();
    }
    await expect(action).toBeVisible();
    return action;
}

export async function activateDatabaseAction(page: Page, name: string | RegExp, touch = false) {
    const action = await revealDatabaseAction(page, name, touch);
    if (touch) await action.tap(); else await action.click();
}
