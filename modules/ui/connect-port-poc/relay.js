(() => {
    'use strict';

    const MARK = 'keewebx-port-lab-v1';
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const READY_MS = 12000;
    const WORKER_MS = 8000;
    const MAX_BYTES = 1024;
    const status = document.getElementById('status');
    const back = document.getElementById('back');
    const opener = window.opener;
    const params = new URL(location.href).searchParams;
    const site = params.get('site');
    const nonce = params.get('nonce');
    const workerURL = new URL('./worker.js', location.href).href;
    let accepted = false;
    let expired = false;
    let connectionId;
    let heartbeat;
    let deadline;

    function showError(message) {
        status.textContent = message;
        status.dataset.error = '';
    }

    function validOrigin(value) {
        try {
            const url = new URL(value);
            return url.protocol === 'https:' && url.origin === value;
        } catch {
            return false;
        }
    }

    function smallMessage(data) {
        try {
            return data && typeof data === 'object' && !Array.isArray(data) &&
                Object.values(data).every((value) => typeof value === 'string') &&
                new TextEncoder().encode(JSON.stringify(data)).length <= MAX_BYTES;
        } catch {
            return false;
        }
    }

    function stopAnnouncements() {
        clearInterval(heartbeat);
        clearTimeout(deadline);
    }

    function getController() {
        return new Promise((resolve, reject) => {
            let finished = false;
            let observedController;
            const timer = setTimeout(() => finish(new Error('The connection worker did not become ready. Return to the website and try again.')), WORKER_MS);

            function finish(error, controller) {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                navigator.serviceWorker.removeEventListener('controllerchange', check);
                if (observedController) observedController.removeEventListener('statechange', check);
                if (error) reject(error);
                else resolve(controller);
            }

            function check() {
                if (finished) return;
                const controller = navigator.serviceWorker.controller;
                if (controller && controller.scriptURL === workerURL) {
                    if (controller.state === 'activated') finish(null, controller);
                    else if (controller !== observedController) {
                        if (observedController) observedController.removeEventListener('statechange', check);
                        observedController = controller;
                        controller.addEventListener('statechange', check);
                    }
                }
            }

            navigator.serviceWorker.addEventListener('controllerchange', check);
            navigator.serviceWorker.register('./worker.js', { scope: './' })
                .then(() => navigator.serviceWorker.ready)
                .then(check)
                .catch(() => finish(new Error('The connection worker could not start. Return to the website and try again.')));
        });
    }

    back.disabled = !opener || opener.closed;
    back.addEventListener('click', () => {
        if (opener && !opener.closed) opener.focus();
        else showError('The original website tab is closed. Open it again and retry the connection.');
    });

    if (params.getAll('site').length !== 1 || params.getAll('nonce').length !== 1 ||
        !validOrigin(site) || !UUID.test(nonce || '')) {
        showError('This connection link is invalid. Return to the website and start a new connection.');
        return;
    }
    document.getElementById('site').textContent = site;
    if (!opener || opener.closed) {
        showError('Open this helper from the website you want to connect.');
        return;
    }
    if (!window.isSecureContext || !('serviceWorker' in navigator)) {
        showError('This browser needs a secure connection and service worker support for the test.');
        return;
    }

    // Keep startup failure handled even if the website never sends an attachment.
    const controllerResult = getController().then(
        (controller) => ({ controller }),
        (error) => {
            expired = true;
            stopAnnouncements();
            showError(error.message);
            return { error };
        }
    );

    window.addEventListener('message', async (event) => {
        const data = event.data;
        if (accepted || expired || !event.isTrusted || event.source !== opener || event.origin !== site ||
            !smallMessage(data) || data.marker !== MARK || data.kind !== 'attach' ||
            data.nonce !== nonce || !UUID.test(data.appBoot || '') || !UUID.test(data.connectionId || '') ||
            event.ports.length !== 1) return;

        accepted = true;
        connectionId = data.connectionId;
        stopAnnouncements();
        const port = event.ports[0];
        status.textContent = 'Finding your original KeeWebX app tab…';
        const result = await controllerResult;
        try {
            if (result.error) throw result.error;
            result.controller.postMessage({
                marker: MARK,
                kind: 'attach',
                nonce,
                appBoot: data.appBoot,
                connectionId,
                siteOrigin: event.origin
            }, [port]);
            status.textContent = 'Waiting for the app to confirm. Return to the website to continue.';
        } catch (error) {
            const message = error instanceof Error ? error.message : 'The connection could not reach the app. Return to the website and try again.';
            try { port.postMessage({ marker: MARK, kind: 'error', message }); } catch { /* The website may already have closed its port. */ }
            port.close();
            showError(message);
        }
    });

    navigator.serviceWorker.addEventListener('message', (event) => {
        const data = event.data;
        if (event.isTrusted && event.source === navigator.serviceWorker.controller && smallMessage(data) &&
            data.marker === MARK && data.kind === 'error' && data.nonce === nonce &&
            data.connectionId === connectionId && typeof data.message === 'string') {
            showError(data.message);
        }
    });

    function announce() {
        if (opener.closed) {
            expired = true;
            stopAnnouncements();
            showError('The website tab closed. Reopen it and start a new connection.');
            return;
        }
        opener.postMessage({ marker: MARK, kind: 'relay-ready', nonce }, site);
    }

    status.textContent = 'Waiting for the website to attach its connection…';
    heartbeat = setInterval(announce, 300);
    deadline = setTimeout(() => {
        expired = true;
        stopAnnouncements();
        showError('The website did not connect in time. Return to it and try again.');
    }, READY_MS);
    window.addEventListener('pagehide', stopAnnouncements, { once: true });
    announce();
})();
