'use strict';

const MARK = 'keewebx-connect-port-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BYTES = 2048;
const MAX_ACTIVE = 8;
const MAX_CANDIDATES = 32;
const PROBE_MS = 8000;
const DISCOVERY_MS = 2 * PROBE_MS;
const PROBE_RETRY_MS = 750;
const MAX_PROBE_ATTEMPTS = 4;
const INSTANCE_MARK = 'keewebx-app-instance-v1';
const ATTACH_KEYS = ['marker', 'kind', 'nonce', 'appBoot', 'connectionId', 'endpoint', 'siteOrigin'];
const APP_PATHS = new Set(['/app', '/next.html', '/index.html']);
const RELAY_URL = new URL('./relay.html', self.location.href);
const encoder = new TextEncoder();
const pendingDiscovery = new Map();
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

function instancePage(client) {
    try {
        if (!outerWindow(client)) return false;
        const url = new URL(client.url), base = new URL('../', self.location.href);
        return url.origin === base.origin && ['', 'app', 'index.html', 'next.html'].some(path =>
            normalizePath(url.pathname) === normalizePath(new URL(path || './', base).pathname));
    } catch { return false; }
}

/** Focus the actual lock holder; no stored owner, heartbeat or new window. */
async function focusInstance(event) {
    const data = event.data, port = event.ports[0];
    const prefix = `${INSTANCE_MARK}:${new URL('../', self.location.href).pathname}:`;
    if (port && event.ports.length === 1 && instancePage(event.source) && data.kind === 'identify' &&
        Object.keys(data).length === 2 && /^[a-zA-Z0-9{}-]{1,128}$/.test(event.source.id)) {
        port.postMessage({ marker: INSTANCE_MARK, kind: 'identified', clientId: event.source.id }); port.close(); return;
    }
    if (!port || event.ports.length !== 1 || !instancePage(event.source) ||
        !data || Object.keys(data).length !== 3 || data.kind !== 'focus' ||
        typeof data.lockName !== 'string' || !data.lockName.startsWith(prefix) ||
        data.lockName.length > 512 || /[\u0000-\u001f\u007f]/.test(data.lockName)) {
        for (const endpoint of event.ports) endpoint.close();
        return;
    }
    let timer, live = true;
    port.onmessage = message => {
        if (message.data?.marker === INSTANCE_MARK && message.data.kind === 'cancel') live = false;
    };
    port.start();
    try {
        const focused = await Promise.race([
            (async () => {
                const locks = await self.navigator?.locks?.query();
                if (!live) return false;
                const owner = locks?.held?.find(lock => lock.name === data.lockName && lock.mode === 'exclusive');
                if (!owner?.clientId) return false;
                const locator = locks.held.find(lock => lock.mode === 'exclusive' && lock.clientId === owner.clientId &&
                    lock.name.startsWith(data.lockName + ':client:'));
                // Lock client IDs identify execution contexts; they are not the
                // IDs exposed by ServiceWorker WindowClients in every browser.
                const id = locator ? decodeURIComponent(locator.name.slice((data.lockName + ':client:').length)) : owner.clientId;
                const client = await self.clients.get(id);
                if (!live || !instancePage(client)) return false;
                return (await client.focus()).focused === true;
            })(),
            new Promise(resolve => { timer = setTimeout(() => { live = false; resolve(false); }, 1200); })
        ]);
        port.postMessage({ marker: INSTANCE_MARK, kind: 'focused', ok: focused === true });
    } catch {
        try { port.postMessage({ marker: INSTANCE_MARK, kind: 'focused', ok: false }); } catch {}
    } finally {
        live = false; clearTimeout(timer); port.onmessage = null; port.close();
    }
}

