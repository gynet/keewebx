import { test, expect } from '@playwright/test';

test.use({ hasTouch: true, viewport: { width: 320, height: 740 } });

test('native touch moves collapsed and expanded menu vertically, docks both ways, cancels cleanly and retains height', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'This regression requires Chromium CDP native touch events.');
    await page.goto('/next.html');
    await page.locator('#open-demo').click();
    const bar = page.locator('.phone-bar');
    const handle = bar.locator('.phone-bar__handle');
    const cdp = await context.newCDPSession(page);
    const bounds = async () => {
        const box = await bar.boundingBox();
        expect(box).not.toBeNull();
        return box!;
    };
    const dragTo = async (x: number, y: number, cancel = false) => {
        const box = (await handle.boundingBox())!;
        const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        const point = (x: number, y: number) => ({ x, y, id: 1, radiusX: 2, radiusY: 2, force: 1 });
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point(from.x, from.y)] });
        for (let step = 1; step <= 10; step++) {
            await cdp.send('Input.dispatchTouchEvent', {
                type: 'touchMove',
                touchPoints: [point(from.x + (x - from.x) * step / 10, from.y + (y - from.y) * step / 10)]
            });
        }
        await cdp.send('Input.dispatchTouchEvent', { type: cancel ? 'touchCancel' : 'touchEnd', touchPoints: [] });
    };
    const expectCollapsed = async () => {
        await expect(handle).toHaveAttribute('aria-expanded', 'false');
        await expect(handle).toHaveAccessibleName('Show menu');
        await expect(bar.getByRole('button', { name: 'Browse vault', exact: true })).toHaveCount(0);
    };

    await handle.tap();
    await expectCollapsed();
    const initial = await bounds();
    const initialHandle = (await handle.boundingBox())!;
    await dragTo(initialHandle.x + initialHandle.width / 2, initialHandle.y + initialHandle.height / 2 - 150);
    await expectCollapsed();
    await expect.poll(async () => (await bounds()).y).toBeCloseTo(initial.y - 150, 0);

    const raisedHandle = (await handle.boundingBox())!;
    const raisedY = raisedHandle.y + raisedHandle.height / 2;
    await dragTo(18, raisedY);
    await expect(bar).toHaveAttribute('data-side', 'left');
    await expectCollapsed();
    expect((await bounds()).x).toBeCloseTo(0, 0);
    await dragTo(302, raisedY);
    await expect(bar).toHaveAttribute('data-side', 'right');
    await expectCollapsed();
    const right = await bounds();
    expect(right.x + right.width).toBeCloseTo(320, 0);

    const beforeCancel = await bounds();
    await dragTo(160, raisedY - 60, true);
    await expectCollapsed();
    await expect.poll(async () => (await bounds()).x).toBeCloseTo(beforeCancel.x, 0);
    await expect.poll(async () => (await bounds()).y).toBeCloseTo(beforeCancel.y, 0);
    await expect(bar).toHaveCSS('transform', 'none');

    await handle.tap();
    await expect(handle).toHaveAttribute('aria-expanded', 'true');
    await expect(bar.getByRole('button', { name: 'Browse vault', exact: true })).toBeVisible();
    const expanded = await bounds();
    const expandedHandle = (await handle.boundingBox())!;
    await dragTo(expandedHandle.x + expandedHandle.width / 2, expandedHandle.y + expandedHandle.height / 2 - 100);
    await expect(handle).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(async () => (await bounds()).y).toBeCloseTo(expanded.y - 100, 0);
    const beforeReload = await bounds();
    const retainedBottom = 740 - beforeReload.y - beforeReload.height;
    await page.reload();
    await page.locator('#open-demo').click();
    await expect(bar).toBeVisible();
    await expect.poll(async () => {
        const box = await bounds();
        return 740 - box.y - box.height;
    }).toBeCloseTo(retainedBottom, 0);

    // A smaller viewport must clamp the remembered height, keeping the handle reachable.
    await page.setViewportSize({ width: 320, height: 200 });
    await expect.poll(async () => {
        const box = await bounds();
        return 200 - box.y - box.height;
    }).toBeCloseTo(128, 0);
    const clamped = await bounds();
    expect(clamped.y).toBeGreaterThanOrEqual(0);
    expect(clamped.x).toBeGreaterThanOrEqual(0);
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(320);
    expect(clamped.y + clamped.height).toBeLessThanOrEqual(188);
    await handle.tap();
    await expectCollapsed();
    await handle.tap();
    await expect(bar.getByRole('button', { name: 'Browse vault', exact: true })).toBeVisible();
});
