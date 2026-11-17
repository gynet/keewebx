// Compile the actual adapter and exercise real DOM behavior in both browser engines.
// Repro: node modules/extension/userscript/tests/login-fields.mjs chromium webkit
// Optional overrides: LOGIN_FIELD_REPO, LOGIN_FIELD_BUN, LOGIN_FIELD_RESULTS.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = process.env.LOGIN_FIELD_REPO || fileURLToPath(new URL('../../../../', import.meta.url));
const require = createRequire(path.join(repo, 'package.json'));
const { chromium, webkit } = require('@playwright/test');
const engines = process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'webkit'];
assert(engines.every(name => ['chromium', 'webkit'].includes(name)), 'Use chromium and/or webkit');
const inputs = [
    'modules/extension/userscript/src/login-fields.ts',
    'modules/extension/userscript/src/form-targets.ts',
    'modules/extension/src/content/form-fill.ts'
];
const hashes = async () => Object.fromEntries(await Promise.all(inputs.map(async file => [
    file, createHash('sha256').update(await readFile(path.join(repo, file))).digest('hex')
])));
const sourceHashes = await hashes();
const source = execFileSync(process.env.LOGIN_FIELD_BUN || 'bun', ['-e', `
    const result = await Bun.build({
        entrypoints: ['modules/extension/userscript/src/login-fields.ts'],
        target: 'browser', format: 'esm', minify: false, sourcemap: 'none'
    });
    if (!result.success) throw new AggregateError(result.logs, 'Login field adapter build failed');
    await Bun.write(Bun.stdout, await result.outputs[0].text());
`], { cwd: repo, encoding: 'utf8', maxBuffer: 2 ** 20 });
assert.deepEqual(await hashes(), sourceHashes, 'Source changed during bundling; rerun');