function probe(client, appBoot, endpoint, timeout = PROBE_MS, portId) {
    let cancel = () => {};
    const result = new Promise((resolve) => {
        const channels = [];
        let finished = false;
        let retry;
        let attempts = 0;
        const traceId = crypto.randomUUID();
        const deadline = Date.now() + timeout;
        const timer = setTimeout(() => finish('timeout'), timeout);

        function finish(state) {
            if (finished) return;
            finished = true;
            pendingDiscovery.delete(traceId);
            clearTimeout(timer); clearTimeout(retry);
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
            if (finished || Date.now() >= deadline) return;
            if (event.ports.length !== 0 || !smallMessage(data) || data.marker !== MARK ||
                data.endpoint !== endpoint || !UUID.test(data.appBoot) || data.traceId !== undefined && data.traceId !== traceId) {
                return;
            }
            let state;
            if (data.kind === 'app-ready' && (data.state === undefined || data.state === 'enabled')) {
                state = data.appBoot === appBoot ? 'ready' : 'refreshed';
            } else if (data.kind === 'app-state' && data.state === 'address-mismatch') {
                state = data.appBoot === appBoot ? 'address-mismatch' : 'refreshed';
            } else if (data.kind === 'app-state' && (data.state === 'enabled' || data.state === 'disabled')) {
                state = data.appBoot !== appBoot ? 'refreshed' : data.state === 'enabled' ? 'ready' : 'disabled';
            }
            if (state) finish(state);
        }

        function attempt() {
            if (finished) return;
            const channel = new MessageChannel(); channels.push(channel);
            channel.port1.onmessage = receive;
            // A broken old channel must not cancel a newer pending probe.
            channel.port1.onmessageerror = () => {};
            channel.port1.start();
            ++attempts;
            try { client.postMessage({ marker: MARK, kind: 'find-app', appBoot, endpoint, traceId, replyViaWorker: true }, [channel.port2]); }
            catch { if (attempts >= MAX_PROBE_ATTEMPTS) { finish('unreachable'); return; } }
            // Discovery reads public receiver state only. A fresh channel can
            // recover a lost reply after suspension without retransferring the
            // website's port or extending its original eight-second deadline.
            if (!finished && attempts < MAX_PROBE_ATTEMPTS) retry = setTimeout(attempt, PROBE_RETRY_MS * 2 ** (attempts - 1));
        }
        pendingDiscovery.set(traceId, { id: client.id, endpoint: new URL(endpoint), receive });
        attempt();
    });
    return { result, cancel: () => cancel() };
}

async function discover(candidates, appBoot, endpoint, timeout = PROBE_MS, portId) {
    const probes = candidates.map((client) => probe(client, appBoot, endpoint, timeout, portId));
    let found;
    const selected = new Promise((resolve) => { found = resolve; });
    const all = Promise.all(probes.map((probe) => probe.result.then((result) => {
        if (['ready', 'disabled', 'address-mismatch'].includes(result.state)) found([result]);
        return result;
    })));
    // Boot IDs identify one document. Its explicit rejection is also final;
    // do not wait for unrelated stale tabs or retry a disabled selected App.
    // The website still authenticates the chosen port before accepting it.
    const results = await Promise.race([selected, all]);
    for (const probe of probes) probe.cancel();
    return results;
}

async function findWindowClient(id, includeUncontrolled, valid) {
    let client = await self.clients.get(id);
    if (!client) {
        // A missing lookup alone does not establish that the window closed.
        const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled });
        client = windows.find((window) => window.id === id);
    }
    return client && client.id === id && valid(client) ? client : undefined;
}

function findRelay(id, data) {
    return findWindowClient(id, false, (client) => validRelay(client, data));
}

