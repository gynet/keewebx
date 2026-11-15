// ==UserScript==
// @name         KeeWebX background connection probe
// @namespace    https://keewebx.app/
// @version      0.1.0
// @description  Test Userscripts cross-tab replies. Sends random probes only; never accesses a database or passwords.
// @match        https://*/*
// @noframes
// @run-at       document-idle
// @inject-into  content
// @grant        GM.getValue
// @grant        GM.setValue
// @grant        GM.deleteValue
// @grant        GM.listValues
// ==/UserScript==

(() => {
    'use strict';

    const PREFIX = 'keewebx-background-probe-v1:';
    const ACTIVE = `${PREFIX}active`;
    const REQUEST = `${PREFIX}request:`;
    const RESPONSE = `${PREFIX}response:`;
    const POLL_MS = 500;
    const NOTICE_MS = 8000;
    const LIFETIME_MS = 120000;
    const APP_ORIGIN = 'https://keewebx.app';
    const app = location.origin === APP_ORIGIN && /^\/app\/?$/.test(location.pathname);
    // The diagnostic does not add controls to the landing page or Classic UI.
    if (location.origin === APP_ORIGIN && !app) return;
    if (window.top !== window) return;

    const boot = crypto.randomUUID();
    let generation = 0;
    let running = false;
    let pending;
    const delay = () => new Promise(resolve => setTimeout(resolve, POLL_MS));
    const message = error => error instanceof Error ? error.message : String(error);
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const validId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
    const fresh = value => object(value) && Number.isFinite(value.createdAt) &&
        Number.isFinite(value.expiresAt) && value.createdAt <= Date.now() + 5000 &&
        value.expiresAt > Date.now() && value.expiresAt > value.createdAt &&
        value.expiresAt - value.createdAt <= LIFETIME_MS;

    const host = document.createElement('div');
    host.id = 'keewebx-background-probe';
    host.style.cssText = 'position:fixed;right:10px;bottom:calc(10px + env(safe-area-inset-bottom, 0px));z-index:2147483647;';
    // No credentials are present in this diagnostic UI or its open shadow tree.
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = ':host{all:initial;font:14px system-ui;color:#172033}button{font:inherit;min-height:40px;padding:8px 12px;border:1px solid #aebbd0;border-radius:9px;background:#f3f7ff;color:#172033;cursor:pointer}button:disabled{opacity:.6}section{box-sizing:border-box;width:min(320px,calc(100vw - 20px));padding:12px;background:#fff;border:1px solid #aebbd0;border-radius:12px;box-shadow:0 4px 20px #0003;margin-bottom:8px}section[hidden]{display:none}h2{font-size:15px;margin:0 0 8px}p{font-size:13px;line-height:1.4;overflow-wrap:anywhere}footer{display:flex;gap:8px}';
    shadow.append(style);
    const panel = document.createElement('section');
    panel.hidden = true;
    const title = document.createElement('h2');
    title.textContent = 'KeeWebX connection probe';
    const help = document.createElement('p');
    help.textContent = app
        ? 'Start here, leave this original tab open, then test from another website. No database access.'
        : 'Start the probe in the original keewebx.app/app tab first. This test sends no passwords.';
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = 'Not started.';
    const footer = document.createElement('footer');
    const action = document.createElement('button');
    action.type = 'button';
    action.textContent = app ? 'Start on this tab' : 'Test connection';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    footer.append(action, close);
    panel.append(title, help, status, footer);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.textContent = 'KeeWebX probe';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.onclick = () => {
        panel.hidden = !panel.hidden;
        toggle.setAttribute('aria-expanded', String(!panel.hidden));
    };
    close.onclick = () => {
        panel.hidden = true;
        toggle.setAttribute('aria-expanded', 'false');
        toggle.focus();
    };
    shadow.append(panel, toggle);
    document.body.append(host);

    async function removeRequest(id) {
        await Promise.all([GM.deleteValue(`${REQUEST}${id}`), GM.deleteValue(`${RESPONSE}${id}`)]);
    }

    async function respond(epoch) {
        const selected = await GM.getValue(ACTIVE);
        if (epoch !== generation || !running) return;
        if (!object(selected) || selected.broker !== boot) {
            running = false;
            action.textContent = 'Start on this tab';
            status.textContent = 'Another KeeWebX tab now owns the probe. This tab stopped.';
            return;
        }
        const keys = await GM.listValues();
        let count = 0;
        for (const key of keys) {
            if (epoch !== generation || !running) return;
            if (!key.startsWith(REQUEST) && !key.startsWith(RESPONSE)) continue;
            if (++count > 256) break;
            const value = await GM.getValue(key);
            if (!fresh(value)) {
                await GM.deleteValue(key);
                continue;
            }
            if (!key.startsWith(REQUEST) || !validId(value.id) || key !== `${REQUEST}${value.id}` ||
                !validId(value.nonce) || value.broker !== boot || value.kind !== 'probe-request') continue;
            // Recheck lifetime after asynchronous GM calls and after a suspended tab resumes.
            if (epoch !== generation || !running || !fresh(value)) return;
            await GM.setValue(`${RESPONSE}${value.id}`, {
                kind: 'probe-response', id: value.id, nonce: value.nonce, broker: boot,
                createdAt: value.createdAt, expiresAt: value.expiresAt,
                repliedAt: Date.now(), visibility: document.visibilityState
            });
            await GM.deleteValue(key);
        }
    }

    async function start() {
        running = true;
        const epoch = ++generation;
        await GM.setValue(ACTIVE, { broker: boot, startedAt: Date.now() });
        action.textContent = 'Stop probe';
        status.textContent = 'Ready. Keep this original tab open and test from another website.';
        while (running && generation === epoch) {
            await respond(epoch);
            if (running && generation === epoch) await delay();
        }
    }

    async function stop() {
        running = false;
        generation++;
        const selected = await GM.getValue(ACTIVE);
        if (object(selected) && selected.broker === boot) await GM.deleteValue(ACTIVE);
        action.textContent = 'Start on this tab';
        status.textContent = 'Stopped.';
    }

    async function test() {
        const selected = await GM.getValue(ACTIVE);
        if (!object(selected) || !validId(selected.broker)) {
            status.textContent = 'Open the original keewebx.app/app tab and start the probe there first.';
            return;
        }
        const createdAt = Date.now();
        const request = {
            kind: 'probe-request', id: crypto.randomUUID(), nonce: crypto.randomUUID(),
            broker: selected.broker, createdAt, expiresAt: createdAt + LIFETIME_MS
        };
        pending = request.id;
        action.disabled = true;
        status.textContent = 'Waiting for the original KeeWebX tab…';
        try {
            await GM.setValue(`${REQUEST}${request.id}`, request);
            while (pending === request.id && Date.now() < request.expiresAt) {
                const reply = await GM.getValue(`${RESPONSE}${request.id}`);
                if (object(reply)) {
                    if (fresh(reply) && reply.kind === 'probe-response' && reply.id === request.id &&
                        reply.broker === request.broker && reply.nonce === request.nonce &&
                        reply.createdAt === request.createdAt && reply.expiresAt === request.expiresAt &&
                        Number.isFinite(reply.repliedAt) && reply.repliedAt >= createdAt &&
                        reply.repliedAt <= Date.now() + 5000 &&
                        ['visible', 'hidden'].includes(reply.visibility)) {
                        const elapsed = Math.max(0, reply.repliedAt - createdAt);
                        status.textContent = `Reply received in ${elapsed} ms. KeeWebX tab was ${reply.visibility} when replying. This proves a probe reply, not password autofill.`;
                        return;
                    }
                    await GM.deleteValue(`${RESPONSE}${request.id}`);
                }
                if (Date.now() - createdAt >= NOTICE_MS) {
                    status.textContent = 'No reply yet. Switch to the original KeeWebX tab, then return here. The request stays queued for up to 2 minutes.';
                }
                await delay();
            }
            status.textContent = pending === request.id
                ? 'Request expired. Return to KeeWebX, start the probe again, and retry.'
                : 'Test canceled.';
        } finally {
            if (pending === request.id) pending = undefined;
            action.disabled = false;
            await removeRequest(request.id);
        }
    }

    action.onclick = () => {
        const operation = app ? (running ? stop() : start()) : test();
        operation.catch(error => {
            if (app) {
                running = false;
                generation++;
                action.textContent = 'Start on this tab';
            }
            status.textContent = `Probe error: ${message(error)}`;
        });
    };

    addEventListener('pagehide', () => {
        // Unload/BFCache is not a dependable cleanup mechanism; expiry handles leftovers.
        running = false;
        generation++;
        pending = undefined;
    });
    addEventListener('pageshow', event => {
        if (event.persisted) {
            action.disabled = false;
            action.textContent = app ? 'Start on this tab' : 'Test connection';
            status.textContent = 'Page restored. Start a new probe; the previous test was canceled.';
        }
    });
})();
