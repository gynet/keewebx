import { test, expect } from '@playwright/test';

interface Fixture {
    failForget(fail: boolean): void; abort(): void; dispose(): void; gate(): void; translate(map: Record<string, string>): void;
    result: unknown; cancelCount: number; secretReads: number;
}
declare global { interface Window { extensionUiFixture: Fixture } }

test.beforeEach(async ({ page }) => { await page.goto('/'); });

test('consent requires a decision, cancels with Escape, and restores focus', async ({ page }, testInfo) => {
    const trigger = page.getByRole('button', { name: 'connect', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath('consent-desktop.png') });
    expect(await page.evaluate(() => window.extensionUiFixture.result)).toBeUndefined();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
    expect(await page.evaluate(() => window.extensionUiFixture.result)).toBeNull();
    await trigger.click();
    await dialog.getByLabel('All databases, including ones opened later').uncheck();
    await dialog.getByLabel('Database (1)', { exact: true }).uncheck();
    await dialog.getByLabel('Database (2)', { exact: true }).uncheck();
    await expect(dialog.getByRole('button', { name: 'Allow', exact: true })).toBeDisabled();
    await dialog.getByLabel('Database (2)', { exact: true }).check();
    await dialog.getByLabel('Allow listing and searching entries').uncheck();
    await dialog.getByRole('button', { name: 'Allow', exact: true }).click();
    expect(await page.evaluate(() => window.extensionUiFixture.result)).toMatchObject({ files: ['two'], allFiles: false, canList: false });
});

test('entry search and keyboard selection use matching entries', async ({ page }) => {
    await page.getByRole('button', { name: 'entry', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('searchbox')).toBeFocused();
    await expect(dialog.getByRole('option')).toHaveCount(2);
    await dialog.getByRole('searchbox').fill('missing');
    await expect(dialog.getByText('No matching entries')).toBeVisible();
    await dialog.getByRole('searchbox').fill('');
    await dialog.getByRole('option').first().focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => window.extensionUiFixture.result)).toBe('Beta');
});

test('field previews never unwrap protected values', async ({ page }) => {
    await page.getByRole('button', { name: 'field', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Protected value', { exact: false })).toBeVisible();
    await expect(page.getByText('FixtureSecretNeverRender')).toHaveCount(0);
    expect(await page.evaluate(() => window.extensionUiFixture.secretReads)).toBe(0);
    await dialog.getByRole('radio', { name: /Password/ }).check();
    await dialog.getByRole('button', { name: 'Use field' }).click();
    expect(await page.evaluate(() => window.extensionUiFixture.result)).toBe('Password');
});

test('abort, gate suspension and touch disposal remove their dialogs', async ({ page }) => {
    await page.getByRole('button', { name: 'connect', exact: true }).click();
    await page.evaluate(() => window.extensionUiFixture.abort());
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => window.extensionUiFixture.result)).toBeNull();
    await page.getByRole('button', { name: 'touch', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.evaluate(() => window.extensionUiFixture.dispose());
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => window.extensionUiFixture.cancelCount)).toBe(0);
    await page.getByRole('button', { name: 'touch', exact: true }).click();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.extensionUiFixture.cancelCount)).toBe(1);
    await page.getByRole('button', { name: 'save', exact: true }).click();
    await page.evaluate(() => window.extensionUiFixture.gate());
    await expect(page.getByRole('dialog')).toHaveCount(0);
    expect(await page.evaluate(() => window.extensionUiFixture.result)).toBeNull();
    await page.getByRole('button', { name: 'connect', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('session permission controls and explicit disconnect are reachable', async ({ page }) => {
    const sessions = page.getByRole('region', { name: 'Browser extension sessions' });
    await sessions.getByLabel('Allow listing and searching entries').uncheck();
    await expect(sessions.getByLabel('Allow listing and searching entries')).not.toBeChecked();
    await sessions.getByRole('button', { name: 'Disconnect session', exact: true }).click();
    await expect(page.getByRole('dialog').getByText(/Remembered approvals may allow/)).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
    await expect(sessions.getByRole('button', { name: 'Disconnect session', exact: true })).toBeVisible();
    await sessions.getByRole('button', { name: 'Disconnect session', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(sessions.getByText('No browser extension sessions')).toBeVisible();
});

test('320px dialogs wrap long URLs and keep distinct database choices', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.getByRole('button', { name: 'save', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByLabel('Destination group').selectOption('3');
    const rect = await dialog.boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(320);
    expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath('save-320.png') });
    await dialog.getByRole('button', { name: 'Allow', exact: true }).click();
    expect(await page.evaluate(() => window.extensionUiFixture.result)).toMatchObject({ fileId: 'two', groupId: 'logins', askSave: 'always' });
    await page.getByRole('button', { name: 'group', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox', { name: 'Database', exact: true }).selectOption('two');
    await dialog.getByRole('button', { name: 'Allow', exact: true }).click();
    expect(await page.evaluate(() => window.extensionUiFixture.result)).toBe('two');
});

test('prompt labels use t translations', async ({ page }) => {
    await page.evaluate(() => window.extensionUiFixture.translate({ 'Allow browser extension access': 'Extension consent translated', Cancel: 'Cancel translated' }));
    await page.getByRole('button', { name: 'connect', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Extension consent translated' })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel translated' }).click();
});


test('duplicate leaf names require an explicit full-path destination', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.getByRole('button', { name: 'duplicate-save', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const allow = dialog.getByRole('button', { name: 'Allow', exact: true });
    await expect(allow).toBeDisabled();
    const destination = dialog.getByLabel('Destination group');
    await expect(destination.locator('option')).toHaveText([
        'Select a group', 'Database (1) / Database / Personal / Logins', 'Database (1) / Database / Work / Logins'
    ]);
    await destination.selectOption({ label: 'Database (1) / Database / Work / Logins' });
    await allow.click();
    expect(await page.evaluate(() => window.extensionUiFixture.result)).toEqual({ fileId: 'one', groupId: 'work', askSave: 'always' });
});


test('remembered identity and legacy approvals have separate explicit confirmations', async ({ page }) => {
    await page.getByRole('button', { name: 'Forget approval', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/even if a legacy shared approval exists/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByText('Extension identity: fixture-identity')).toBeVisible();
    await page.getByRole('button', { name: 'Forget approval', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Forget approval', exact: true }).click();
    await expect(page.getByText('No browser extension sessions')).toBeVisible();
    await expect(page.getByText('Extension identity: fixture-identity')).toHaveCount(0);
    await page.getByRole('button', { name: 'Forget legacy shared approval', exact: true }).click();
    dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/all legacy clients/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Forget approval', exact: true }).click();
    await expect(page.getByText('No remembered approvals')).toBeVisible();
});


test('failed durable forget keeps a visible retry after canceling its dialog', async ({ page }) => {
    await page.evaluate(() => window.extensionUiFixture.failForget(true));
    await page.getByRole('button', { name: 'Forget approval', exact: true }).click();
    let dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Forget approval', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('could not be saved');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('has not been saved');
    await page.evaluate(() => window.extensionUiFixture.failForget(false));
    await page.getByRole('button', { name: 'Forget approval', exact: true }).click();
    dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: 'Forget approval', exact: true }).click();
    await expect(page.getByText('Extension identity: fixture-identity')).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
});
