// Disjoint browser regressions: compile the real source, never copy its implementation.
// Repro: node modules/extension/userscript/tests/form-guards.mjs chromium webkit
// Optional overrides: FORM_GUARD_REPO, FORM_GUARD_BUN, FORM_GUARD_CHROMIUM,
// FORM_GUARD_WEBKIT, FORM_GUARD_WEBKIT_LIB, FORM_GUARD_RESULTS. No repository
// writes or real credentials.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = process.env.FORM_GUARD_REPO || fileURLToPath(new URL('../../../../', import.meta.url));
const bun = process.env.FORM_GUARD_BUN || 'bun';
const require = createRequire(path.join(repo, 'package.json'));
const { chromium, webkit } = require('@playwright/test');
const engines = process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'webkit'];
assert(engines.every(name => ['chromium', 'webkit'].includes(name)), 'Use chromium and/or webkit');
const inputs = [
    'modules/extension/userscript/src/form-targets.ts',
    'modules/extension/src/content/form-fill.ts'
];
const hashes = async () => Object.fromEntries(await Promise.all(inputs.map(async file => [
    file, createHash('sha256').update(await readFile(path.join(repo, file))).digest('hex')
])));
const sourceHashes = await hashes();
const moduleSource = execFileSync(bun, ['-e', `
    const result = await Bun.build({
        entrypoints: ['modules/extension/userscript/src/form-targets.ts'],
        target: 'browser', format: 'esm', minify: false, sourcemap: 'none'
    });
    if (!result.success) throw new AggregateError(result.logs, 'Actual form helper build failed');
    await Bun.write(Bun.stdout, await result.outputs[0].text());
`], { cwd: repo, encoding: 'utf8', maxBuffer: 2 ** 20 });
assert.deepEqual(await hashes(), sourceHashes, 'Source changed during bundling; rerun');

