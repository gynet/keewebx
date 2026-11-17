'use strict';

const MARK = 'keewebx-connect-port-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BYTES = 2048;
const MAX_ACTIVE = 8;
const MAX_CANDIDATES = 32;
const PROBE_MS = 8000;
const PROBE_RETRY_MS = 750;
const MAX_PROBE_ATTEMPTS = 4;
const DIAGNOSTICS_MARK = 'keewebx-connect-diagnostics-v1';
const diagnostics = new Map();
const ATTACH_KEYS = ['marker', 'kind', 'nonce', 'appBoot', 'connectionId', 'endpoint', 'siteOrigin'];
const APP_PATHS = new Set(['/app', '/next.html', '/index.html']);
const RELAY_URL = new URL('./relay.html', self.location.href);
const encoder = new TextEncoder();
let active = 0;

// This worker controls only the adjacent connection helper directory.
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function smallString(value) {
    return typeof value === 'string' && encoder.encode(value).length <= MAX_BYTES;
}

function smallMessage(data) {
    return data && typeof data === 'object' && !Array.isArray(data) &&
        Object.keys(data).length <= ATTACH_KEYS.length && Object.values(data).every(smallString) &&
        encoder.encode(JSON.stringify(data)).length <= MAX_BYTES;
}

function validOrigin(value) {
    try {
        const url = new URL(value);
        return smallString(value) && url.protocol === 'https:' && url.origin === value;
    } catch {
        return false;
    }
}

function validEndpoint(value) {
    try {
        const url = new URL(value);
        return smallString(value) && url.protocol === 'https:' && url.href === value &&
            !url.username && !url.password && !value.includes('#') && url.origin === self.location.origin;
    } catch {
        return false;
    }
}

// Safari identifies script-opened outer windows as auxiliary rather than top-level.
function outerWindow(client) {
    return client instanceof WindowClient && ['top-level', 'auxiliary'].includes(client.frameType);
}

function validAttachment(event) {
    const data = event.data;
    if (!smallMessage(data) || Object.keys(data).length !== ATTACH_KEYS.length ||
        !ATTACH_KEYS.every((key) => Object.prototype.hasOwnProperty.call(data, key)) ||
        data.marker !== MARK || data.kind !== 'attach' || event.ports.length !== 1 ||
        !UUID.test(data.nonce) || !UUID.test(data.appBoot) || !UUID.test(data.connectionId) ||
        !validOrigin(data.siteOrigin) || !validEndpoint(data.endpoint) ||
        !outerWindow(event.source)) return false;
    return validRelay(event.source, data);
}

function validRelay(client, data) {
    try {
        const url = new URL(client.url);
        return outerWindow(client) &&
            url.origin === RELAY_URL.origin && url.pathname === RELAY_URL.pathname && !url.hash &&
            ['site', 'nonce', 'endpoint'].every((key) => url.searchParams.getAll(key).length === 1) &&
            url.searchParams.get('site') === data.siteOrigin && url.searchParams.get('nonce') === data.nonce &&
            url.searchParams.get('endpoint') === data.endpoint;
    } catch {
        return false;
    }
}

function fail(event, code, message) {
    const data = event.data;
    const error = {
        marker: MARK,
        kind: 'error',
        code,
        message,
        nonce: data && smallString(data.nonce) && UUID.test(data.nonce) ? data.nonce : '',
        connectionId: data && smallString(data.connectionId) && UUID.test(data.connectionId) ? data.connectionId : ''
    };
    for (const port of event.ports) {
        try { port.postMessage(error); } catch { /* The website may have closed its port. */ }
        port.close();
    }
    if (event.source instanceof WindowClient) {
        try { event.source.postMessage(error); } catch { /* The relay may have closed. */ }
    }
}

function normalizePath(path) {
    return path.replace(/\/+$/, '') || '/';
}

function isApp(client, endpoint) {
    try {
        if (!outerWindow(client)) return false;
        const url = new URL(client.url);
        const path = normalizePath(url.pathname);
        const endpointPath = normalizePath(endpoint.pathname);
        return url.origin === self.location.origin && url.origin === endpoint.origin &&
            (path === endpointPath || (endpointPath === '/app' && APP_PATHS.has(path)));
    } catch {
        return false;
    }
}

