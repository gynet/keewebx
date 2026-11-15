// Included by build-post-robot-probe.mjs inside the bundled userscript closure.
function installKeeWebXPostRobotProbe(robot) {
    'use strict';
    const APP_ORIGIN = 'https://keewebx.app';
    const app = location.origin === APP_ORIGIN && /^\/app\/?$/.test(location.pathname);
    if (window.top !== window || (location.origin === APP_ORIGIN && !app)) return;

    const HELLO = 'kwx-postrobot-probe-hello-v1';
    const PING = 'kwx-postrobot-probe-ping-v1';
    const TIMEOUT = 5000;
    const boot = crypto.randomUUID();
    const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const id = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
    const errorText = error => error instanceof Error ? error.message : String(error);
    let child;
    let session;
    let lastAppBoot;
    let testing = false;
    let disposed = false;
    const listeners = [];

    const host = document.createElement('div');
    host.id = 'keewebx-postrobot-probe';
    host.style.cssText = 'position:fixed;right:10px;bottom:calc(10px + env(safe-area-inset-bottom, 0px));z-index:2147483647;';
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = ':host{all:initial;font:14px system-ui;color:#172033}button,input{box-sizing:border-box;font:inherit;min-height:42px;border:1px solid #aebbd0;border-radius:9px;padding:8px 10px;background:#f3f7ff;color:#172033}button{cursor:pointer}button:disabled{opacity:.6}section{box-sizing:border-box;width:min(340px,calc(100vw - 20px));padding:12px;background:#fff;border:1px solid #aebbd0;border-radius:12px;box-shadow:0 4px 20px #0003;margin-bottom:8px}section[hidden]{display:none}h2{font-size:15px;margin:0 0 8px}p,label,pre{font-size:13px;line-height:1.4;overflow-wrap:anywhere}label{display:block}input{display:block;width:100%;background:#fff;margin:4px 0 10px}footer{display:flex;flex-wrap:wrap;gap:8px}pre{white-space:pre-wrap;max-height:130px;overflow:auto;background:#f5f7fa;padding:8px;border-radius:6px}';
    shadow.append(style);
    const panel = document.createElement('section');
    panel.hidden = true;
    const title = document.createElement('h2');
    title.textContent = 'Post-robot connection test';
    const help = document.createElement('p');
    help.textContent = app
        ? 'Open a linked website from this original tab. The test sends random messages only and does not read databases or passwords.'
        : 'Run the test to message the original KeeWebX window directly, without requesting a tab switch.';
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.textContent = app ? 'Waiting for a linked website.' : 'Open this website from the KeeWebX test panel.';
    const label = document.createElement('label');
    label.textContent = 'Test website (HTTPS)';
    const target = document.createElement('input');
    target.type = 'url';
    target.value = 'https://example.com/';
    target.autocomplete = 'off';
    target.spellcheck = false;
    label.append(target);
    const action = document.createElement('button');
    action.type = 'button';
    action.textContent = app ? 'Open linked website' : 'Test background reply';
    const revoke = document.createElement('button');
    revoke.type = 'button';
    revoke.textContent = 'Disconnect';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    const footer = document.createElement('footer');
    footer.append(action);
    if (app) footer.append(revoke);
    footer.append(close);
    const history = document.createElement('pre');
    history.setAttribute('aria-label', 'Test history');
    history.textContent = 'post-robot 11.0.1 · No GM storage polling';
    panel.append(title, help);
    if (app) panel.append(label);
    panel.append(status, footer, history);
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.textContent = 'Post-robot test';
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

    function record(text) {
        history.textContent = `${new Date().toLocaleTimeString()} ${text}\n${history.textContent}`.split('\n').slice(0, 8).join('\n');
    }

    function validate(event) {
        if (disposed || !child || event.source !== child || !/^https:\/\/[^/]+$/.test(event.origin)) {
            throw new Error('The source window is not linked. Link the website again from KeeWebX.');
        }
        const data = event.data;
        if (!object(data) || !id(data.clientBoot) || !id(data.nonce) ||
            !Number.isFinite(data.sentAt) || !Number.isFinite(data.deadline) ||
            data.sentAt > Date.now() + 1000 || data.deadline <= Date.now() ||
            data.deadline - data.sentAt !== TIMEOUT) {
            throw new Error('The request expired or has an invalid format.');
        }
        return data;
    }

    function snapshot(event, data) {
        return {
            appBoot: boot, clientBoot: data.clientBoot, nonce: data.nonce,
            sentAt: data.sentAt, deadline: data.deadline, repliedAt: Date.now(),
            requestOrigin: event.origin, visibility: document.visibilityState,
            focused: document.hasFocus()
        };
    }

    if (app) {
        // The window reference is the boundary for this harmless diagnostic.
        // This is NOT authorization for vault or credential access.
        listeners.push(robot.on(HELLO, { domain: /^https:\/\/[^/]+$/ }, event => {
            const data = validate(event);
            session = { clientBoot: data.clientBoot, origin: event.origin, token: crypto.randomUUID() };
            status.textContent = `Linked ${event.origin}; page marker ${boot.slice(0, 8)}.`;
            return { ...snapshot(event, data), token: session.token };
        }));
        listeners.push(robot.on(PING, { domain: /^https:\/\/[^/]+$/ }, event => {
            const data = validate(event);
            if (!session || data.clientBoot !== session.clientBoot || event.origin !== session.origin ||
                data.token !== session.token || data.appBoot !== boot) {
                throw new Error('The link is no longer valid. Connect again.');
            }
            const reply = snapshot(event, data);
            record(`Reply sent; page ${reply.visibility}; source ${event.origin}`);
            return reply;
        }));
        action.onclick = () => {
            try {
                const url = new URL(target.value);
                if (url.protocol !== 'https:' || url.username || url.password || url.origin === APP_ORIGIN) {
                    throw new Error('Choose a different HTTPS website, such as https://example.com/');
                }
                // Keep this synchronous inside the user's tap for Safari popup rules.
                const opened = window.open(url.href, `kwx-postrobot-${crypto.randomUUID()}`);
                if (!opened) throw new Error('Safari blocked the new tab. Allow pop-ups and try again.');
                child = opened;
                session = undefined;
                status.textContent = 'Linked website opened. Click "Post-robot test" on the website.';
                record(`Linked website: ${url.origin}`);
            } catch (error) { status.textContent = errorText(error); }
        };
        revoke.onclick = () => {
            child = undefined;
            session = undefined;
            status.textContent = 'Disconnected. The website tab remains open.';
            record('Link removed');
        };
    } else {
        revoke.remove();
        const original = window.opener;

        function verify(reply, request, origin, expectedAppBoot) {
            if (disposed || location.origin !== origin || Date.now() >= request.deadline ||
                !object(reply) || reply.clientBoot !== boot || reply.nonce !== request.nonce ||
                reply.sentAt !== request.sentAt || reply.deadline !== request.deadline ||
                !id(reply.appBoot) || (expectedAppBoot && reply.appBoot !== expectedAppBoot) ||
                reply.requestOrigin !== origin || !Number.isFinite(reply.repliedAt) ||
                reply.repliedAt < request.sentAt || reply.repliedAt >= request.deadline ||
                !['visible', 'hidden'].includes(reply.visibility) || typeof reply.focused !== 'boolean') {
                throw new Error('Received an expired reply, a mismatched source, or a reply for a changed page.');
            }
            return reply;
        }

        function request() {
            const sentAt = Date.now();
            return { clientBoot: boot, nonce: crypto.randomUUID(), sentAt, deadline: sentAt + TIMEOUT };
        }

        action.onclick = async () => {
            if (testing) return;
            testing = true;
            action.disabled = true;
            let phase = 'Handshake';
            let phaseStarted = performance.now();
            try {
                if (!original || original.closed) {
                    throw new Error('No usable source window. Open the website with "Open linked website" in KeeWebX; independent tabs cannot connect directly.');
                }
                const origin = location.origin;
                status.textContent = 'Handshaking with the original KeeWebX tab...';
                const helloRequest = request();
                const helloEvent = await robot.send(original, HELLO, helloRequest, { domain: APP_ORIGIN, timeout: TIMEOUT });
                const hello = verify(helloEvent.data, helloRequest, origin);
                if (!id(hello.token)) throw new Error('The handshake response is missing a link token.');
                if (lastAppBoot && lastAppBoot !== hello.appBoot) throw new Error('The original KeeWebX page reloaded. Its previous page state cannot be reused.');
                phase = 'Reply';
                phaseStarted = performance.now();
                status.textContent = 'Testing a background reply...';
                const pingRequest = { ...request(), appBoot: hello.appBoot, token: hello.token };
                const started = performance.now();
                const event = await robot.send(original, PING, pingRequest, { domain: APP_ORIGIN, timeout: TIMEOUT });
                const reply = verify(event.data, pingRequest, origin, hello.appBoot);
                const elapsed = Math.round(performance.now() - started);
                lastAppBoot = reply.appBoot;
                status.textContent = `Success: ${elapsed} ms; KeeWebX replied while ${reply.visibility}${reply.focused ? ', focused' : ', unfocused'}; page marker ${reply.appBoot.slice(0, 8)}.`;
                record(`Success ${elapsed} ms · ${reply.visibility} · page ${reply.appBoot.slice(0, 8)}`);
            } catch (error) {
                const detail = errorText(error);
                const timeout = /timeout|timed out|no ack|no response/i.test(detail);
                status.textContent = timeout
                    ? `${phase} timed out: waited about ${Math.round(performance.now() - phaseStarted)} ms (limit ${TIMEOUT} ms); no tab switch was requested.`
                    : `Test failed: ${detail}`;
                record(status.textContent);
            } finally {
                testing = false;
                action.disabled = false;
            }
        };
    }

    // A real page reload intentionally loses the app-side association. A BFCache
    // restore invalidates the old test and requires a fresh association too.
    addEventListener('pagehide', () => {
        disposed = true;
        child = undefined;
        session = undefined;
        for (const listener of listeners) listener.cancel();
    });
    addEventListener('pageshow', event => {
        if (event.persisted) {
            status.textContent = 'Page restored from cache. Reload the test page and link the website again.';
            action.disabled = true;
        }
    });
}
