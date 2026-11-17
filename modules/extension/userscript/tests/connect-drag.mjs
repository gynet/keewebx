// Real ConnectUI and closed Shadow DOM, with native mouse/keyboard input in both engines.
// Repro: KWX_BUN=/path/to/bun node modules/extension/userscript/tests/connect-drag.mjs chromium webkit
// KWX_CHROMIUM_EXECUTABLE, KWX_WEBKIT_EXECUTABLE and KWX_WEBKIT_LIB override browser tools.
// Chromium also verifies a native touch drag; WebKit's automation API supports touch taps.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(path.join(repo, 'modules/extension/package.json'));
const browsers = require('@playwright/test');
const engines = process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'webkit'];
const positionKey = 'keewebx-connect-launcher-position-v1';
const resultsPath = process.env.CONNECT_DRAG_RESULTS || path.join(tmpdir(), 'keewebx-connect-drag-results.json');
const report = { passed: false, engines: {}, errors: [] };
const installer = await readFile(path.join(repo, 'modules/extension/userscript/keewebx-connect.user.js'), 'utf8');
report.installer = {version: installer.match(/@version\s+(\S+)/)?.[1], sha256:createHash('sha256').update(installer).digest('hex')};
const launcher = '[data-action=toggle]';
const fixture = `
    import { ConnectUI } from ${JSON.stringify(path.join(repo, 'modules/extension/userscript/src/connect-ui.ts'))};
    const attachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(options) {
        const root = attachShadow.call(this, options);
        window.testRoot = root;
        return root;
    };
    Object.defineProperty(window, 'GM', {get() {throw new Error('Drag must not access GM');}});
    const params = new URL(location.href).searchParams;
    if (params.has('stored')) localStorage.setItem(${JSON.stringify(positionKey)}, params.get('stored'));
    if (params.has('blocked')) {
        Storage.prototype.getItem = Storage.prototype.setItem = () => {throw new Error('Storage blocked');};
    }
    document.getElementById('outside').focus();
    window.ui = new ConnectUI(params.get('mode') || 'app', 'https://app.example.test/');
    window.opens = 0; window.actions = [];
    ui.onOpen = () => window.opens++;
    ui.on('authorize', event => window.actions.push(['authorize', event.isTrusted]));
    if (ui.mode === 'website') ui.anchor(document.getElementById('field'));
    window.initialFocusPreserved = document.activeElement.id === 'outside';
    window.ready = true;
`;

const bundle = execFileSync(process.env.KWX_BUN || 'bun', ['-e', `
    const result = await Bun.build({
        entrypoints: ['virtual:drag-fixture'], target: 'browser', format: 'iife', write: false,
        plugins: [{name:'drag-fixture', setup(builder) {
            builder.onResolve({filter: /^virtual:drag-fixture$/}, () => ({path:'fixture.ts',namespace:'fixture'}));
            builder.onLoad({filter: /.*/,namespace:'fixture'}, () => ({loader:'ts',contents:${JSON.stringify(fixture)}}));
        }}]
    });
    if (!result.success) throw new AggregateError(result.logs, 'Connect drag fixture build failed');
    await Bun.write(Bun.stdout, await result.outputs[0].text());
`], { cwd: repo, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });

async function settle(page) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
async function bounds(page, selector) {
    return page.evaluate(selector => {
        const rect = window.testRoot.querySelector(selector).getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
    }, selector);
}
async function click(page, selector) {
    await page.evaluate(selector => window.testRoot.querySelector(selector).scrollIntoView({block:'nearest'}), selector);
    const rect = await bounds(page, selector);
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await settle(page);
}
async function drag(page, x, y) {
    const start = await bounds(page, launcher);
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(x + start.width / 2, y + start.height / 2, {steps:8});
    await page.mouse.up();
    await settle(page);
}
async function isOpen(page) {
    return page.evaluate(() => !window.testRoot.querySelector('[role=dialog]').hidden);
}
function near(actual, expected) { assert(Math.abs(actual - expected) < 1, `${actual} should equal ${expected}`); }
async function onScreen(page, selector) {
    const rect = await bounds(page, selector), viewport = page.viewportSize();
    assert(rect.x >= 0 && rect.y >= 0 && rect.right <= viewport.width && rect.bottom <= viewport.height,
        `${selector} outside ${JSON.stringify(viewport)}: ${JSON.stringify(rect)}`);
}

