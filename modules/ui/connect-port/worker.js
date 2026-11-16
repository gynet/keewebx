'use strict';

const MARK = 'keewebx-connect-port-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BYTES = 2048;
const MAX_ACTIVE = 8;
const MAX_CANDIDATES = 32;
const PROBE_MS = 8000;
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

function probe(client, appBoot, endpoint) {
    return new Promise((resolve) => {
        const channel = new MessageChannel();
        let finished = false;
        const timer = setTimeout(() => finish('timeout'), PROBE_MS);

        function finish(state) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            // Let the app release its probe endpoint before closing our endpoints.
            try { channel.port1.postMessage({ marker: MARK, kind: 'probe-done' }); } catch { /* Already closed. */ }
            channel.port1.onmessage = null;
            channel.port1.onmessageerror = null;
            channel.port1.close();
            channel.port2.close();
            resolve({ client, state });
        }

        channel.port1.onmessage = (event) => {
            const data = event.data;
            for (const port of event.ports) port.close();
            if (event.ports.length !== 0 || !smallMessage(data) || data.marker !== MARK ||
                data.endpoint !== endpoint || !UUID.test(data.appBoot)) return;
            if (data.kind === 'app-ready' && (data.state === undefined || data.state === 'enabled')) {
                finish(data.appBoot === appBoot ? 'ready' : 'refreshed');
            } else if (data.kind === 'app-state' && data.state === 'address-mismatch') {
                finish(data.appBoot === appBoot ? 'address-mismatch' : 'refreshed');
            } else if (data.kind === 'app-state' && (data.state === 'enabled' || data.state === 'disabled')) {
                finish(data.appBoot !== appBoot ? 'refreshed' : data.state === 'enabled' ? 'ready' : 'disabled');
            }
        };
        channel.port1.onmessageerror = () => finish('unreachable');
        channel.port1.start();
        try {
            client.postMessage({ marker: MARK, kind: 'find-app', appBoot, endpoint }, [channel.port2]);
        } catch {
            finish('unreachable');
        }
    });
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
        const probes = await Promise.all(candidates.map((client) => probe(client, data.appBoot, data.endpoint)));
        const matches = probes.filter((result) => result.state === 'ready');
        if (matches.length > 1) {
            fail(event, 'ambiguous', 'More than one app answered for this session. Select your original KeeWebX tab again and reconnect from the website.');
            return;
        }
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
        app.postMessage({
            marker: MARK,
            kind: 'attach-port',
            appBoot: data.appBoot,
            connectionId: data.connectionId,
            endpoint: data.endpoint,
            siteOrigin: data.siteOrigin
        }, [event.ports[0]]);
    } catch {
        fail(event, 'unreachable', 'The app could not receive the connection. Return to the website and retry.');
    } finally {
        active--;
    }
}

self.addEventListener('message', (event) => event.waitUntil(attach(event)));