function diagnosticControl(event) {
    const data = event.data;
    if (event.ports.length || data.kind !== 'control' ||
        !isApp(event.source, new URL('/app', self.location.origin))) return;
    const now = Date.now();
    for (const [id, expiresAt] of diagnostics) if (expiresAt <= now) diagnostics.delete(id);
    if (data.action === 'disable') { diagnostics.delete(event.source.id); return; }
    if (data.action !== 'enable' || !Number.isFinite(data.expiresAt) ||
        data.expiresAt <= now || data.expiresAt > now + 3600000) return;
    if (!diagnostics.has(event.source.id) && diagnostics.size >= 32) diagnostics.delete(diagnostics.keys().next().value);
    diagnostics.set(event.source.id, data.expiresAt);
}

function diagnostic(client, event) {
    const expiresAt = diagnostics.get(client.id);
    if (!expiresAt) return;
    if (expiresAt <= Date.now()) { diagnostics.delete(client.id); return; }
    try { client.postMessage({ kwDiagnostics: DIAGNOSTICS_MARK, kind: 'event', code: 'transport.event',
        data: { layer: 'worker', event } }); } catch { /* Diagnostics cannot affect handoff. */ }
}

function probe(client, appBoot, endpoint) {
    let cancel = () => {};
    const result = new Promise((resolve) => {
        const channels = [];
        let finished = false;
        let retry;
        let attempts = 0;
        const timer = setTimeout(() => finish('timeout'), PROBE_MS);

        function finish(state) {
            if (finished) return;
            finished = true;
            clearTimeout(timer); clearTimeout(retry);
            if (state === 'timeout') diagnostic(client, 'discovery-timeout');
            for (const channel of channels) {
                // Let the app release every temporary probe endpoint.
                try { channel.port1.postMessage({ marker: MARK, kind: 'probe-done', state }); } catch { /* Already closed. */ }
                channel.port1.onmessage = null;
                channel.port1.onmessageerror = null;
                channel.port1.close(); channel.port2.close();
            }
            resolve({ client, state });
        }
        cancel = () => finish('canceled');

        function receive(event) {
            const data = event.data;
            for (const port of event.ports) port.close();
            if (finished || event.ports.length !== 0 || !smallMessage(data) || data.marker !== MARK ||
                data.endpoint !== endpoint || !UUID.test(data.appBoot)) return;
            let state;
            if (data.kind === 'app-ready' && (data.state === undefined || data.state === 'enabled')) {
                state = data.appBoot === appBoot ? 'ready' : 'refreshed';
            } else if (data.kind === 'app-state' && data.state === 'address-mismatch') {
                state = data.appBoot === appBoot ? 'address-mismatch' : 'refreshed';
            } else if (data.kind === 'app-state' && (data.state === 'enabled' || data.state === 'disabled')) {
                state = data.appBoot !== appBoot ? 'refreshed' : data.state === 'enabled' ? 'ready' : 'disabled';
            }
            if (state) { diagnostic(client, 'discovery-reply'); finish(state); }
        }

        function attempt() {
            if (finished) return;
            const channel = new MessageChannel(); channels.push(channel);
            channel.port1.onmessage = receive;
            // A broken old channel must not cancel a newer pending probe.
            channel.port1.onmessageerror = () => {};
            channel.port1.start();
            ++attempts;
            diagnostic(client, 'discovery');
            try { client.postMessage({ marker: MARK, kind: 'find-app', appBoot, endpoint }, [channel.port2]); }
            catch { if (attempts >= MAX_PROBE_ATTEMPTS) { finish('unreachable'); return; } }
            // Discovery reads public receiver state only. A fresh channel can
            // recover a lost reply after suspension without retransferring the
            // website's port or extending its original eight-second deadline.
            if (!finished && attempts < MAX_PROBE_ATTEMPTS) retry = setTimeout(attempt, PROBE_RETRY_MS * 2 ** (attempts - 1));
        }
        attempt();
    });
    return { result, cancel: () => cancel() };
}

async function discover(candidates, appBoot, endpoint) {
    const probes = candidates.map((client) => probe(client, appBoot, endpoint));
    let found;
    const selected = new Promise((resolve) => { found = resolve; });
    const all = Promise.all(probes.map((probe) => probe.result.then((result) => {
        if (result.state === 'ready') found([result]);
        return result;
    })));
    // Boot IDs identify one document. Do not wait for unrelated stale tabs.
    // The website still authenticates the chosen port before accepting it.
    const results = await Promise.race([selected, all]);
    for (const probe of probes) probe.cancel();
    return results;
}