const report = { sourceHashes, fixture: 'https://form-guard.example/login', engines: {}, nativeIOS: false };
for (const name of engines) {
    const type = { chromium, webkit }[name];
    const candidate = name === 'chromium'
        ? process.env.FORM_GUARD_CHROMIUM
        : process.env.FORM_GUARD_WEBKIT;
    const webkitLib = process.env.FORM_GUARD_WEBKIT_LIB;
    const browser = await type.launch({
        headless: true,
        ...((candidate && existsSync(candidate)) ? { executablePath: candidate } : {}),
        ...(name === 'webkit' && (webkitLib && existsSync(webkitLib)) ? {
            env: { ...process.env, LD_LIBRARY_PATH: [webkitLib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') }
        } : {})
    });
    try {
        const context = await browser.newContext();
        await context.route('https://form-guard.example/**', route => route.fulfill({
            contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>Form guard regression fixture</title>'
        }));
        const page = await context.newPage();
        await page.goto(report.fixture);
        const cases = await page.evaluate(async source => {
            const blob = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
            const { targets, fill, matchesOrigin } = await import(blob);
            URL.revokeObjectURL(blob);
            const results = [];
            const check = (condition, detail) => { if (!condition) throw new Error(detail); };
            const fixture = () => {
                history.replaceState(null, '', '/login');
                document.body.innerHTML = `<style>input{display:block;width:200px;height:30px;margin:8px}</style>
                    <form id="login"><input id="user" autocomplete="username"><input id="password" type="password" autocomplete="current-password"></form>
                    <form id="other"></form>`;
                const user = document.querySelector('#user');
                const password = document.querySelector('#password');
                return { user, password, target: targets(user), other: document.querySelector('#other') };
            };
            const expectStopped = action => {
                let error;
                try { action(); } catch (caught) { error = caught; }
                check(error instanceof Error, 'Expected the real helper to reject the changed destination/lifetime');
                return error;
            };
            const run = (name, test) => {
                try { test(); results.push({ name, passed: true }); }
                catch (error) { results.push({ name, passed: false, error: String(error.message || error) }); }
            };
            const values = { user: 'fixture-user', password: 'fixture-password' };

            run('username input handler changes history href: password stays empty', () => {
                const { user, password, target } = fixture();
                user.addEventListener('input', () => history.pushState(null, '', '/changed-by-input'));
                expectStopped(() => fill(target, values));
                check(location.pathname === '/changed-by-input', 'History mutation did not execute');
                check(user.value === values.user && password.value === '', 'Password was written after URL change');
            });
            run('username change handler removes/replaces password: neither receives password', () => {
                const { user, password, target } = fixture();
                const replacement = document.createElement('input'); replacement.type = 'password';
                user.addEventListener('change', () => password.replaceWith(replacement));
                expectStopped(() => fill(target, values));
                check(!password.isConnected && replacement.isConnected, 'Replacement handler did not execute');
                check(password.value === '' && replacement.value === '', 'Detached/replacement password was filled');
            });
            run('username input handler reparents password to another form: password stays empty', () => {
                const { user, password, target, other } = fixture();
                user.addEventListener('input', () => other.append(password));
                expectStopped(() => fill(target, values));
                check(password.isConnected && password.form === other, 'Password was not reparented');
                check(password.value === '', 'Password was written into the changed form');
            });
            run('username change handler retypes password: password stays empty', () => {
                const { user, password, target } = fixture();
                user.addEventListener('change', () => { password.type = 'text'; });
                expectStopped(() => fill(target, values));
                check(password.type === 'text' && password.value === '', 'Retyped password was filled');
            });
            run('lifetime validator expires during username input: second live check stops password', () => {
                const { user, password, target } = fixture();
                let live = true, checks = 0;
                user.addEventListener('input', () => { live = false; });
                const error = expectStopped(() => fill(target, values, () => {
                    checks++; if (!live) throw new Error('fixture-operation-expired');
                }));
                check(checks === 2 && error.message === 'fixture-operation-expired', 'Missing post-username live check');
                check(user.value === values.user && password.value === '', 'Expired operation wrote password');
            });
            run('missing requested password rejects before any write or input/change event', () => {
                const { user, password, target } = fixture();
                let events = 0;
                for (const element of [user, password]) for (const name of ['input', 'change']) {
                    element.addEventListener(name, () => events++);
                }
                expectStopped(() => fill(target, { user: values.user }));
                check(user.value === '' && password.value === '' && events === 0, 'Missing password caused a partial fill');
            });
            run('valid fill uses native value setters and real DOM input/change dispatch in order', () => {
                const { user, password, target } = fixture();
                const events = [];
                const getter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').get;
                for (const element of [user, password]) {
                    Object.defineProperty(element, 'value', {
                        configurable: true, get() { return getter.call(this); },
                        set() { throw new Error('Per-element value setter must be bypassed'); }
                    });
                    element.addEventListener('input', event => {
                        check(event instanceof InputEvent && event.bubbles, 'Expected a bubbling DOM InputEvent');
                        check(event.inputType === 'insertFromPaste', 'Unexpected inputType');
                        check(event.data === (element === user ? values.user : values.password), 'Unexpected input event data');
                        events.push(`${element.id}:input`);
                    });
                    element.addEventListener('change', event => { check(event.bubbles, 'Change must bubble'); events.push(`${element.id}:change`); });
                }
                let liveChecks = 0;
                fill(target, values, () => { liveChecks++; });
                check(user.value === values.user && password.value === values.password, 'Valid values not written');
                check(liveChecks === 2, 'Expected a live check before each field');
                check(events.join(',') === 'user:input,user:change,password:input,password:change', 'Wrong DOM event ordering');
            });
            run('HTTPS account matching permits only the www alias and rejects scheme/host/port/userinfo confusion', () => {
                const origin = 'https://form-guard.example';
                const rows = [
                    ['https://form-guard.example/login', origin, true],
                    ['https://FORM-GUARD.example:443/other', origin, true],
                    ['form-guard.example/path', origin, true],
                    ['https://www.form-guard.example/login', origin, true],
                    ['form-guard.example', 'https://www.form-guard.example', true],
                    ['https://form-guard.example:8443/path', 'https://form-guard.example:8443', true],
                    ['http://form-guard.example/login', origin, false],
                    ['https://form-guard.example:8443/login', origin, false],
                    ['https://sub.form-guard.example/login', origin, false],
                    ['https://form-guard.example.evil.test/login', origin, false],
                    ['https://evil.test/?next=https://form-guard.example', origin, false],
                    ['https://name:secret@form-guard.example/login', origin, false],
                    ['https://form-guard.example@evil.test/login', origin, false],
                    ['javascript:alert(1)', origin, false],
                    ['not a valid URL', origin, false]
                ];
                for (const [url, destination, expected] of rows) {
                    check(matchesOrigin(url, destination) === expected, `Origin policy mismatch for ${url}`);
                }
            });
            return results;
        }, moduleSource);
        report.engines[name] = cases;
        for (const test of cases) console.log(`${test.passed ? 'PASS' : 'FAIL'} ${name}: ${test.name}${test.error ? ` — ${test.error}` : ''}`);
        await context.close();
    } finally { await browser.close(); }
}
const resultsPath = process.env.FORM_GUARD_RESULTS || path.join(os.tmpdir(), 'keewebx-userscripts-form-guard-results.json');
await writeFile(resultsPath, JSON.stringify(report, null, 2) + '\n');
const all = Object.values(report.engines).flat();
console.log(`${all.filter(test => test.passed).length}/${all.length} browser cases passed; results: ${resultsPath}`);
assert(all.length > 0 && all.every(test => test.passed), 'Browser form guard regression failed');
