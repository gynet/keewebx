'use strict';

const MARK = 'keewebx-port-lab-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BYTES = 1024;
const MAX_ACTIVE = 8;
const MAX_CANDIDATES = 10;
const PROBE_MS = 2000;
const APP_PATHS = new Set(['/app', '/next.html', '/index.html']);
let active = 0;

// This worker's registration is limited to /connect-port-poc/.
self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function smallMessage(data) {
    try {
        return data && typeof data === 'object' && !Array.isArray(data) &&
            Object.values(data).every((value) => typeof value === 'string') &&
            new TextEncoder().encode(JSON.stringify(data)).length <= MAX_BYTES;
    } catch {
        return false;
    }
}

function validOrigin(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.origin === value;
    } catch {
        return false;
    }
}

function validAttachment(event) {
    const data = event.data;
    if (!smallMessage(data) || data.marker !== MARK || data.kind !== 'attach' ||
        event.ports.length !== 1 || !UUID.test(data.nonce || '') ||
        !UUID.test(data.appBoot || '') || !UUID.test(data.connectionId || '') ||
        !validOrigin(data.siteOrigin) || !event.source || event.source.type !== 'window') return false;
    try {
        const url = new URL(event.source.url);
        return url.origin === self.location.origin && url.pathname === '/connect-port-poc/relay.html' &&
            url.searchParams.getAll('site').length === 1 && url.searchParams.getAll('nonce').length === 1 &&
            url.searchParams.get('site') === data.siteOrigin && url.searchParams.get('nonce') === data.nonce;
    } catch {
        return false;
    }
}

function fail(event, message) {
    const error = { marker: MARK, kind: 'error', message };
    for (const port of event.ports) {
        try { port.postMessage(error); } catch { /* The website may already have closed its port. */ }
        port.close();
    }
    if (event.source && typeof event.source.postMessage === 'function') {
        try {
            event.source.postMessage({
                ...error,
                nonce: event.data && event.data.nonce,
                connectionId: event.data && event.data.connectionId
            });
        } catch { /* The relay may already have closed. */ }
    }
}

function isApp(client) {
    try {
        const url = new URL(client.url);
        return url.origin === self.location.origin && APP_PATHS.has(url.pathname);
    } catch {
        return false;
    }
}

function probe(client, appBoot) {
    return new Promise((resolve) => {
        const channel = new MessageChannel();
        let finished = false;
        const timer = setTimeout(() => finish(false), PROBE_MS);

        function finish(matches) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            channel.port1.close();
            channel.port2.close();
            resolve(matches ? client : null);
        }

        channel.port1.onmessage = (event) => {
            const data = event.data;
            if (event.ports.length === 0 && smallMessage(data) && data.marker === MARK &&
                data.kind === 'app-ready' && data.appBoot === appBoot) finish(true);
        };
        channel.port1.onmessageerror = () => finish(false);
        try {
            client.postMessage({ marker: MARK, kind: 'find-app', appBoot }, [channel.port2]);
        } catch {
            finish(false);
        }
    });
}

async function attach(event) {
    if (!validAttachment(event)) {
        fail(event, 'The connection request is invalid. Return to the website and try again.');
        return;
    }
    if (active >= MAX_ACTIVE) {
        fail(event, 'Too many connections are being prepared. Wait a moment and try again.');
        return;
    }
    active++;
    try {
        const data = event.data;
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const candidates = clients.filter(isApp).slice(0, MAX_CANDIDATES);
        const matches = (await Promise.all(candidates.map((client) => probe(client, data.appBoot)))).filter(Boolean);
        if (matches.length !== 1) {
            fail(event, matches.length ?
                'More than one app answered for this session. Return to the website and reconnect.' :
                'The original KeeWebX app did not answer. Keep it open, return to the website, and reconnect.');
            return;
        }
        // Ownership moves directly to the original app. No port is retained here.
        matches[0].postMessage({
            marker: MARK,
            kind: 'attach-port',
            appBoot: data.appBoot,
            connectionId: data.connectionId,
            siteOrigin: data.siteOrigin
        }, [event.ports[0]]);
    } catch {
        fail(event, 'The app could not receive the connection. Return to the website and try again.');
    } finally {
        active--;
    }
}

self.addEventListener('message', (event) => {
    event.waitUntil(attach(event));
});
