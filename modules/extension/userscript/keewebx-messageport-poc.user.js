// ==UserScript==
// @name         KeeWebX MessagePort Lab
// @namespace    https://keewebx.app/labs/
// @version      0.1.0
// @description  Test independent website ports to one KeeWebX tab after closing the temporary connection page. Synthetic messages only.
// @match        https://*/*
// @noframes
// @run-at       document-idle
// @inject-into  content
// @grant        GM.getValue
// @grant        GM.setValue
// ==/UserScript==

(() => {
    'use strict';
    const APP_URL = 'https://keewebx.app/app';
    const APP = new URL(APP_URL);
    const MARK = 'keewebx-port-lab-v1';
    const ROUTE = MARK + ':selected';
    const uuid = () => crypto.randomUUID();
    const validOrigin = value => {
        try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; } catch { return false; }
    };
    const validRoute = value => value && value.origin === APP.origin && typeof value.appBoot === 'string' && /^[0-9a-f-]{36}$/.test(value.appBoot);
    if (window.top !== window || location.protocol !== 'https:' || location.pathname.startsWith('/connect-port-poc/')) return;
    const isApp = location.origin === APP.origin && location.pathname.replace(/\/$/, '') === APP.pathname.replace(/\/$/, '');
    const host = document.createElement('div'); host.id = 'keewebx-port-poc';
    host.style.cssText = 'position:fixed;left:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:2147483646';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `:host{all:initial;font:14px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color-scheme:light dark;--bg:#fff;--ink:#17243a;--soft:#f1f5fb;--line:#dfe6ef;--muted:#61718a;--accent:#1769e0;color:var(--ink)}*{box-sizing:border-box}button{font:inherit;cursor:pointer;min-height:40px;border-radius:10px;border:1px solid var(--line);padding:9px 12px;background:var(--soft);color:var(--ink)}button:disabled{opacity:.45;cursor:default}button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.launcher,.primary{background:var(--accent);color:#fff;border-color:var(--accent)}section{position:absolute;bottom:50px;left:0;width:min(360px,calc(100vw - 24px));max-height:calc(100dvh - 100px);overflow:auto;border:1px solid var(--line);border-radius:18px;padding:16px;background:var(--bg);box-shadow:0 14px 48px #10244430}[hidden]{display:none!important}header{display:flex;align-items:center;justify-content:space-between;gap:12px}h2{font-size:17px;margin:0}header button{border:0;background:transparent;min-height:32px;padding:4px 9px;font-size:20px}.badge{font-size:10px;font-weight:700;letter-spacing:.07em;color:var(--accent);margin-top:4px}.note,.status,.detail{font-size:12px;line-height:1.55;overflow-wrap:anywhere;color:var(--muted)}.status{font-size:14px;color:var(--ink);margin:14px 0}.actions{display:flex;flex-wrap:wrap;gap:8px}.actions button{flex:1}.primary{flex-basis:100%!important}.detail{padding:10px;background:var(--soft);border-radius:10px;margin:12px 0}ol{font:11px/1.6 ui-monospace,monospace;max-height:145px;overflow:auto;padding-left:18px;color:var(--muted)}@media(prefers-color-scheme:dark){:host{--bg:#1d2532;--ink:#edf3fc;--soft:#283448;--line:#3b4a60;--muted:#a7b5cb;--accent:#438df2}}`;
    shadow.append(style);
    const element = (tag, text) => { const node = document.createElement(tag); if (text) node.textContent = text; return node; };
    const button = (label, action) => { const node = element('button', label); node.type = 'button'; node.dataset.action = action; return node; };
    const launcher = button('Port Lab', 'toggle'); launcher.className = 'launcher';
    const panel = element('section'); panel.hidden = true;
    const header = element('header'), title = element('div'), close = button('×', 'hide'); close.setAttribute('aria-label', 'Close panel');
    title.append(element('h2', 'MessagePort Lab'), element('div', 'TEST ONLY · 0.1.0')); title.lastChild.className = 'badge';
    header.append(title, close);
    const status = element('p', 'Loading test setup…'); status.className = 'status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    const note = element('p', 'Synthetic ping messages only. This test does not access your database, passwords, forms or production Connect settings.'); note.className = 'note';
    const detail = element('div', 'No test connection'); detail.className = 'detail'; detail.dataset.role = 'details';
    const actions = element('div'); actions.className = 'actions';
    const log = element('ol'); log.dataset.role = 'log';
    panel.append(header, note, status, actions, detail, log); shadow.append(panel, launcher); document.body.append(host);
    const state = text => { status.textContent = text; };
    const record = text => { const row = element('li', new Date().toLocaleTimeString() + ' · ' + text); log.prepend(row); while (log.childNodes.length > 16) log.lastChild.remove(); };
    launcher.onclick = event => { if (event.isTrusted) panel.hidden = !panel.hidden; };
    close.onclick = event => { if (event.isTrusted) panel.hidden = true; };
    const fail = error => state(error instanceof Error ? error.message : String(error));

    if (isApp) {
        const enable = button('Enable test receiver', 'enable'); enable.className = 'primary'; enable.disabled = true;
        const stop = button('Disable receiver', 'disable'); actions.append(enable, stop);
        const boot = uuid(); let enabled = false;
        const peers = new Map();
        const render = () => { detail.textContent = `${enabled ? 'Receiver enabled' : 'Receiver disabled'} · ${peers.size} attached port(s)${boot ? ' · App ' + boot.slice(0, 8) : ''}`; };
        const remove = id => { const peer = peers.get(id); if (peer) { peer.port.close(); peers.delete(id); render(); } };
        const selected = async () => { const route = await GM.getValue(ROUTE); return enabled && validRoute(route) && route.appBoot === boot; };
        enable.disabled = false; render(); state('Enable this tab once, then test from one or more websites. Re-enable after refreshing this App.');
        enable.onclick = async event => {
            if (!event.isTrusted || !boot) return;
            try { await GM.setValue(ROUTE, { origin: APP.origin, url: APP_URL, appBoot: boot }); enabled = true; render(); state('Ready. Open a website and choose Connect existing App in Port Lab.'); record('Receiver selected'); }
            catch (error) { fail(error); }
        };
        stop.onclick = event => { if (event.isTrusted) { enabled = false; for (const id of [...peers.keys()]) remove(id); render(); state('Receiver disabled. Existing test ports were closed.'); } };
        navigator.serviceWorker?.addEventListener('message', event => { void (async () => {
            if (event.source?.scriptURL !== new URL('/connect-port-poc/worker.js', APP.origin).href || event.data?.marker !== MARK || event.data.appBoot !== boot || !event.ports[0]) return;
            const port = event.ports[0];
            if (!await selected()) { port.close(); return; }
            if (event.data.kind === 'find-app') { port.postMessage({ marker: MARK, kind: 'app-ready', appBoot: boot }); port.close(); return; }
            const { connectionId, siteOrigin } = event.data;
            if (event.data.kind !== 'attach-port' || typeof connectionId !== 'string' || !validOrigin(siteOrigin) || peers.size >= 32) { port.close(); return; }
            remove(connectionId); peers.set(connectionId, { port, siteOrigin }); render(); record('Attached ' + siteOrigin);
            port.onmessage = message => {
                const data = message.data;
                if (!data || data.marker !== MARK || data.connectionId !== connectionId) return;
                if (data.kind === 'close') { remove(connectionId); return; }
                if (data.kind !== 'ping' || typeof data.sequence !== 'string' || data.sequence.length > 80) return;
                port.postMessage({ marker: MARK, kind: 'pong', connectionId, appBoot: boot, siteOrigin, sequence: data.sequence, visibility: document.visibilityState });
                record('Replied to ' + siteOrigin + ' · ' + data.sequence.slice(0, 8));
            };
            port.onmessageerror = () => remove(connectionId);
            port.start(); port.postMessage({ marker: MARK, kind: 'ready', connectionId, appBoot: boot, siteOrigin });
        })().catch(fail); });
        addEventListener('pagehide', () => { for (const id of [...peers.keys()]) remove(id); });
        return;
    }

    const connect = button('Connect existing App', 'connect'); connect.className = 'primary'; connect.disabled = true;
    const ping = button('Send ping', 'ping'), repeat = button('Repeat ×5', 'repeat'), disconnect = button('Disconnect', 'disconnect');
    actions.append(connect, ping, repeat, disconnect);
    let route, session, generation = 0, connecting = false;
    const pending = new Map();
    const buttons = () => { connect.disabled = connecting || !validRoute(route); ping.disabled = repeat.disabled = !session?.ready || connecting || pending.size > 0; };
    const reset = () => {
        generation++; connecting = false;
        if (session) { clearTimeout(session.timer); try { session.port.postMessage({ marker: MARK, kind: 'close', connectionId: session.id }); } catch {} session.port.close(); }
        session = undefined;
        for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Test connection stopped.')); } pending.clear(); buttons();
    };
    const load = async () => { route = await GM.getValue(ROUTE); buttons(); if (!session) state(validRoute(route) ? 'Ready to connect to your selected KeeWebX tab.' : 'First enable Port Lab in your existing KeeWebX tab.'); };
    void load().catch(fail);
    addEventListener('focus', () => { void load().catch(fail); });
    connect.onclick = event => {
        if (!event.isTrusted || !validRoute(route)) return;
        reset(); const epoch = generation, channel = new MessageChannel(), selectedRoute = { ...route };
        const current = { id: uuid(), nonce: uuid(), port: channel.port1, transfer: channel.port2, route: selectedRoute, ready: false, sent: false, helper: undefined, timer: undefined };
        session = current; connecting = true; buttons();
        current.port.onmessage = message => {
            if (session !== current || epoch !== generation) return;
            const data = message.data;
            if (!data || data.marker !== MARK) return;
            if (data.kind === 'error') { reset(); state(data.message || 'The original App did not accept the test connection.'); return; }
            if (data.connectionId !== current.id || data.appBoot !== selectedRoute.appBoot || data.siteOrigin !== location.origin) return;
            if (data.kind === 'ready') {
                clearTimeout(current.timer); current.ready = true; connecting = false;
                try { current.helper?.close(); } catch {}
                state('Connected directly to the original App. Closing the temporary connection page…');
                record('Port attached · App ' + data.appBoot.slice(0, 8)); buttons();
                setTimeout(() => { if (session === current) {
                    const closed = !current.helper || current.helper.closed;
                    detail.textContent = `App ${data.appBoot.slice(0, 8)} · Port ${current.id.slice(0, 8)} · Connection page ${closed ? 'closed' : 'still open'}`;
                    state(closed ? 'Connected. The connection page is closed; try repeated pings.' : 'Connected. Safari kept the connection page open. Close it manually, then try pings.');
                } }, 400);
            } else if (data.kind === 'pong') {
                const item = pending.get(data.sequence); if (!item) return;
                pending.delete(data.sequence); clearTimeout(item.timer); item.resolve({ milliseconds: Math.round((performance.now() - item.started) * 10) / 10, visibility: data.visibility }); buttons();
            }
        };
        current.port.onmessageerror = () => { if (session === current) { reset(); state('The port could not decode a message. Reconnect to the existing App.'); } };
        current.port.start();
        const url = new URL('/connect-port-poc/relay.html', APP.origin); url.searchParams.set('site', location.origin); url.searchParams.set('nonce', current.nonce);
        current.helper = window.open(url.href, 'KeeWebXPortLab:' + current.id);
        if (!current.helper) { reset(); state('Safari blocked the temporary connection page. Allow this test popup and retry.'); return; }
        state('Finding the original App and handing over a direct port…');
        current.timer = setTimeout(() => { if (session === current && !current.ready) { reset(); state('The App did not reply. Visit your original KeeWebX tab, enable its test receiver, then retry.'); } }, 15000);
    };
    addEventListener('message', event => {
        const current = session;
        if (!event.isTrusted || !current || current.sent || event.source !== current.helper || event.origin !== APP.origin || event.data?.marker !== MARK || event.data.kind !== 'relay-ready' || event.data.nonce !== current.nonce) return;
        current.sent = true;
        try { current.helper.postMessage({ marker: MARK, kind: 'attach', nonce: current.nonce, appBoot: current.route.appBoot, connectionId: current.id }, APP.origin, [current.transfer]); }
        catch (error) { reset(); fail(error); }
    });
    const sendPing = () => new Promise((resolve, reject) => {
        const current = session; if (!current?.ready) { reject(new Error('Connect the test port first.')); return; }
        const sequence = uuid();
        const timer = setTimeout(() => { pending.delete(sequence); buttons(); reject(new Error('The direct port did not reply. Visit the existing App, then reconnect if needed.')); }, 5000);
        pending.set(sequence, { resolve, reject, timer, started: performance.now() }); buttons();
        current.port.postMessage({ marker: MARK, kind: 'ping', connectionId: current.id, sequence });
    });
    const run = async count => { try {
        for (let i = 0; i < count; i++) { const result = await sendPing(); record('Pong ' + result.milliseconds + ' ms · App ' + result.visibility); state(`Success ${i + 1}/${count} · ${result.milliseconds} ms · direct port`); }
    } catch (error) { fail(error); } finally { buttons(); } };
    ping.onclick = event => { if (event.isTrusted) void run(1); };
    repeat.onclick = event => { if (event.isTrusted) void run(5); };
    disconnect.onclick = event => { if (event.isTrusted) { reset(); state('Test port disconnected. Your original App stays open.'); detail.textContent = 'No test connection'; } };
    addEventListener('pagehide', reset); buttons();
})();
