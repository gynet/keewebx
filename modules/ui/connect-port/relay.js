(() => {
    'use strict';

    const MARK = 'keewebx-connect-port-v1';
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const MAX_BYTES = 2048;
    const READY_MS = 12000;
    const WORKER_MS = 8000;
    const ATTACH_KEYS = ['marker', 'kind', 'nonce', 'appBoot', 'connectionId', 'endpoint', 'siteOrigin'];
    const ERROR_KEYS = ['marker', 'kind', 'code', 'message', 'nonce', 'connectionId'];
    const COMPLETE_KEYS = ['marker', 'kind', 'nonce', 'connectionId', 'endpoint'];
    const encoder = new TextEncoder();
    const status = document.getElementById('status');
    const back = document.getElementById('back');
    const opener = window.opener;
    const params = new URL(location.href).searchParams;
    const site = params.get('site');
    const nonce = params.get('nonce');
    const endpoint = params.get('endpoint');
    const announcement = { marker: MARK, kind: 'relay-ready', nonce, endpoint };
    const workerURL = new URL('./worker.js', location.href).href;
    const workerScope = new URL('./', location.href).href;
    let accepted = false;
    let expired = false;
    let connectionId;
    let controller;
    let heartbeat;
    let deadline;
    let completionTimer;
    let completed = false;

    function smallString(value) {
        return typeof value === 'string' && encoder.encode(value).length <= MAX_BYTES;
    }

    function messageWithKeys(data, keys) {
        return data && typeof data === 'object' && !Array.isArray(data) &&
            Object.keys(data).length === keys.length &&
            keys.every((key) => Object.prototype.hasOwnProperty.call(data, key) && smallString(data[key])) &&
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
                !url.username && !url.password && !value.includes('#') && url.origin === location.origin;
        } catch {
            return false;
        }
    }

    function showError(message) {
        expired = true;
        clearTimeout(completionTimer);
        status.textContent = message;
        status.dataset.error = '';
        back.textContent = 'Close connection page'; back.disabled = false;
    }

    function closeSelf() {
        // Cross-window close can silently fail in a script manager's world.
        // The helper closes itself in its own page world instead.
        try { window.close(); } catch {}
        clearTimeout(completionTimer);
        completionTimer = setTimeout(() => {
            if (!window.closed) {
                status.textContent = completed
                    ? 'Connection prepared. Close this page to continue on your original website.'
                    : 'Close this connection page, then retry from your original website.';
                back.textContent = 'Close connection page'; back.disabled = false;
            }
        }, 300);
    }

    function complete(data) {
        if (!accepted || completed || expired || !messageWithKeys(data, COMPLETE_KEYS) || data.marker !== MARK ||
            data.nonce !== nonce || data.connectionId !== connectionId || data.endpoint !== endpoint) return;
        completed = true; stopAnnouncements();
        status.textContent = 'Returning to your website…';
        closeSelf();
    }

    function stopAnnouncements() {
        clearInterval(heartbeat);
        clearTimeout(deadline);
    }

    function closePorts(ports) {
        for (const port of ports) port.close();
    }

    function fail(ports, code, message, id = connectionId || '') {
        expired = true;
        stopAnnouncements();
        const error = { marker: MARK, kind: 'error', code, message, nonce, connectionId: id };
        for (const port of ports) {
            try { port.postMessage(error); } catch { /* The website may have closed its port. */ }
            port.close();
        }
        try { opener.postMessage(error, site); } catch { /* The website may have closed. */ }
        showError(message);
        closeSelf();
    }

    function getController() {
        return new Promise((resolve, reject) => {
            let finished = false;
            let observedController;
            const timer = setTimeout(() => finish(new Error('The connection worker did not become ready within 8 seconds. Return to the website and retry.')), WORKER_MS);
            const retry = setInterval(check, 300);

            function finish(error, result) {
                if (finished) return;
                finished = true;
                clearTimeout(timer); clearInterval(retry);
                navigator.serviceWorker.removeEventListener('controllerchange', check);
                navigator.serviceWorker.removeEventListener('message', capabilities);
                if (observedController) observedController.removeEventListener('statechange', check);
                if (error) reject(error);
                else resolve(result);
            }

            function check() {
                if (finished) return;
                const current = navigator.serviceWorker.controller;
                if (current !== observedController) {
                    if (observedController) observedController.removeEventListener('statechange', check);
                    observedController = current;
                    if (current) current.addEventListener('statechange', check);
                }
                if (current && current.scriptURL === workerURL && current.state === 'activated') {
                    // An old activated controller can have this same script URL.
                    // Require the self-close capability before transferring a port.
                    try { current.postMessage({ marker: MARK, kind: 'probe-relay', nonce, endpoint, siteOrigin: site }); } catch {}
                }
            }

            function capabilities(event) {
                const data = event.data, current = navigator.serviceWorker.controller;
                if (event.isTrusted && event.ports.length === 0 && current && event.source === current &&
                    current.scriptURL === workerURL && current.state === 'activated' &&
                    messageWithKeys(data, ['marker', 'kind', 'nonce', 'endpoint', 'protocol']) &&
                    data.marker === MARK && data.kind === 'relay-capabilities' && data.nonce === nonce &&
                    data.endpoint === endpoint && data.protocol === 'self-close-v1') finish(null, current);
            }

            navigator.serviceWorker.addEventListener('controllerchange', check);
            navigator.serviceWorker.addEventListener('message', capabilities);
            Promise.resolve()
                .then(() => navigator.serviceWorker.register('./worker.js', { scope: './', updateViaCache: 'none' }))
                .then((registration) => {
                    if (registration.scope !== workerScope) throw new Error('Unexpected worker scope.');
                    return navigator.serviceWorker.ready;
                })
                .then(check)
                .catch(() => finish(new Error('The connection worker could not start. Return to the website and retry.')));
        });
    }

    back.disabled = false;
    back.addEventListener('click', closeSelf);

    if (!['site', 'nonce', 'endpoint'].every((key) => params.getAll(key).length === 1) ||
        !validOrigin(site) || !smallString(nonce) || !UUID.test(nonce) || !validEndpoint(endpoint) ||
        !messageWithKeys(announcement, ['marker', 'kind', 'nonce', 'endpoint']) ||
        window.top !== window) {
        showError('This connection link is invalid. Return to the website and start a new connection.');
        return;
    }
    document.getElementById('site').textContent = site;
    if (!opener || opener.closed) {
        showError('Open this helper from the website you want to connect.');
        return;
    }
    if (!window.isSecureContext || !('serviceWorker' in navigator)) {
        showError('This browser needs a secure connection and service worker support. Return to the website to retry.');
        return;
    }

    // Handle startup rejection even when the website never sends its port.
    const controllerResult = getController().then(
        (result) => ({ controller: result }),
        (error) => {
            expired = true;
            stopAnnouncements();
            showError(error.message);
            // An accepted attachment forwards this failure through its port first.
            if (!accepted) closeSelf();
            return { error };
        }
    );

    window.addEventListener('message', async (event) => {
        const data = event.data;
        if (accepted || expired || !event.isTrusted || event.source !== opener || event.origin !== site ||
            !data || data.marker !== MARK || data.kind !== 'attach' || data.nonce !== nonce) {
            closePorts(event.ports);
            return;
        }
        if (!messageWithKeys(data, ATTACH_KEYS) || !UUID.test(data.appBoot) || !UUID.test(data.connectionId) ||
            data.endpoint !== endpoint || data.siteOrigin !== site || event.ports.length !== 1) {
            fail(event.ports, 'invalid', 'The connection request is invalid. Return to the website and retry.',
                smallString(data.connectionId) && UUID.test(data.connectionId) ? data.connectionId : '');
            return;
        }

        accepted = true;
        connectionId = data.connectionId;
        stopAnnouncements();
        completionTimer = setTimeout(() => {
            if (completed || expired) return;
            fail([], 'timeout', 'The connection did not complete. Retry from your website.');
        }, 25000);
        const port = event.ports[0];
        const abandon = () => fail([port], 'relay-closed', 'The helper closed before handing off the connection. Return to the website and retry.');
        window.addEventListener('pagehide', abandon, { once: true });
        status.textContent = 'Finding your original KeeWebX app tab…';
        const result = await controllerResult;
        try {
            if (result.error) {
                fail([port], 'worker-unavailable', result.error.message);
                return;
            }
            if (expired) return;
            controller = result.controller;
            if (controller !== navigator.serviceWorker.controller || controller.state !== 'activated' || controller.scriptURL !== workerURL) {
                fail([port], 'worker-unavailable', 'The connection worker changed. Return to the website and retry.');
                return;
            }
            controller.postMessage({ marker: MARK, kind: 'attach', nonce, appBoot: data.appBoot, connectionId, endpoint, siteOrigin: site }, [port]);
            status.textContent = 'Connecting to your existing KeeWebX tab…';
        } catch {
            fail([port], 'unreachable', 'The connection could not reach KeeWebX. Return to the website and retry.');
        } finally {
            window.removeEventListener('pagehide', abandon);
        }
    });

    navigator.serviceWorker.addEventListener('message', (event) => {
        const data = event.data;
        closePorts(event.ports);
        if (event.ports.length === 0 && event.isTrusted && controller && event.source === controller && data?.kind === 'handoff-complete') {
            // Older workers announce transfer before the App has received it.
            // Only the website's authenticated-ready confirmation can complete.
            return;
        }
        if (event.ports.length === 0 && event.isTrusted && controller && event.source === controller &&
            messageWithKeys(data, ERROR_KEYS) && data.marker === MARK && data.kind === 'error' &&
            data.nonce === nonce && data.connectionId === connectionId) {
            // The worker also sent this error through the transferred port.
            // Leave the error on the website, not a stranded foreground helper.
            showError(data.message);
            closeSelf();
        }
    });

    window.addEventListener('message', event => {
        if (!['relay-complete', 'relay-cancel'].includes(event.data?.kind)) return;
        if (event.ports.length) { closePorts(event.ports); return; }
        if (!event.isTrusted || event.source !== opener || event.origin !== site) return;
        const data = event.data;
        if (data.kind === 'relay-complete') complete(data);
        else if (accepted && !completed && !expired && messageWithKeys(data, COMPLETE_KEYS) && data.marker === MARK &&
            data.nonce === nonce && data.connectionId === connectionId && data.endpoint === endpoint) {
            expired = true; stopAnnouncements(); clearTimeout(completionTimer); closeSelf();
        }
    });

    function announce() {
        if (opener.closed) {
            expired = true;
            stopAnnouncements();
            showError('The website tab closed. Reopen it and start a new connection.');
            closeSelf();
            return;
        }
        try {
            opener.postMessage(announcement, site);
        } catch {
            expired = true;
            stopAnnouncements();
            showError('The website could not be reached. Return to its tab and retry.');
            closeSelf();
        }
    }

    status.textContent = 'Waiting for the website to attach its connection…';
    heartbeat = setInterval(announce, 300);
    deadline = setTimeout(() => fail([], 'timeout', 'The website did not connect within 12 seconds. Return to it and retry.'), READY_MS);
    window.addEventListener('pagehide', () => {
        expired = true;
        clearTimeout(completionTimer);
        stopAnnouncements();
    }, { once: true });
    announce();
})();
