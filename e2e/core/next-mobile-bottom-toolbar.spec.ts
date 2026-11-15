import { test, expect, type Page } from '@playwright/test';
import { activateVaultUtility } from './vault-utilities';

async function demo(page: Page) {
    await page.goto('/next.html'); await page.locator('#open-demo').click();
    await expect(page.locator('.entry-row').first()).toBeVisible();
}
async function screenshot(page: Page, name: string) {
    await page.screenshot({ path: test.info().outputPath(name+'.png'), fullPage: true });
}
async function menu(page: Page) {
    const reveal = page.getByRole('button', { name: 'Show toolbar', exact: true });
    if (await reveal.isVisible()) await reveal.click();
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    return page.getByRole('group', { name: 'Vault menu', exact: true });
}
for (const width of [320,390]) test.describe(`${width}px touch bottom toolbar`, () => {
    test.use({ hasTouch: true, viewport: { width, height: 740 } });
    test('one in-layout bar, one utility instance, generator and inline theme, hide reclaims its full row', async ({page}) => {
        await demo(page);
        const bar=page.locator('.mobile-toolbar'), list=page.locator('.list');
        await expect(bar).toHaveCount(1);await expect(page.locator('.mobile-vault-header, .side__close, .side__foot')).toHaveCount(0);
        const bounds=(await bar.boundingBox())!,content=(await list.boundingBox())!;
        expect(content.y+content.height).toBeLessThanOrEqual(bounds.y+1);
        expect(bounds.y+bounds.height).toBe(740);
        for(const control of await bar.locator(':scope > button, :scope > .entry-more > button').all()) {
            const b=(await control.boundingBox())!;expect(b.width).toBeGreaterThanOrEqual(44);expect(b.height).toBeGreaterThanOrEqual(44);
        }
        for(const name of ['Settings','Lock','Open another vault','Password generator']) await expect(page.getByRole('button',{name,exact:true,includeHidden:true})).toHaveCount(1);
        await screenshot(page,`bottom-default-${width}`);
        await activateVaultUtility(page,'Password generator',{touch:true});
        const generator=page.getByRole('dialog',{name:'Generate password',exact:true});await expect(generator).toBeVisible();await page.keyboard.press('Escape');
        await expect(page.getByRole('button',{name:'Password generator',exact:true})).toBeFocused();
        const actions=await menu(page);
        await expect(actions.getByRole('combobox',{name:'Theme',exact:true})).toBeVisible();
        await expect(page.getByRole('button',{name:'Theme',exact:true,includeHidden:true})).toHaveCount(0);
        await actions.getByRole('combobox',{name:'Theme',exact:true}).selectOption('dark');
        await screenshot(page,`bottom-menu-dark-${width}`);
        await actions.getByRole('button',{name:'Hide toolbar',exact:true}).tap();
        await expect(bar).toHaveCount(0);await expect(page.getByRole('button',{name:'Show toolbar',exact:true})).toBeFocused();
        expect((await page.locator('.mobile-toolbar-region').boundingBox())!.height).toBe(0);
        expect((await list.boundingBox())!.height-content.height).toBeGreaterThanOrEqual(55);
        await screenshot(page,`bottom-hidden-${width}`);
        await page.getByRole('button',{name:'Show toolbar',exact:true}).tap();await expect(bar).toBeVisible();
        await activateVaultUtility(page,'Settings',{touch:true});await expect(page.getByRole('tab',{name:'Appearance',exact:true})).toBeVisible();
    });
    test('native touch drag docks and persists, hide/reveal survives reload, drawer trap and unsaved draft survive', async({page,context,browserName})=>{
        test.skip(browserName!=='chromium','Native touch injection uses CDP');await demo(page);
        const handle=page.getByRole('button',{name:'Move toolbar',exact:true});const b=(await handle.boundingBox())!;
        const cdp=await context.newCDPSession(page),x=b.x+b.width/2,y=b.y+b.height/2;
        await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});
        for(let step=1;step<=5;step++)await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:y+(64-y)*step/5}]});
        await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
        await expect(page.locator('.vault')).toHaveAttribute('data-toolbar-dock','top');
        expect((await page.locator('.mobile-toolbar').boundingBox())!.y).toBe(0);
        await screenshot(page,`top-dragged-${width}`);
        await handle.focus();await handle.press('ArrowDown');await expect(page.locator('.vault')).toHaveAttribute('data-toolbar-dock','bottom');
        await handle.press('ArrowUp');await expect(page.locator('.vault')).toHaveAttribute('data-toolbar-dock','top');
        const actions=await menu(page);await actions.getByRole('button',{name:'Hide toolbar',exact:true}).click();
        await page.reload();await page.locator('#open-demo').tap();await expect(page.locator('.mobile-toolbar')).toHaveCount(0);
        await expect(page.locator('.vault')).toHaveAttribute('data-toolbar-dock','top');
        await page.getByRole('button',{name:'Show toolbar',exact:true}).tap();
        const browse=page.getByRole('button',{name:'Browse vault',exact:true}),nav=page.getByRole('navigation',{name:'Vault',exact:true});
        await browse.tap();await expect(browse).toHaveAttribute('aria-expanded','true');await expect(browse).toBeFocused();
        expect(await browse.evaluate(el=>!!el.closest('[inert]'))).toBe(false);
        expect(await page.locator('#search').evaluate(el=>!!el.closest('[inert]'))).toBe(true);
        const first=nav.locator('.nav-row').first();await first.focus();await first.press('Shift+Tab');
        await expect(page.getByRole('button',{name:'Menu',exact:true})).toBeFocused();await page.keyboard.press('Tab');await expect(first).toBeFocused();
        await page.keyboard.press('Escape');await expect(browse).toBeFocused();await expect(nav).toBeHidden();
        await page.locator('.entry-row').first().tap();await page.getByRole('button',{name:'Edit',exact:true}).tap();
        const notes=page.locator('.entry-editor').getByLabel('Notes',{exact:true});await notes.fill('Keep this unsaved draft across toolbar navigation');
        await browse.tap();await browse.tap();await expect(notes).toHaveValue('Keep this unsaved draft across toolbar navigation');
        await page.setViewportSize({width,height:400});await notes.focus();await notes.scrollIntoViewIfNeeded();
        const editor=page.locator('.entry-editor');expect(await editor.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
        await screenshot(page,`editing-short-viewport-${width}`);
    });
});
test('desktop keeps the existing footer, responsive changes never duplicate utility actions',async({page})=>{
    await page.setViewportSize({width:1280,height:800});await demo(page);
    await expect(page.locator('.mobile-toolbar')).toHaveCount(0);await expect(page.locator('.side__foot')).toHaveCount(1);
    await expect(page.getByRole('button',{name:'Menu',exact:true,includeHidden:true})).toHaveCount(0);
    await screenshot(page,'desktop-unchanged-1280');
    for(const width of [390,1280,320,1280]){
        await page.setViewportSize({width,height:800});
        for(const name of ['Settings','Lock','Open another vault','Password generator'])await expect(page.getByRole('button',{name,exact:true,includeHidden:true})).toHaveCount(1);
        await expect(page.locator('.mobile-toolbar')).toHaveCount(width<=760?1:0);
        await expect(page.locator('.side__foot')).toHaveCount(width<=760?0:1);
    }
});