async function attach(event) {
    if (!validAttachment(event)) {
        fail(event, 'invalid', 'The connection request is invalid. Return to the website and retry.');
        return;
    }
    if (active >= MAX_ACTIVE) {
        fail(event, 'busy', 'Too many connections are being prepared. Wait a moment, then retry from the website.');
        return;
    }
    active++;
    try {
        const data = event.data;
        // Re-read the browser-owned client so a navigated relay cannot authorize a handoff.
        const relay = await self.clients.get(event.source.id);
        if (!relay || !validRelay(relay, data)) {
            fail(event, 'invalid', 'The connection helper changed or closed. Return to the website and retry.');
            return;
        }
        const endpoint = new URL(data.endpoint);
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const candidates = clients.filter((client) => client.id !== relay.id && isApp(client, endpoint)).slice(0, MAX_CANDIDATES);
        if (!candidates.length) {
            fail(event, 'noapp', 'No KeeWebX app tab was found. Keep your original app open in the same browser profile and browsing mode, then retry.');
            return;
        }
        const probes = await discover(candidates, data.appBoot, data.endpoint);
        const matches = probes.filter((result) => result.state === 'ready');
        if (!matches.length) {
            if (probes.some((result) => result.state === 'address-mismatch')) {
                fail(event, 'address', 'The App and website have different saved KeeWebX addresses. Save the same App address, then refresh both Connect scripts.');
            } else if (probes.some((result) => result.state === 'disabled')) {
                fail(event, 'disabled', 'Connect is disabled in the selected KeeWebX tab. Enable Connect there, then retry from the website.');
            } else if (probes.some((result) => result.state === 'refreshed')) {
                fail(event, 'refreshed', 'The KeeWebX app was refreshed or the selected tab changed. Select it again for Connect, then retry from the website.');
            } else if (probes.some((result) => result.state === 'timeout')) {
                fail(event, 'timeout', 'The App receiver did not acknowledge discovery. Open Connection diagnostics in the App Connect panel and check the last discovery result.');
            } else {
                fail(event, 'unreachable', 'The KeeWebX app tab could not be reached. Return to the website and retry.');
            }
            return;
        }
        const app = await self.clients.get(matches[0].client.id);
        if (!app || !isApp(app, endpoint)) {
            fail(event, 'refreshed', 'The KeeWebX app tab changed or closed. Select it again for Connect, then retry from the website.');
            return;
        }
        // Ownership moves once to the selected app. The website verifies the signed handshake.
        diagnostic(app, 'handoff');
        app.postMessage({
            marker: MARK,
            kind: 'attach-port',
            appBoot: data.appBoot,
            connectionId: data.connectionId,
            endpoint: data.endpoint,
            siteOrigin: data.siteOrigin
        }, [event.ports[0]]);
        // The endpoint now belongs to the App, independently of the helper.
        // Closing this routing page grants no access; the website still verifies
        // the signed port receipt and encrypted protocol on its own endpoint.
        try {
            relay.postMessage({ marker: MARK, kind: 'handoff-complete', nonce: data.nonce,
                connectionId: data.connectionId, endpoint: data.endpoint });
        } catch { /* The website may already have closed its helper. */ }
    } catch {
        fail(event, 'unreachable', 'The app could not receive the connection. Return to the website and retry.');
    } finally {
        active--;
    }
}

self.addEventListener('message', (event) => {
    const data = event.data;
    if (data?.kwDiagnostics === DIAGNOSTICS_MARK) { diagnosticControl(event); return; }
    if (data?.kind === 'probe-relay') {
        if (event.ports.length || !smallMessage(data) || Object.keys(data).length !== 5 || data.marker !== MARK ||
            !UUID.test(data.nonce) || !validOrigin(data.siteOrigin) || !validEndpoint(data.endpoint) ||
            !outerWindow(event.source) || !validRelay(event.source, data)) return;
        event.source.postMessage({ marker: MARK, kind: 'relay-capabilities', nonce: data.nonce,
            endpoint: data.endpoint, protocol: 'self-close-v1' });
        return;
    }
    event.waitUntil(attach(event));
});
