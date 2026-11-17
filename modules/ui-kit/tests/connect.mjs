// Build the actual shared Preact components; no GM APIs or userscript adapter.
// Repro: node modules/ui-kit/tests/connect.mjs chromium webkit
// CONNECT_COMPONENT_RESULTS selects the JSON report (relative to the caller's cwd).
// Optional CONNECT_COMPONENT_BUN, CONNECT_COMPONENT_REPO, CONNECT_COMPONENT_CHROMIUM,
// CONNECT_COMPONENT_WEBKIT and CONNECT_COMPONENT_WEBKIT_LIB override local tools.
// KWX_* and FORM_GUARD_* tool overrides are also accepted, as in form-guards.mjs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(process.env.CONNECT_COMPONENT_REPO || process.env.KWX_REPO_ROOT ||
    process.env.FORM_GUARD_REPO || fileURLToPath(new URL('../../../', import.meta.url)));
const bun = process.env.CONNECT_COMPONENT_BUN || process.env.KWX_BUN || process.env.FORM_GUARD_BUN ||
    (typeof Bun !== 'undefined' ? process.execPath : 'bun');
const require = createRequire(path.join(repo, 'modules/ui-kit/package.json'));
const engines = process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'webkit'];
const resultsPath = path.resolve(process.env.CONNECT_COMPONENT_RESULTS ||
    path.join(os.tmpdir(), 'keewebx-connect-component-results.json'));
const inputs = ['index.ts', 'panel.tsx', 'account-list.tsx', 'connection-settings.tsx',
    'connection-status.tsx', 'diagnostics-settings.tsx', 'styles.ts', 'types.ts'].map(file => `modules/ui-kit/src/connect/${file}`);
const hashes = async () => Object.fromEntries(await Promise.all(inputs.map(async file => [
    file, createHash('sha256').update(await readFile(path.join(repo, file))).digest('hex')
])));
const report = {
    passed: false,
    sourceHashes: {},
    bundleBytes: 0,
    hosts: ['normal DOM with page styles', 'Shadow DOM'],
    modes: ['website', 'app', 'relay'],
    widths: [320, 390, 1280],
    themes: ['light', 'dark'],
    engines: {},
    errors: []
};