async function recoveryClients(sourceId, data, endpoint, deadline) {
    let timer;
    try {
        // Browser-owned lookups must also fit inside the discovery budget.
        return await Promise.race([
            (async () => {
                const relay = await findRelay(sourceId, data);
                if (!relay) return { invalid: true };
                const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
                return { candidates: clients.filter((client) => client.id !== relay.id && isApp(client, endpoint)).slice(0, MAX_CANDIDATES) };
            })(),
            new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())); })
        ]);
    } finally {
        clearTimeout(timer);
    }
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
        const handoffDeadline = Date.now() + 25000;
        // Re-read the browser-owned client so a navigated relay cannot authorize a handoff.
        const relay = await findRelay(event.source.id, data);
        if (!relay) {
            fail(event, 'helper-unavailable', 'The connection helper changed or closed. Return to the website and retry.');
            return;
        }
        const endpoint = new URL(data.endpoint);
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const candidates = clients.filter((client) => client.id !== relay.id && isApp(client, endpoint)).slice(0, MAX_CANDIDATES);
        if (!candidates.length) {
            fail(event, 'noapp', 'No KeeWebX app tab was found. Keep your original app open in the same browser profile and browsing mode, then retry.');
            return;
        }
        const discoveryDeadline = Date.now() + DISCOVERY_MS;
        // The browser's primary App may differ from the website's selected boot.
        // Only an acknowledgement from that boot can select the port recipient.
        let probes = await discover(candidates, data.appBoot, data.endpoint,
            Math.min(PROBE_MS, Math.max(0, discoveryDeadline - Date.now())), data.connectionId);
        if (!probes.some((result) => ['ready', 'disabled', 'address-mismatch'].includes(result.state)) &&
            probes.some((result) => ['timeout', 'unreachable'].includes(result.state))) {
            // iOS can queue every probe until the App resumes after round one.
            // Keep the website endpoint here; only public probes get new ports.
            const refreshed = await recoveryClients(event.source.id, data, endpoint, discoveryDeadline);
            if (refreshed?.invalid) {
                fail(event, 'helper-unavailable', 'The connection helper changed or closed. Return to the website and retry.');
                return;
            }
            if (refreshed) {
                if (!refreshed.candidates.length) {
                    fail(event, 'noapp', 'No KeeWebX app tab was found. Keep your original app open in the same browser profile and browsing mode, then retry.');
                    return;
                }
                const remaining = Math.min(PROBE_MS, discoveryDeadline - Date.now());
                if (remaining > 0) probes = await discover(refreshed.candidates, data.appBoot, data.endpoint, remaining, data.connectionId);
            }
        }
        const matches = probes.filter((result) => result.state === 'ready');
        if (!matches.length) {
            if (probes.some((result) => result.state === 'address-mismatch')) {
                fail(event, 'address', 'The App and website have different saved KeeWebX addresses. Save the same App address, then refresh both Connect scripts.');
            } else if (probes.some((result) => result.state === 'disabled')) {
                fail(event, 'disabled', 'Connect is disabled in the selected KeeWebX tab. Enable Connect there, then retry from the website.');
            } else if (probes.some((result) => result.state === 'refreshed') &&
                !probes.some((result) => ['timeout', 'unreachable'].includes(result.state))) {
                fail(event, 'refreshed', 'The KeeWebX app was refreshed or the selected tab changed. Select it again for Connect, then retry from the website.');
            } else if (probes.some((result) => result.state === 'timeout')) {
                fail(event, 'app-timeout', 'The App receiver did not answer. Visit your existing KeeWebX tab, unlock if needed, then retry.');
            } else {
                fail(event, 'unreachable', 'The KeeWebX app tab could not be reached. Return to the website and retry.');
            }
            return;
        }
        const [currentRelay, app] = await Promise.all([
            findRelay(event.source.id, data), findWindowClient(matches[0].client.id, true, (client) => isApp(client, endpoint))
        ]);
        if (!currentRelay) {
            fail(event, 'helper-unavailable', 'The connection helper changed or closed. Return to the website and retry.');
            return;
        }
        if (!app) {
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
            siteOrigin: data.siteOrigin,
            handoffDeadline
        }, [event.ports[0]]);
        // Transfer is not acceptance. Keep the helper alive until the website
        // verifies the App's signed ready receipt and asks its opener to close.
    } catch {
        fail(event, 'unreachable', 'The app could not receive the connection. Return to the website and retry.');
    } finally {
        active--;
    }
}

self.addEventListener('message', (event) => {
    const data = event.data;
    if (data?.marker === INSTANCE_MARK) { event.waitUntil(focusInstance(event)); return; }
    if (data?.marker !== MARK) return;
    if (data.kind === 'app-ready' || data.kind === 'app-state') {
        const pending = pendingDiscovery.get(data.traceId);
        if (pending && event.source?.id === pending.id && isApp(event.source, pending.endpoint)) pending.receive(event);
        else for (const port of event.ports) port.close();
        return;
    }
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
