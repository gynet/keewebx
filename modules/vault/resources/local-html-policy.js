// Local HTML keeps configured services, without contacting KeeWebX servers.
if (location.protocol === 'file:') {
    const policy = document.createElement('meta');
    policy.httpEquiv = 'Content-Security-Policy';
    policy.content = "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' blob:; font-src 'self' data:; img-src 'self' data: blob: https://icons.duckduckgo.com; connect-src https: wss: http://localhost:* http://127.0.0.1:* http://[::1]:*; worker-src blob:; frame-src 'none'; object-src 'none'; manifest-src 'self'; base-uri 'self'; form-action 'none'";
    document.head.appendChild(policy);
    document.documentElement.dataset.localHtml = 'true';
    const allow = input => {
        const address = input && typeof input === 'object' && 'url' in input ? input.url : input;
        const url = new URL(address, document.baseURI);
        const host = url.hostname.replace(/\.+$/, '');
        if (host === 'keewebx.app' || host.endsWith('.keewebx.app')) {
            throw new TypeError('Local HTML does not connect to KeeWebX servers.');
        }
    };
    const fetch = window.fetch;
    window.fetch = function (input, init) {
        try { allow(input); } catch (error) { return Promise.reject(error); }
        return fetch.call(this, input, init);
    };
    const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
        allow(url);
        return open.apply(this, arguments);
    };
    const beacon = navigator.sendBeacon;
    if (beacon) navigator.sendBeacon = function (url, data) {
        try { allow(url); } catch { return false; }
        return beacon.call(this, url, data);
    };
    for (const name of ['WebSocket', 'EventSource']) {
        if (typeof window[name] !== 'function') continue;
        window[name] = new Proxy(window[name], {
            construct(target, args, constructor) {
                allow(args[0]);
                return Reflect.construct(target, args, constructor);
            }
        });
    }
}