async function run() {
    assert(engines.every(name => ['chromium', 'webkit'].includes(name)), 'Use chromium and/or webkit');
    const browsers = require('@playwright/test');
    report.sourceHashes = await hashes();
    const previewSource = `
        import {h, render} from ${JSON.stringify(path.dirname(require.resolve('preact/package.json')))};
        import {ConnectPanel, connectStyles} from ${JSON.stringify(path.join(repo, inputs[0]))};
        globalThis.connectPreview = {
            css: connectStyles,
            render: (props, host) => render(h(ConnectPanel, props), host)
        };
    `;
    const bundle = execFileSync(bun, ['-e', `
        const result = await Bun.build({
            entrypoints: ['virtual:connect-preview'],
            target: 'browser', format: 'iife', write: false, sourcemap: 'none',
            plugins: [{ name: 'connect-preview', setup(builder) {
                builder.onResolve({ filter: /^virtual:connect-preview$/ }, () => ({
                    path: 'preview.tsx', namespace: 'preview'
                }));
                builder.onLoad({ filter: /.*/, namespace: 'preview' }, () => ({
                    loader: 'tsx', contents: ${JSON.stringify(previewSource)}
                }));
            }}]
        });
        if (!result.success) throw new AggregateError(result.logs, 'Shared Connect component build failed');
        await Bun.write(Bun.stdout, await result.outputs[0].text());
    `], { cwd: repo, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
    assert.deepEqual(await hashes(), report.sourceHashes, 'Shared source changed during bundling; rerun');
    report.bundleBytes = Buffer.byteLength(bundle);

    for (const engine of engines) {
        const executablePath = engine === 'chromium'
            ? process.env.CONNECT_COMPONENT_CHROMIUM || process.env.KWX_CHROMIUM_EXECUTABLE || process.env.FORM_GUARD_CHROMIUM
            : process.env.CONNECT_COMPONENT_WEBKIT || process.env.KWX_WEBKIT_EXECUTABLE || process.env.FORM_GUARD_WEBKIT;
        const webkitLib = process.env.CONNECT_COMPONENT_WEBKIT_LIB || process.env.KWX_WEBKIT_LIB || process.env.FORM_GUARD_WEBKIT_LIB;
        const cases = report.engines[engine] = [];
        const browser = await browsers[engine].launch({
            headless: true,
            ...(executablePath ? { executablePath } : {}),
            ...(engine === 'webkit' && webkitLib ? {
                env: { ...process.env, LD_LIBRARY_PATH: [webkitLib, process.env.LD_LIBRARY_PATH].filter(Boolean).join(path.delimiter) }
            } : {})
        });
        try {
            for (const shadow of [false, true]) for (const colorScheme of report.themes) for (const width of report.widths) {
                const scenario = { host: shadow ? 'shadow' : 'normal', colorScheme, width };
                const context = await browser.newContext({ viewport: { width, height: 844 }, colorScheme });
                try {
                    const page = await context.newPage();
                    const pageErrors = [];
                    page.on('pageerror', error => pageErrors.push(error.message));
                    await page.setContent(`<!doctype html><meta charset="utf-8"><title>Shared Connect component fixture</title>
                        <style>
                            body{margin:0}
                            section{position:fixed;padding:60px;background:red;border:8px dotted purple}
                            button{font:30px serif;letter-spacing:4px;border-width:5px}
                            input{height:72px}div{display:grid}h2{text-transform:uppercase}
                        </style>
                        <button id="outside" type="button">Outside</button>
                        <div id="host" style="position:fixed;right:12px;bottom:12px"></div>`);
                    await page.addScriptTag({ content: bundle });
                    await page.evaluate(({ shadow }) => {
                        const host = document.querySelector('#host');
                        const mount = shadow ? host.attachShadow({ mode: 'open' }) : host;
                        const style = document.createElement('style');
                        style.textContent = window.connectPreview.css;
                        mount.append(style);
                        const target = document.createElement('div');
                        mount.append(target);
                        window.target = target;
                        window.events = [];
                        const action = (label, hidden = false, variant = 'secondary') => ({ label, hidden, variant });
                        window.state = {
                            mode: 'website', open: true, launcherVisible: true, tab: 'accounts', busy: false,
                            status: 'Connected', message: 'Connected to KeeWebX.',
                            address: 'https://keewebx.app/app', addressReadOnly: false,
                            actions: {
                                lookup: action('Find accounts', false, 'primary'), save: action('Save address'),
                                open: action('Open KeeWebX'), probe: action('Test connection'),
                                authorize: action('Authorize Connect', true), return: action('Back to site', true),
                                revoke: action('Disconnect', true, 'danger'),
                                pair: action('Connect this tab', true, 'primary'), decline: action('Decline', true)
                            },
                            accounts: [
                                { id: '0', title: 'Personal <img src=x onerror="globalThis.escapeFailure=true">', username: 'person@example.org' },
                                { id: '1', title: 'Work account', username: 'work@example.org' }
                            ],
                            emptyMessage: 'No matching accounts.', note: 'The host supplies connection guidance.',
                            version: '0.4.10', diagnostics: ['Ready <script>globalThis.escapeFailure=true</script>', 'Example connection detail'],
                            autoFillSingle: false, preferencePending: false
                        };
                        window.redraw = (patch = {}) => {
                            window.state = { ...window.state, ...patch };
                            window.connectPreview.render({
                                state: window.state, idPrefix: 'preview',
                                panelStyle: window.state.mode === 'relay' ? undefined : {
                                    position: 'fixed', left: '12px', right: 'auto', top: '12px', bottom: 'auto',
                                    maxHeight: 'calc(100dvh - 24px)'
                                },
                                onAction: (name, event) => window.events.push(['action', name, event instanceof MouseEvent, event.isTrusted]),
                                onTab: (name, event) => window.events.push(['tab', name, event instanceof MouseEvent, event.isTrusted]),
                                onToggle: event => window.events.push(['toggle', event instanceof MouseEvent]),
                                onClose: event => window.events.push(['close', event instanceof Event]),
                                onAddressInput: (value, event) => window.events.push(['address', value, event instanceof Event]),
                                onAutoFillSingleChange: (value, event) => window.events.push(['preference', value, event instanceof Event]),
                                onDiagnosticsChange: (value, event) => window.events.push(['diagnostics', value, event instanceof Event, event.isTrusted]),
                                onSelectAccount: (id, event) => {
                                    window.accountFocusAtCallback = target.getRootNode().activeElement;
                                    window.events.push(['account', id, event instanceof MouseEvent, event.isTrusted]);
                                },
                                onPanelKeyDown: event => window.events.push(['key', event.key, event instanceof KeyboardEvent])
                            }, target);
                        };
                        document.querySelector('#outside').focus();
                        window.redraw();
                        window.initialFocusPreserved = document.activeElement === document.querySelector('#outside');
                    }, { shadow });

                    const verify = async (name, predicate) => {
                        const test = { name, ...scenario, passed: false };
                        try {
                            assert.equal(await page.evaluate(predicate), true, name);
                            assert.deepEqual(pageErrors, [], 'Unexpected browser error');
                            test.passed = true;
                        } catch (error) {
                            test.error = String(error.message || error);
                            throw error;
                        } finally {
                            cases.push(test);
                            console.log(`${test.passed ? 'PASS' : 'FAIL'} ${engine} ${scenario.host} ${colorScheme} ${width}: ${name}`);
                        }
                    };

                    await verify('selectors, status, escaped strings, default diagnostics', () => {
                        const root = window.target;
                        const names = ['toggle', 'close', 'accounts-tab', 'config-tab', 'save', 'open', 'authorize',
                            'return', 'revoke', 'lookup', 'probe', 'pair', 'decline', 'auto-fill-single', 'entry-0', 'entry-1'];
                        const dialog = root.querySelector('[role=dialog]');
                        return !('GM' in window) && !('GM_getValue' in window) && !window.escapeFailure &&
                            names.every(name => root.querySelector(`[data-action="${name}"]`)) &&
                            root.querySelectorAll('[role=status]').length === 1 &&
                            dialog.getAttribute('aria-describedby') === root.querySelector('[role=status]').id &&
                            dialog.getAttribute('aria-labelledby') === root.querySelector('h2').id &&
                            !root.querySelector('details').open && root.querySelector('[data-role=connection-diagnostics]') &&
                            root.querySelector('[data-role=entries]') && root.querySelector('[data-role=version]').textContent === '0.4.10' &&
                            root.querySelector('[data-action=entry-0]').textContent.includes('<img src=x') &&
                            root.querySelector('details').textContent.includes('<script>') &&
                            !root.querySelector('img,script') && !root.querySelector('[aria-modal]');
                    });
                    await verify('CSS scope, 44px controls, viewport, initial focus', () => {
                        const root = window.target;
                        const box = root.querySelector('[role=dialog]').getBoundingClientRect();
                        const controls = [...root.querySelectorAll('button,summary,.kwx-connect__check-label')]
                            .filter(element => element.getClientRects().length);
                        return window.initialFocusPreserved &&
                            getComputedStyle(document.querySelector('#outside')).letterSpacing === '4px' &&
                            getComputedStyle(root.querySelector('[data-action=lookup]')).letterSpacing === 'normal' &&
                            controls.every(element => element.getBoundingClientRect().height >= 44) &&
                            box.x >= 0 && box.right <= innerWidth && box.bottom <= innerHeight;
                    });
                    await page.locator('[data-action=entry-0]').click();
                    await page.evaluate(() => {
                        window.redraw({ message: 'Still connected to KeeWebX.' });
                        window.accountFocusPreserved = window.target.getRootNode().activeElement === window.accountFocusAtCallback;
                    });
                    await page.locator('[data-action=config-tab]').click();
                    await verify('trusted native account/tab events, controlled tabs, focus after rerender', () =>
                        window.accountFocusPreserved &&
                        window.events.some(event => event[0] === 'account' && event[1] === '0' && event[2] && event[3]) &&
                        window.events.some(event => event[0] === 'tab' && event[1] === 'config' && event[2] && event[3]) &&
                        !window.target.querySelector('#preview-accounts').hidden &&
                        window.target.querySelector('[data-action=accounts-tab]').getAttribute('aria-controls') === 'preview-accounts');
                    await page.evaluate(() => window.redraw({
                        tab: 'config', preferencePending: true, busy: true, preferenceError: 'Unable to save this preference.'
                    }));
                    await verify('pending and busy controls, preference alert, one status', () =>
                        ['lookup', 'probe', 'auto-fill-single', 'entry-0', 'entry-1']
                            .every(name => window.target.querySelector(`[data-action="${name}"]`).disabled) &&
                        window.target.querySelectorAll('[role=status]').length === 1 &&
                        window.target.querySelector('[role=alert]').textContent === 'Unable to save this preference.');
                    await page.evaluate(() => window.redraw({ preferencePending: false, busy: false, preferenceError: undefined }));
                    await page.locator('#preview-address').fill('https://changed.example.org/');
                    await page.locator('[data-action=auto-fill-single]').check();
                    await page.keyboard.press('Escape');
                    await verify('fresh enabled props, input, preference, keyboard delegates', () =>
                        ['lookup', 'probe', 'auto-fill-single', 'entry-0', 'entry-1']
                            .every(name => !window.target.querySelector(`[data-action="${name}"]`).disabled) &&
                        window.events.some(event => event[0] === 'address' && event[1] === 'https://changed.example.org/' && event[2]) &&
                        window.events.some(event => event[0] === 'preference' && event[1] === true && event[2]) &&
                        window.events.some(event => event[0] === 'key' && event[1] === 'Escape' && event[2]));
                    await page.evaluate(() => window.redraw({ mode: 'app', tab: 'accounts', addressReadOnly: false }));
                    await verify('app config only and readonly address', () =>
                        window.target.querySelector('[data-action=accounts-tab]').hidden &&
                        window.target.querySelector('#preview-accounts').hidden &&
                        !window.target.querySelector('#preview-config').hidden &&
                        window.target.querySelector('#preview-address').readOnly);
                    await page.evaluate(() => window.redraw({ remoteDiagnostics: {
                        enabled: true, id: '11111111-2222-4333-8444-555555555555',
                        expiresAt: Date.now() + 3600000, status: 'connected'
                    } }));
                    await page.locator('[data-action=diagnostics-enabled]').uncheck();
                    await verify('controlled remote diagnostics, trusted stop, no secret token', () => {
                        const root = window.target;
                        const panel = root.querySelector('[role=dialog]').getBoundingClientRect();
                        return root.querySelector('[data-role=diagnostics-id]').textContent === '11111111-2222-4333-8444-555555555555' &&
                            root.querySelector('[data-role=remote-diagnostics]').textContent.includes('read-only') &&
                            !root.querySelector('[data-role=remote-diagnostics]').textContent.includes('token') &&
                            window.events.some(event => event[0] === 'diagnostics' && event[1] === false && event[2] && event[3]) &&
                            panel.right <= innerWidth && panel.bottom <= innerHeight;
                    });
                    await page.evaluate(() => window.redraw({ mode: 'relay' }));
                    await verify('relay hides launcher, close and tabs; panel centered', () => {
                        const root = window.target;
                        const box = root.querySelector('[role=dialog]').getBoundingClientRect();
                        return ['toggle', 'close'].every(name => root.querySelector(`[data-action="${name}"]`).hidden) &&
                            root.querySelector('[role=tablist]').hidden &&
                            Math.abs(box.x + box.width / 2 - innerWidth / 2) < 1 &&
                            Math.abs(box.y + box.height / 2 - innerHeight / 2) < 1;
                    });
                    await page.evaluate(() => window.redraw({ open: false }));
                    await verify('closed panel uses hidden', () => window.target.querySelector('[role=dialog]').hidden);
                } finally {
                    await context.close();
                }
            }
            assert.equal(cases.length, 108, `Expected 108 component cases for ${engine}`);
        } finally {
            await browser.close();
        }
    }
    report.passed = true;
}

try {
    await run();
} catch (error) {
    report.errors.push(String(error.stack || error));
    console.error(error);
    process.exitCode = 1;
} finally {
    await mkdir(path.dirname(resultsPath), { recursive: true });
    await writeFile(resultsPath, JSON.stringify(report, null, 2) + '\n');
    const all = Object.values(report.engines).flat();
    console.log(`${all.filter(test => test.passed).length}/${all.length} browser cases passed; results: ${resultsPath}`);
}