try {
    assert(engines.every(engine => ['chromium', 'webkit'].includes(engine)));
    for (const engine of engines) {
        const cases = report.engines[engine] = [];
        const executablePath = process.env[engine === 'chromium' ? 'KWX_CHROMIUM_EXECUTABLE' : 'KWX_WEBKIT_EXECUTABLE'];
        const browser = await browsers[engine].launch({ headless: true, ...(executablePath ? {executablePath} : {}),
            ...(engine === 'webkit' && process.env.KWX_WEBKIT_LIB ? {
                env: {...process.env, LD_LIBRARY_PATH: [process.env.KWX_WEBKIT_LIB, process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter)}
            } : {}) });
        const context = await browser.newContext({viewport:{width:800,height:700},hasTouch:true});
        const page = await context.newPage();
        const pageErrors = [];
        let installerFixture = false;
        page.on('pageerror', error => pageErrors.push(error.message));
        await context.route('**/*', route => route.fulfill(route.request().url().endsWith('/fixture.js')
            ? {contentType:'application/javascript',body:installerFixture ? installer : bundle}
            : {contentType:'text/html',body:`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
                <style>body{margin:0}#field{position:absolute;left:80px;top:160px;width:180px}</style>
                <button id="outside">App menu</button><input id="field">${installerFixture ? `<script>
                    const attachShadow = Element.prototype.attachShadow;
                    Element.prototype.attachShadow = function(options) {const root = attachShadow.call(this,options);window.testRoot=root;return root;};
                    window.GM = {getValue:async()=>undefined,setValue:async()=>{},deleteValue:async()=>{},listValues:async()=>[],getTab:async()=>({}),saveTab:async()=>{}};
                </script>` : ''}<script src="/fixture.js"></script>`}));
        async function visit(query = '') {
            await page.goto('https://connect-drag.example.test/' + query);
            await page.waitForFunction(() => window.ready);
            await settle(page);
        }
        async function check(name, fn) {
            await fn();
            cases.push(name);
            console.log(`${engine}: ${name}`);
        }
        try {
            await visit();
            await check('closed root, initial focus, drag instructions and touch CSS', async () => {
                assert(await page.evaluate(() => window.initialFocusPreserved &&
                    !document.getElementById('keewebx-userscript-connect').shadowRoot &&
                    window.testRoot.getElementById(window.testRoot.querySelector('[data-action=toggle]').getAttribute('aria-describedby')).textContent.includes('arrow keys') &&
                    getComputedStyle(window.testRoot.querySelector('[data-action=toggle]')).touchAction === 'none'));
                assert.equal(await isOpen(page), false);
            });
            await check('native click and small pointer jitter still toggle', async () => {
                await click(page, launcher);
                assert.equal(await isOpen(page), true);
                await click(page, launcher);
                const rect = await bounds(page, launcher);
                await page.mouse.move(rect.x + 22, rect.y + 22);
                await page.mouse.down();
                await page.mouse.move(rect.x + 24, rect.y + 24);
                await page.mouse.up();
                assert.equal(await isOpen(page), true);
                await click(page, '[data-action=close]');
            });
            await check('drag moves and persists only coordinates without opening', async () => {
                const opens = await page.evaluate(() => window.opens);
                await drag(page, 90, 100);
                const rect = await bounds(page, launcher);
                near(rect.x, 90); near(rect.y, 100);
                assert.equal(await isOpen(page), false);
                assert.equal(await page.evaluate(() => window.opens), opens);
                assert.deepEqual(await page.evaluate(key => JSON.parse(localStorage.getItem(key)), positionKey), {x:90,y:100});
                await page.reload();
                await page.waitForFunction(() => window.ready);
                await settle(page);
                near((await bounds(page, launcher)).x, 90); near((await bounds(page, launcher)).y, 100);
            });
            await check('panel follows open launcher, clamps at all corners and actions work', async () => {
                await click(page, launcher);
                for (const point of [[0,0],[790,0],[790,690],[0,690]]) {
                    await drag(page, ...point);
                    assert.equal(await isOpen(page), true);
                    await onScreen(page, launcher);
                    await onScreen(page, '[role=dialog]');
                }
                await click(page, '[data-action=authorize]');
                assert.deepEqual(await page.evaluate(() => window.actions), [['authorize',true]]);
                await click(page, '[data-action=close]');
                await click(page, launcher);
                assert.equal(await isOpen(page), true);
            });
            await check('keyboard move preserves focus; Enter, Space and Escape still work', async () => {
                await click(page, launcher);
                await drag(page, 300, 300);
                await page.evaluate(() => window.testRoot.querySelector('[data-action=toggle]').focus());
                await page.keyboard.press('ArrowLeft');
                await page.keyboard.press('Shift+ArrowUp');
                const rect = await bounds(page, launcher);
                near(rect.x, 290); near(rect.y, 250);
                assert(await page.evaluate(() => window.testRoot.activeElement.dataset.action === 'toggle'));
                await page.keyboard.press('Enter'); assert.equal(await isOpen(page), true);
                await page.keyboard.press('Escape'); assert.equal(await isOpen(page), false);
                await page.keyboard.press('Space'); assert.equal(await isOpen(page), true);
            });
            await check('320px layout, resized and orientation viewports keep launcher and panel usable', async () => {
                await page.setViewportSize({width:320,height:230}); await settle(page);
                await onScreen(page, launcher); await onScreen(page, '[role=dialog]');
                await page.evaluate(() => dispatchEvent(new Event('orientationchange'))); await settle(page);
                await onScreen(page, launcher); await onScreen(page, '[role=dialog]');
                await click(page, '[data-action=authorize]');
                assert.equal((await page.evaluate(() => window.actions)).length, 2);
                await page.setViewportSize({width:800,height:700}); await settle(page);
            });
            await check('untrusted drag and key events cannot move the launcher', async () => {
                const before = await bounds(page, launcher);
                await page.evaluate(() => {
                    const button = window.testRoot.querySelector('[data-action=toggle]');
                    for (const type of ['pointerdown','pointermove','pointerup']) button.dispatchEvent(new PointerEvent(type,
                        {bubbles:true,pointerId:7,isPrimary:true,button:0,clientX:10,clientY:10}));
                    button.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}));
                });
                assert.deepEqual(await bounds(page, launcher), before);
            });
            await check('malformed saved positions and blocked storage are harmless', async () => {
                for (const value of ['invalid', 'null', '{"x":"100","y":20}', '{"x":1e999,"y":20}', '{"x":-10000,"y":100000}']) {
                    await visit('?stored=' + encodeURIComponent(value)); await onScreen(page, launcher);
                }
                await visit('?blocked=1');
                await drag(page, 120, 140);
                near((await bounds(page, launcher)).x,120);
                await click(page, launcher); assert.equal(await isOpen(page),true);
            });
            await check('website field launcher stays anchored and has no drag behavior', async () => {
                await visit('?mode=website');
                const before = await bounds(page, launcher);
                assert(await page.evaluate(() => {
                    const button = window.testRoot.querySelector('[data-action=toggle]');
                    return !button.hasAttribute('data-draggable') && !button.hasAttribute('aria-describedby') &&
                        getComputedStyle(button).touchAction === 'manipulation';
                }));
                await drag(page, 400, 400);
                assert.deepEqual(await bounds(page, launcher), before);
                await click(page, launcher); assert.equal(await isOpen(page),true);
            });
            await check('relay keeps its centered panel and hidden launcher', async () => {
                await visit('?mode=relay');
                assert(await page.evaluate(() => window.testRoot.querySelector('[data-action=toggle]').hidden));
                await onScreen(page, '[role=dialog]');
            });
            await check('native touch tap works after moving', async () => {
                await visit(); await drag(page, 140, 140);
                const rect = await bounds(page, launcher);
                await page.touchscreen.tap(rect.x + 22, rect.y + 22);
                assert.equal(await isOpen(page),true);
            });
            if (engine === 'chromium') await check('native touch drag moves without toggling and persists across reload', async () => {
                await click(page, launcher);
                const session = await context.newCDPSession(page), rect = await bounds(page, launcher);
                const touchPoints = (x,y) => [{x,y,id:1}];
                await session.send('Input.dispatchTouchEvent', {type:'touchStart',touchPoints:touchPoints(rect.x+22,rect.y+22)});
                await session.send('Input.dispatchTouchEvent', {type:'touchMove',touchPoints:touchPoints(242,282)});
                await session.send('Input.dispatchTouchEvent', {type:'touchEnd',touchPoints:[]});
                await settle(page);
                near((await bounds(page, launcher)).x,220); near((await bounds(page, launcher)).y,260);
                assert.equal(await isOpen(page),false);
                await page.reload(); await page.waitForFunction(() => window.ready); await settle(page);
                near((await bounds(page, launcher)).x,220); near((await bounds(page, launcher)).y,260);
                await session.detach();
            });
            await check(`built installer ${report.installer.version}: drag, reload, click, keyboard and resize`, async () => {
                installerFixture = true;
                const loaded = () => page.waitForFunction(() => window.testRoot?.querySelector('[data-action=toggle][data-draggable]'));
                await page.goto('https://keewebx.app/app'); await loaded(); await settle(page);
                assert((await page.evaluate(() => window.testRoot.querySelector('[data-role=version]').textContent)).includes(report.installer.version));
                await drag(page,180,180); assert.equal(await isOpen(page),false);
                near((await bounds(page,launcher)).x,180); near((await bounds(page,launcher)).y,180);
                await page.reload(); await loaded(); await settle(page);
                near((await bounds(page,launcher)).x,180); near((await bounds(page,launcher)).y,180);
                await click(page,launcher); assert.equal(await isOpen(page),true);
                await onScreen(page,'[role=dialog]');
                await page.keyboard.press('ArrowRight'); near((await bounds(page,launcher)).x,190);
                await page.setViewportSize({width:320,height:230}); await settle(page);
                await onScreen(page,launcher); await onScreen(page,'[role=dialog]');
                await click(page,'[data-action=close]'); assert.equal(await isOpen(page),false);
            });
            assert.deepEqual(pageErrors, []);
        } finally { await context.close(); await browser.close(); }
    }
    report.passed = true;
} catch (error) {
    report.errors.push(String(error.stack || error));
    console.error(error);
    process.exitCode = 1;
} finally {
    await mkdir(path.dirname(resultsPath), {recursive:true});
    await writeFile(resultsPath, JSON.stringify(report,null,2) + '\n');
    console.log(`${Object.values(report.engines).flat().length} drag cases passed; report: ${resultsPath}`);
}
