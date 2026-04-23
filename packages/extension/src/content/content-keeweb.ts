declare global {
    interface Window {
        kwExtensionInstalled: boolean;
    }
}

interface KeeWebConnectTabMessage {
    kwConnect?: string;
}

if (!window.kwExtensionInstalled) {
    window.kwExtensionInstalled = true;

    chrome.runtime.onConnect.addListener((port) => {
        if (port.sender?.id !== chrome.runtime.id) {
            return;
        }
        if (!port.name) {
            return;
        }

        // On file:// in Firefox, location.origin is the string "null"
        // (opaque origin). postMessage rejects "null" as targetOrigin
        // (HTML spec: not a valid URL) — we fall back to "*" and
        // additionally require `e.source === window` so the message is
        // provably from our own document.
        const isOpaqueOrigin = location.origin === 'null';
        const targetOrigin = isOpaqueOrigin ? '*' : window.location.origin;

        const onWindowMessage = (e: MessageEvent) => {
            if (e.source !== window) {
                return;
            }
            if (!isOpaqueOrigin && e.origin !== location.origin) {
                return;
            }
            const data = e?.data as KeeWebConnectTabMessage;
            if (data?.kwConnect === 'response') {
                delete data.kwConnect;
                port.postMessage(e.data);
            }
        };

        window.addEventListener('message', onWindowMessage);
        port.onDisconnect.addListener(() => {
            window.removeEventListener('message', onWindowMessage);
        });
        port.onMessage.addListener((msg: KeeWebConnectTabMessage) => {
            msg.kwConnect = 'request';
            window.postMessage(msg, targetOrigin);
        });
    });
}

export {};