const report = { sourceHashes, fixture: 'https://login-fields.example/news', engines: {} };
for (const name of engines) {
    const browser = await { chromium, webkit }[name].launch({ headless: true });
    try {
        const context = await browser.newContext({ viewport: { width: 900, height: 720 } });
        await context.route('https://login-fields.example/**', route => route.fulfill({
            contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Login field fixtures</title>'
        }));
        const page = await context.newPage();
        await page.goto(report.fixture);
        const cases = await page.evaluate(async source => {
            const blob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
            const api = await import(blob);
            URL.revokeObjectURL(blob);
            window.loginFieldTestAPI = api;
            const { isLoginField, watchLoginFields } = api;
            const results = [];
            const stops = [];
            const nativeFrame = window.requestAnimationFrame.bind(window);
            const settle = async (count = 3) => {
                for (let i = 0; i < count; i++) await new Promise(resolve => nativeFrame(resolve));
            };
            const check = (condition, message) => { if (!condition) throw new Error(message); };
            const fixture = html => {
                document.body.innerHTML = `<style>
                    body{margin:8px}input{display:block;width:220px;height:28px;margin:4px}
                    [data-concealed=true]{display:none}
                </style>${html}`;
                window.scrollTo(0, 0);
            };
            const field = id => document.getElementById(id);
            const login = (prefix = '') => `<form><input id="${prefix}user" autocomplete="username"><input id="${prefix}password" type="password" autocomplete="current-password"></form>`;
            const watch = callback => { const stop = watchLoginFields(callback); stops.push(stop); return stop; };
            const run = async (name, test) => {
                try { await test(); results.push({ name, passed: true }); }
                catch (error) { results.push({ name, passed: false, error: String(error.message || error) }); }
                finally { for (const stop of stops.splice(0)) stop(); }
            };

            await run('empty/nonlogin page immediately reports no anchor', async () => {
                fixture('<h1>News</h1><p>No form here.</p>');
                const events = [];
                watch(value => events.push(value));
                check(events.length === 1 && events[0] === undefined, 'Missing initial undefined callback');
                document.body.append(document.createElement('article'));
                await settle();
                check(events.length === 1, 'Unrelated content emitted an anchor');
            });
            await run('search, newsletter, contact and ordinary email are never anchors', async () => {
                fixture(`<header><a href="/login">Sign in</a></header>
                    <form role="search"><input id="search" name="q"><input type="search" autocomplete="username"></form>
                    <form id="newsletter"><h2>Newsletter</h2><input id="newsletterEmail" type="email" autocomplete="email"><button>Subscribe</button></form>
                    <form id="contact"><input id="name" name="name"><input id="contactEmail" type="email"><textarea></textarea><button>Send</button></form>
                    <input id="email" type="email">`);
                check([...document.querySelectorAll('input')].every(input => !isLoginField(input)), 'Nonlogin input accepted');
                const events = [];
                watch(value => events.push(value));
                field('newsletterEmail').focus(); await settle();
                field('search').focus(); await settle();
                check(events.length === 1 && events[0] === undefined, 'Focusing nonlogin input produced an anchor');
            });
            await run('paired username/password match existing targets; unrelated preceding text does not', () => {
                fixture('<form><input id="search"><input id="user"><input id="password" type="password"></form>');
                check(!isLoginField(field('search')), 'Unrelated field before username accepted');
                check(isLoginField(field('user')) && isLoginField(field('password')), 'Login pair rejected');
            });
            await run('password alone and explicit standalone usernames are supported', () => {
                fixture('<input id="password" type="password"><input id="user" autocomplete="section-auth username"><input id="phone" type="tel" autocomplete="username"><input id="text">');
                check(['password', 'user', 'phone'].every(id => isLoginField(field(id))), 'Supported standalone login rejected');
                check(!isLoginField(field('text')), 'Ordinary standalone text accepted');
            });
            await run('formless adjacent username/password use the existing fill association', () => {
                fixture('<div><label>Username<input id="user"></label><label>Password<input id="password" type="password"></label></div>');
                check(isLoginField(field('user')) && isLoginField(field('password')), 'Formless login rejected');
            });
            await run('newsletter in another form is not paired with a login password', () => {
                fixture('<form id="newsletter"><input id="email" type="email"></form><form><input id="password" type="password"></form>');
                check(!isLoginField(field('email')) && isLoginField(field('password')), 'Fields crossed form boundaries');
            });
            await run('explicit nonlogin fields are rejected even before a fillable password', () => {
                for (const name of ['search', 'contact', 'otp', 'newPassword']) {
                    fixture(`<form><input id="${name}"><input id="password" type="password"></form>`);
                    check(!isLoginField(field(name)) && isLoginField(field('password')), `Nonlogin field accepted: ${name}`);
                }
            });
            await run('formless newsletter is not selected before an unrelated login password', () => {
                fixture('<div id="newsletter"><input id="email" type="email"></div><div><input id="password" type="password"></div>');
                const events = [];
                watch(value => events.push(value));
                check(!isLoginField(field('email')) && events[0] === field('password'), 'Formless newsletter became the login anchor');
            });
            await run('email-only login requires explicit local context', () => {
                for (const html of [
                    '<form id="signInForm"><input id="email" type="email"><button>Continue</button></form>',
                    '<form action="/session/login"><input id="email" type="email"></form>',
                    '<form><input id="email" type="email"><button>Sign in</button></form>',
                    '<section aria-label="Log in"><input id="email" type="email"></section>',
                    '<input id="email" type="email" autocomplete="username">'
                ]) {
                    fixture(html);
                    check(isLoginField(field('email')), `Explicit email login rejected: ${html}`);
                }
            });
            await run('global login heading does not turn newsletter/contact/signup into login', () => {
                fixture('<h1>Sign in</h1><form id="newsletter-login"><input id="newsletterEmail" type="email"><button>Subscribe</button></form><form id="contact"><input id="contactEmail" type="email"></form><form id="signup"><input id="signupEmail" type="email"><button>Sign up</button></form>');
                check([...document.querySelectorAll('input')].every(input => !isLoginField(input)), 'Nonlogin email inherited global login context');
            });
            await run('OTP, new-password and usernames leading to new-password are rejected', () => {
                fixture('<form><input id="user" autocomplete="username"><input id="new" type="password" autocomplete="section-register new-password"></form><form><input id="otp" autocomplete="one-time-code"><input id="secretOtp" type="password" autocomplete="one-time-code"></form>');
                check([...document.querySelectorAll('input')].every(input => !isLoginField(input)), 'OTP or signup field accepted');
            });
            await run('disabled, readonly, hidden, inert and invisible password fields are rejected', () => {
                for (const html of [
                    '<input type="password" disabled>', '<fieldset disabled><input type="password"></fieldset>',
                    '<input type="password" readonly>', '<input type="hidden" autocomplete="username">',
                    '<div hidden><input type="password"></div>', '<div inert><input type="password"></div>',
                    '<div aria-hidden="true"><input type="password"></div>',
                    '<div style="display:none"><input type="password"></div>',
                    '<div style="visibility:hidden"><input type="password"></div>',
                    '<div style="visibility:collapse"><input type="password"></div>',
                    '<div style="opacity:0"><input type="password"></div>',
                    '<input type="password" style="width:0;height:0;padding:0;border:0">',
                    '<div style="height:0;overflow:hidden"><input type="password"></div>',
                    '<div style="content-visibility:hidden"><input type="password"></div>'
                ]) {
                    fixture(html);
                    check(!isLoginField(document.querySelector('input')), `Inaccessible field accepted: ${html}`);
                }
            });
            await run('unknown values, detached inputs and other documents are rejected', () => {
                fixture('<div></div>');
                const detached = document.createElement('input'); detached.type = 'password';
                const foreign = document.implementation.createHTMLDocument().createElement('input'); foreign.type = 'password';
                for (const value of [undefined, null, {}, 'input', document.body, detached, foreign]) {
                    check(!isLoginField(value), 'Nonlocal or noninput value accepted');
                }
            });
            await run('hostile IDs/labels are data; detection reads no values and emits no fill/submit events', async () => {
                fixture('<form><input type="email"><button>Continue</button></form><h2></h2>');
                const input = document.querySelector('input');
                const heading = document.querySelector('h2');
                heading.id = 'sign-in\"][value="hostile:<script>'; heading.textContent = 'Sign in';
                input.id = '\"]:not(input),input[value="';
                input.form.setAttribute('aria-labelledby', heading.id);
                const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
                const submit = HTMLFormElement.prototype.submit;
                const requestSubmit = HTMLFormElement.prototype.requestSubmit;
                let reads = 0, writes = 0, events = 0, submits = 0;
                const record = event => { event.preventDefault(); events++; };
                for (const event of ['input', 'change', 'submit']) document.addEventListener(event, record, true);
                try {
                    Object.defineProperty(HTMLInputElement.prototype, 'value', {
                        configurable: true, get() { reads++; throw new Error('Field value read'); },
                        set() { writes++; throw new Error('Field value written'); }
                    });
                    HTMLFormElement.prototype.submit = HTMLFormElement.prototype.requestSubmit = () => { submits++; };
                    check(isLoginField(input), 'Hostile IDs broke accessible login context');
                    const anchors = [];
                    watch(value => anchors.push(value));
                    await settle();
                    check(anchors.length === 1 && anchors[0] === input, 'Hostile ID anchor was not selected');
                    check(reads === 0 && writes === 0 && submits === 0 && events === 0, 'Detection accessed values or filled/submitted');
                } finally {
                    Object.defineProperty(HTMLInputElement.prototype, 'value', descriptor);
                    HTMLFormElement.prototype.submit = submit;
                    HTMLFormElement.prototype.requestSubmit = requestSubmit;
                    for (const event of ['input', 'change', 'submit']) document.removeEventListener(event, record, true);
                }
            });
            await run('dynamic insert, focus, hide, restore and remove update the selected field', async () => {
                fixture('<input id="search" type="search">');
                const events = [];
                watch(value => events.push(value));
                document.body.insertAdjacentHTML('beforeend', login()); await settle();
                check(events.at(-1) === field('user'), 'Inserted username not selected');
                field('password').focus(); await settle();
                check(events.at(-1) === field('password'), 'Focused password not preferred');
                field('search').focus(); await settle();
                check(events.at(-1) === field('password'), 'Nonlogin focus replaced previous valid anchor');
                const form = field('user').form;
                form.hidden = true; await settle();
                check(events.at(-1) === undefined, 'Hiding form retained an anchor');
                form.hidden = false; await settle();
                check(events.at(-1) === field('user'), 'Restoring form did not select first login');
                form.remove(); await settle();
                check(events.at(-1) === undefined, 'Removing form retained an anchor');
            });
            await run('focused login wins, then previous valid, then first visible in DOM order', async () => {
                fixture(login('first-') + login('second-') + '<input id="search" type="search">');
                const events = [];
                field('second-password').focus();
                watch(value => events.push(value));
                check(events[0] === field('second-password'), 'Initial focus ignored');
                field('search').focus(); await settle();
                check(events.at(-1) === field('second-password'), 'Previous valid selection ignored');
                field('second-password').disabled = true; await settle();
                check(events.at(-1) === field('first-user'), 'First visible fallback ignored');
                field('second-user').focus(); await settle();
                // Its paired password is disabled, so it cannot become a fill target.
                check(events.at(-1) === field('first-user'), 'Invalid login focus replaced selection');
                field('second-password').disabled = false; await settle();
                check(events.at(-1) === field('second-user'), 'Newly valid focused login did not win');
            });
            await run('property and ancestor eligibility changes are observed', async () => {
                fixture('<fieldset><input id="password" type="password"></fieldset>');
                const input = field('password');
                const parent = input.parentElement;
                const events = [];
                watch(value => events.push(value));
                for (const [hide, show] of [
                    [() => { input.disabled = true; }, () => { input.disabled = false; }],
                    [() => { input.readOnly = true; }, () => { input.readOnly = false; }],
                    [() => { parent.disabled = true; }, () => { parent.disabled = false; }],
                    [() => { parent.hidden = true; }, () => { parent.hidden = false; }],
                    [() => { parent.inert = true; }, () => { parent.inert = false; }],
                    [() => { parent.setAttribute('aria-hidden', 'true'); }, () => { parent.removeAttribute('aria-hidden'); }],
                    [() => { parent.dataset.concealed = 'true'; }, () => { delete parent.dataset.concealed; }],
                    [() => { parent.style.opacity = '0'; }, () => { parent.style.opacity = ''; }]
                ]) {
                    hide(); await settle(); check(events.at(-1) === undefined, 'Ineligible field retained');
                    show(); await settle(); check(events.at(-1) === input, 'Restored eligible field not selected');
                }
            });
            await run('type and autocomplete changes are observed without replacing the node', async () => {
                fixture('<form id="login"><input id="field"></form>');
                const input = field('field');
                const events = [];
                watch(value => events.push(value));
                check(events.at(-1) === undefined, 'Plain text accepted');
                input.type = 'password'; await settle(); check(events.at(-1) === input, 'Password type ignored');
                input.autocomplete = 'new-password'; await settle(); check(events.at(-1) === undefined, 'New-password accepted');
                input.autocomplete = 'current-password'; await settle(); check(events.at(-1) === input, 'Current-password rejected');
                input.autocomplete = 'one-time-code'; await settle(); check(events.at(-1) === undefined, 'OTP accepted');
                input.type = 'hidden'; input.autocomplete = 'username'; await settle(); check(events.at(-1) === undefined, 'Hidden input accepted');
                input.type = 'text'; await settle(); check(events.at(-1) === input, 'Standalone username not selected');
                input.autocomplete = 'off'; await settle(); check(events.at(-1) === undefined, 'Unmarked standalone text accepted');
                input.type = 'email'; await settle(); check(events.at(-1) === input, 'Email login context not detected');
            });
            await run('changing local email login context updates detection', async () => {
                fixture('<form><input id="email" type="email"><button>Continue</button></form>');
                const input = field('email');
                const button = document.querySelector('button');
                const events = [];
                watch(value => events.push(value));
                button.firstChild.data = 'Sign in'; await settle();
                check(events.at(-1) === input, 'Character data login context not observed');
                button.textContent = 'Subscribe'; await settle();
                check(events.at(-1) === undefined, 'Newsletter context retained email anchor');
                button.textContent = 'Continue'; input.form.id = 'signInForm'; await settle();
                check(events.at(-1) === input, 'Form ID login context not observed');
                input.form.id = 'newsletter'; await settle();
                check(events.at(-1) === undefined, 'Changed form context retained anchor');
            });
            await run('stylesheet text mutations hide and restore an existing field', async () => {
                fixture('<style id="visibility"></style><input id="password" type="password">');
                const events = [];
                watch(value => events.push(value));
                field('visibility').textContent = 'input{display:none!important}'; await settle();
                check(events.at(-1) === undefined, 'Stylesheet visibility change not observed');
                field('visibility').firstChild.data = 'input{display:block}'; await settle();
                check(events.at(-1) === field('password'), 'Stylesheet restore not observed');
            });
            await run('SPA replacement selects the new field and releases the detached field', async () => {
                fixture(login());
                const events = [];
                watch(value => events.push(value));
                const original = field('user');
                history.pushState(null, '', '/account/sign-in');
                original.form.outerHTML = login('replacement-'); await settle();
                check(!original.isConnected && events.at(-1) === field('replacement-user'), 'SPA replacement retained stale anchor');
                history.replaceState(null, '', '/news');
            });
            await run('window scroll selects only fields visible in the viewport', async () => {
                fixture('<div style="height:1400px"></div><input id="password" type="password"><div style="height:1000px"></div>');
                const events = [];
                watch(value => events.push(value));
                check(events.at(-1) === undefined, 'Offscreen field anchored');
                window.scrollTo(0, 1250); await settle(5);
                check(events.at(-1) === field('password'), 'Scrolling login into view not detected');
                window.scrollTo(0, 0); await settle(5);
                check(events.at(-1) === undefined, 'Scrolling login away retained anchor');
            });
            await run('nested scroll clipping is considered and captured scroll events refresh it', async () => {
                fixture('<div id="scroller" style="height:100px;overflow:auto"><div style="height:300px"></div><input id="password" type="password"></div>');
                const events = [];
                watch(value => events.push(value));
                check(events.at(-1) === undefined, 'Clipped field anchored');
                field('scroller').scrollTop = 300; await settle(5);
                check(events.at(-1) === field('password'), 'Nested scrolling into view not detected');
                field('scroller').scrollTop = 0; await settle(5);
                check(events.at(-1) === undefined, 'Nested scrolling out of view retained anchor');
            });
            await run('layout movement updates anchor geometry; own UI style writes settle', async () => {
                fixture('<input id="password" type="password"><div id="host" style="position:fixed"></div>');
                const input = field('password');
                const host = field('host');
                let callbacks = 0, frames = 0;
                const original = window.requestAnimationFrame;
                window.requestAnimationFrame = callback => { frames++; return nativeFrame(callback); };
                try {
                    watch(value => {
                        callbacks++;
                        host.style.top = `${value?.getBoundingClientRect().top ?? 0}px`;
                        host.style.left = `${callbacks}px`;
                    });
                    await settle(6);
                    check(callbacks === 1 && frames <= 2, 'UI style writes triggered a notification loop');
                    input.style.marginTop = '40px'; await settle(6);
                    check(callbacks === 2 && frames <= 4, 'Geometry change did not settle after one notification');
                } finally { window.requestAnimationFrame = original; }
            });
            await run('mutation and resize bursts batch into one animation frame', async () => {
                fixture('<input id="password" type="password">');
                let frames = 0, callbacks = 0;
                const original = window.requestAnimationFrame;
                window.requestAnimationFrame = callback => { frames++; return nativeFrame(callback); };
                try {
                    watch(() => callbacks++);
                    for (let i = 0; i < 25; i++) {
                        field('password').dataset.counter = String(i);
                        window.dispatchEvent(new Event('resize'));
                        window.dispatchEvent(new Event('scroll'));
                    }
                    await settle();
                    check(frames === 1 && callbacks === 1, 'Events were not batched or unchanged anchor was reemitted');
                } finally { window.requestAnimationFrame = original; }
            });
            await run('stop disconnects observer, removes every listener and cancels pending frame', async () => {
                fixture('<input id="password" type="password">');
                const adds = [], removes = [], restores = [];
                let callbacks = 0, frames = 0, cancels = 0;
                const originalFrame = window.requestAnimationFrame;
                const originalCancel = window.cancelAnimationFrame;
                try {
                    for (const target of [document, window, window.visualViewport].filter(Boolean)) {
                        for (const [method, records] of [['addEventListener', adds], ['removeEventListener', removes]]) {
                            const original = target[method];
                            target[method] = function (...args) { records.push([target, ...args]); return original.apply(this, args); };
                            restores.push(() => { target[method] = original; });
                        }
                    }
                    window.requestAnimationFrame = callback => { frames++; return nativeFrame(callback); };
                    window.cancelAnimationFrame = id => { cancels++; originalCancel.call(window, id); };
                    const stop = watch(() => callbacks++);
                    window.dispatchEvent(new Event('resize'));
                    check(frames === 1, 'No pending frame scheduled');
                    stop();
                    check(cancels === 1 && adds.length === removes.length, 'Frame or listener cleanup missing');
                    check(adds.every(add => removes.some(remove => add.every((value, index) => value === remove[index]))), 'Listener/capture mismatch during cleanup');
                    field('password').disabled = true;
                    window.dispatchEvent(new Event('resize'));
                    window.dispatchEvent(new Event('scroll'));
                    document.dispatchEvent(new Event('focusin'));
                    window.visualViewport?.dispatchEvent(new Event('resize'));
                    await settle();
                    check(callbacks === 1 && frames === 1, 'Stopped watcher continued observing');
                    stop();
                } finally {
                    for (const restore of restores) restore();
                    window.requestAnimationFrame = originalFrame;
                    window.cancelAnimationFrame = originalCancel;
                }
            });
            await run('throwing initial callback cleans up before propagating the error', async () => {
                fixture('<input id="password" type="password">');
                let calls = 0;
                try {
                    watchLoginFields(() => { calls++; throw new Error('fixture callback failed'); });
                    throw new Error('Callback error swallowed');
                } catch (error) { check(error.message === 'fixture callback failed', 'Wrong initial callback error'); }
                field('password').disabled = true;
                window.dispatchEvent(new Event('resize'));
                await settle();
                check(calls === 1, 'Throwing callback left a live watcher');
            });
            return results;
        }, source);

        try {
            await page.evaluate(() => {
                document.body.innerHTML = '<input type="password" style="position:fixed;top:650px;left:20px;width:200px;height:30px">';
                window.loginFieldResizeEvents = [];
                window.stopLoginFieldResize = window.loginFieldTestAPI.watchLoginFields(field => window.loginFieldResizeEvents.push(Boolean(field)));
            });
            assert.equal(await page.evaluate(() => window.loginFieldResizeEvents.at(-1)), true);
            await page.setViewportSize({ width: 900, height: 500 });
            await page.waitForFunction(() => window.loginFieldResizeEvents.at(-1) === false);
            await page.setViewportSize({ width: 900, height: 720 });
            await page.waitForFunction(() => window.loginFieldResizeEvents.at(-1) === true);
            cases.push({ name: 'real viewport resize hides and restores the login anchor', passed: true });
        } catch (error) {
            cases.push({ name: 'real viewport resize hides and restores the login anchor', passed: false, error: String(error.message || error) });
        } finally { await page.evaluate(() => window.stopLoginFieldResize?.()); }

        report.engines[name] = cases;
        for (const test of cases) console.log(`${test.passed ? 'PASS' : 'FAIL'} ${name}: ${test.name}${test.error ? ` — ${test.error}` : ''}`);
        await context.close();
    } finally { await browser.close(); }
}
const resultsPath = process.env.LOGIN_FIELD_RESULTS || path.join(os.tmpdir(), 'keewebx-userscripts-login-field-results.json');
await writeFile(resultsPath, JSON.stringify(report, null, 2) + '\n');
const all = Object.values(report.engines).flat();
console.log(`${all.filter(test => test.passed).length}/${all.length} browser cases passed; results: ${resultsPath}`);
assert(all.length > 0 && all.every(test => test.passed), 'Login field browser regression failed');
