import { test, expect } from '@playwright/test';
for (const supported of [false,true]) test(`Share capability ${supported}: copy remains available`, async ({page}) => {
 await page.addInitScript(({supported})=>{
  Object.defineProperty(navigator,'share',{configurable:true,value:supported ? async()=>{throw new DOMException('Unavailable','NotAllowedError');}:undefined});
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async(value:string)=>{(window as any).copiedPassword=value;}}});
 },{supported});
 await page.goto('/next.html'); await page.locator('#open-demo').click(); await page.locator('.entry-row[data-entry="GitHub"]').click();
 await page.getByRole('button',{name:'More actions',exact:true}).click();
 const actions=page.getByRole('group',{name:'Entry actions',exact:true});
 if (!supported) await expect(actions.getByRole('button',{name:'Share password…',exact:true})).toHaveCount(0);
 await actions.getByRole('button',{name:supported?'Share password…':'Copy password…',exact:true}).click();
 if(supported) await page.getByRole('dialog',{name:'Share password',exact:true}).getByRole('button',{name:'Share password',exact:true}).click();
 const copy=page.getByRole('dialog',{name:'Copy password',exact:true}); await expect(copy).toBeVisible();
 await expect(copy).not.toContainText('Sharing is unavailable');
 await copy.getByRole('button',{name:'Copy password',exact:true}).click();
 await expect(page.getByRole('status').filter({hasText:'Password copied.'})).toBeVisible();
 expect(await page.evaluate(()=>Boolean((window as any).copiedPassword))).toBe(true);
});
