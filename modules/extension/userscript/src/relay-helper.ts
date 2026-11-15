import { AppBroker } from './app-bridge';
import { RelayClientBridge } from './relay';
import { ConnectUI } from './connect-ui';
import { BackendConnectionState as State } from '../../src/common/backend-connection-state';
import { WINDOW_NAME } from './settings';
import { SiteLink } from './site-link';

/** A top-level same-origin rendezvous page; no vault is opened here. */
export function startRelayHelper(endpoint: URL): void {
    if (!window.name) window.name = WINDOW_NAME;
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
    let opener = window.opener as Window | null;
    let relay: RelayClientBridge | undefined;
    let broker: AppBroker | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    let siteOrigin: string | undefined;
    const cleanup = () => { clearTimeout(fallback); broker?.dispose(); broker = undefined; relay?.dispose(); relay = undefined; };
    const openNewApp = () => {
        cleanup(); siteLink.pause();
        const url = new URL(endpoint); url.searchParams.set('kwx-connect', '1');
        location.replace(url.href);
    };
    const discover = () => {
        cleanup();
        if (!siteOrigin || !opener || opener.closed) { ui.state(State.Error, 'Open this connection page from the key icon on your login website.'); return; }
        relay = new RelayClientBridge(endpoint, siteOrigin, (state, count) => {
            if (state === 'searching') ui.state(State.Connecting, 'Finding existing KeeWebX tabs. Open the app tab you want to connect.');
            if (state === 'available') { clearTimeout(fallback); ui.state(State.ReadyToConnect, `Found ${count} KeeWebX tab(s). Confirm Connect this tab in the app you want to use.`); }
            if (state === 'confirming') { clearTimeout(fallback); ui.state(State.Connecting, 'App selected. Complete authorization in that KeeWebX tab.'); }
            if (state === 'connected') {
                clearTimeout(fallback);
                if (!broker && relay && opener) { broker = new AppBroker(relay); broker.associate(opener, siteOrigin); }
                ui.returnToSite.disabled = false;
                ui.state(State.Connected, 'Connected to the selected KeeWebX tab. Return to the website to find accounts.');
            }
            if (state === 'disconnected') { ui.returnToSite.disabled = true; ui.state(State.ReadyToConnect, 'The selected app disconnected. Find app tabs again to reconnect.'); }
        });
        relay.onReturn = () => { if (opener && !opener.closed) opener.focus(); };
        relay.discover();
        fallback = setTimeout(() => { if (relay && !relay.candidateCount) openNewApp(); }, 8000);
    };
    ui.open.onclick = event => { if (event.isTrusted) openNewApp(); };
    ui.revoke.onclick = event => { if (event.isTrusted) restart(); };
    ui.returnToSite.onclick = event => { if (event.isTrusted && opener && !opener.closed) opener.focus(); };
    const siteLink = new SiteLink(opener, (peer, origin) => {
        const changed = opener !== peer;
        window.name = `${WINDOW_NAME}:${origin}`;
        opener = peer; siteOrigin = origin;
        if (relay?.connected && broker) {
            if (changed) broker.associate(peer, origin);
            ui.returnToSite.disabled = false;
            ui.state(State.Connected, 'Connected to the selected KeeWebX tab. Return to the website to find accounts.');
        } else if (!relay) discover();
    }, expired => {
        if (!relay?.connected) ui.state(State.Connecting, expired
            ? 'Waiting for the login website. Return to its tab to resume Connect.'
            : 'Connecting to the login website...');
    });
    const restart = () => {
        cleanup(); ui.returnToSite.disabled = true; siteLink.restart();
    };
    addEventListener('pagehide', () => { cleanup(); siteLink.pause(); });
    addEventListener('pageshow', event => {
        if (event.persisted) restart();
    });
    addEventListener('visibilitychange', () => { if (!document.hidden && !relay?.connected) siteLink.restart(); });
    siteLink.restart();
}
