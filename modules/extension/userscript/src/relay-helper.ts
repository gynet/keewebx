import { AppBroker } from './app-bridge';
import { RelayClientBridge } from './relay';
import { ConnectUI } from './connect-ui';
import { BackendConnectionState as State } from '../../src/common/backend-connection-state';
import { WINDOW_NAME } from './settings';

export const SETUP_MARK = 'keewebx-connect-relay-setup-v1';

/** A top-level same-origin rendezvous page; no vault is opened here. */
export function startRelayHelper(endpoint: URL): void {
    window.name = WINDOW_NAME;
    const ui = new ConnectUI(true, endpoint.href);
    document.getElementById('connect-helper-loading')?.remove();
    ui.host.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;padding:16px;z-index:2147483647;';
    ui.panel.style.cssText = 'position:relative;inset:auto;width:min(420px,calc(100vw - 32px));max-height:calc(100dvh - 32px);';
    ui.toggle.hidden = true;
    (ui.panel.querySelector('[data-action=close]') as HTMLElement).hidden = true;
    (ui.panel.querySelector('.tabs') as HTMLElement).hidden = true;
    ui.address.readOnly = true; ui.save.hidden = true; ui.authorize.hidden = true;
    ui.targetSite.parentElement!.hidden = true;
    ui.open.textContent = 'Open new KeeWebX';
    ui.revoke.textContent = 'Find app tabs again';
    ui.returnToSite.className = 'primary';
    ui.returnToSite.disabled = true;
    ui.panel.querySelectorAll('.note')[ui.panel.querySelectorAll('.note').length - 1].textContent = 'Confirm in the existing KeeWebX tab you want to use. No database is opened on this connection page.';
    ui.show('config');
    const opener = window.opener as Window | null;
    let relay: RelayClientBridge | undefined;
    let broker: AppBroker | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    let readiness: ReturnType<typeof setInterval> | undefined;
    let readinessDeadline = Date.now() + 8000;
    let nonce = crypto.randomUUID();
    let siteOrigin: string | undefined;
    const cleanup = () => { clearTimeout(fallback); clearInterval(readiness); broker?.dispose(); broker = undefined; relay?.dispose(); relay = undefined; };
    const openNewApp = () => {
        cleanup();
        const url = new URL(endpoint); url.searchParams.set('kwx-connect', '1');
        location.replace(url.href);
    };
    const discover = () => {
        cleanup();
        if (!siteOrigin || !opener || opener.closed) { ui.state(State.Error, 'Open this connection page from the key icon on your login website.'); return; }
        relay = new RelayClientBridge(endpoint, siteOrigin, (state, count) => {
            if (state === 'searching') ui.state(State.Connecting, 'Finding existing KeeWebX tabs...');
            if (state === 'available') { clearTimeout(fallback); ui.state(State.ReadyToConnect, `Found ${count} KeeWebX tab(s). Confirm Connect this tab in the app you want to use.`); }
            if (state === 'confirming') { clearTimeout(fallback); ui.state(State.Connecting, 'App selected. Complete authorization in that KeeWebX tab.'); }
            if (state === 'connected') {
                clearTimeout(fallback);
                if (!broker && relay) { broker = new AppBroker(relay); broker.associate(opener, siteOrigin); }
                ui.returnToSite.disabled = false;
                ui.state(State.Connected, 'Connected to the selected KeeWebX tab. Return to the website to find accounts.');
            }
            if (state === 'disconnected') { ui.returnToSite.disabled = true; ui.state(State.ReadyToConnect, 'The selected app disconnected. Find app tabs again to reconnect.'); }
        });
        relay.onReturn = () => { if (!opener.closed) opener.focus(); };
        relay.discover();
        fallback = setTimeout(() => { if (relay && !relay.candidateCount) openNewApp(); }, 2500);
    };
    ui.open.onclick = event => { if (event.isTrusted) openNewApp(); };
    ui.revoke.onclick = event => { if (event.isTrusted) restart(); };
    ui.returnToSite.onclick = event => { if (event.isTrusted && opener && !opener.closed) opener.focus(); };
    const ready = () => {
        if (Date.now() >= readinessDeadline) { clearInterval(readiness); ui.state(State.Error, 'The login website did not reply. Reopen Connect from its key icon.'); return; }
        // This is a non-secret readiness challenge. All later replies use an exact origin.
        opener?.postMessage({ marker: SETUP_MARK, kind: 'ready', nonce }, '*');
    };
    const restart = () => {
        cleanup(); ui.returnToSite.disabled = true; siteOrigin = undefined; nonce = crypto.randomUUID();
        readinessDeadline = Date.now() + 8000; ready(); readiness = setInterval(ready, 400);
    };
    addEventListener('message', event => {
        if (event.isTrusted && event.source === opener && /^https:\/\/[^/]+$/.test(event.origin) &&
            event.data?.marker === SETUP_MARK && event.data.kind === 'reconnect') {
            if (event.origin !== siteOrigin || !relay?.connected) restart();
            return;
        }
        if (!event.isTrusted || event.source !== opener || !/^https:\/\/[^/]+$/.test(event.origin) ||
            event.data?.marker !== SETUP_MARK || event.data.kind !== 'site' || event.data.nonce !== nonce || siteOrigin) return;
        siteOrigin = event.origin; clearInterval(readiness); discover();
    });
    addEventListener('pagehide', cleanup);
    addEventListener('pageshow', event => {
        if (event.persisted) restart();
    });
    ui.state(State.Connecting, 'Connecting to the login website...');
    ready(); readiness = setInterval(ready, 400);
}
