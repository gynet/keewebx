import { ProtocolImpl, type KeeWebXEntry } from '../../src/background/protocol/protocol-impl';
import { BackendConnectionState as State } from '../../src/common/backend-connection-state';
import { NativeRpc } from './native-rpc';
import { AppBridge, AppBroker } from './app-bridge';
import { ConnectUI } from './connect-ui';
import { identity } from './identity';
import { RelayHost } from './relay';
import { SETUP_MARK, startRelayHelper } from './relay-helper';
import { DEFAULT_ENDPOINT, WINDOW_NAME, findOrOpenApp, loadEndpoint, saveEndpoint } from './settings';
import { eligible, targets, assertTargets, fill, matchesOrigin, type Targets } from './form-targets';

const runtime = { getVersion: () => '0.3.0', getMessage: (key: string) => key === 'errorAppReturnedError' ? 'KeeWebX returned an error' : key, allowDebug: false };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

async function start(): Promise<void> {
    if (window.top !== window || location.protocol !== 'https:') return;
    let endpoint: URL;
    try { endpoint = await loadEndpoint(); } catch { endpoint = new URL(DEFAULT_ENDPOINT); }
    if (location.origin === endpoint.origin && location.pathname === new URL('connect.html', endpoint).pathname && new URL(location.href).searchParams.has('kwx-connect-relay')) { startRelayHelper(endpoint); return; }
    const app = location.origin === endpoint.origin && location.pathname.replace(/\/$/, '') === endpoint.pathname.replace(/\/$/, '');
    const ui = new ConnectUI(app, endpoint.href);
    let original: Window | undefined = app ? undefined : window.opener || undefined;
    let openedByUs = false;
    let knownIdentity = false;
    let selected: HTMLInputElement | undefined;
    let current: { rpc: NativeRpc; protocol: ProtocolImpl; target: Targets; origin: string } | undefined;
    let selecting = false;
    let generation = 0;
    let inFlight: NativeRpc | undefined;
    const clean = () => {
        generation++;
        inFlight?.dispose(); inFlight = undefined;
        current?.rpc.dispose(); current = undefined;
        selecting = false; ui.clear(); ui.busy(false);
    };
    const assertOperation = (epoch: number) => { if (epoch !== generation) throw new Error('The operation was canceled. Find accounts again.'); };
    const refreshIdentity = () => { void identity().then(() => { knownIdentity = true; }).catch(() => { knownIdentity = false; }); };
    refreshIdentity();
    addEventListener('visibilitychange', () => { if (!document.hidden) refreshIdentity(); });
    ui.onClose = clean;
    ui.save.onclick = async event => {
        if (!event.isTrusted) return;
        clean(); original = undefined; openedByUs = false;
        const epoch = generation;
        ui.save.disabled = true;
        try {
            endpoint = await saveEndpoint(ui.address.value);
            assertOperation(epoch);
            ui.state(State.ReadyToConnect, 'Address saved. The next connection will use this address.');
        } catch (error) { if (epoch === generation) ui.state(State.Error, message(error)); }
        finally { ui.save.disabled = false; }
    };

    if (app) {
        if (window.opener) window.name = WINDOW_NAME;
        let bridge = new AppBridge();
        let broker = new AppBroker(bridge);
        let authorizationGeneration = 0;
        let resumeChild: Window | undefined;
        let relayHost = new RelayHost(endpoint, request => { ui.pairing(request?.site); ui.authorize.hidden = !!request; }, () => { if (relayPairing) cancelAuthorization(); });
        let relayPairing = false;
        const cancelAuthorization = () => {
            authorizationGeneration++; broker.clear(); broker.authorizing = false; ui.authorize.disabled = false;
            if (relayPairing) relayHost.revoke();
        };
        ui.onClose = () => { clean(); if (broker.authorizing || relayPairing) cancelAuthorization(); };
        ui.address.readOnly = true; ui.save.hidden = true;
        if (window.opener && window.opener !== window) broker.associate(window.opener);
        ui.open.textContent = 'Open linked website';
        ui.open.onclick = event => {
            if (!event.isTrusted) return;
            try {
                const target = new URL(ui.targetSite.value);
                if (target.protocol !== 'https:' || target.username || target.password || target.origin === location.origin) throw new Error('Enter a different HTTPS login website.');
                const site = window.open(target.href, `KeeWebXLogin-${crypto.randomUUID()}`);
                if (!site) throw new Error('Safari blocked the new tab. Allow pop-ups and try again.');
                broker.associate(site);
                ui.state(State.ReadyToConnect, 'Website opened. Authorize Connect here before using it for the first time.');
            } catch (error) { ui.state(State.Error, message(error)); }
        };
        ui.returnToSite.onclick = event => {
            if (!event.isTrusted) return;
            try {
                if (relayHost.connected) { relayHost.returnToSite(); ui.state(State.Connected, 'Return to your login website. If Safari did not switch tabs, select the website tab manually.'); return; }
                if (!broker.child || broker.child.closed) throw new Error('No website is linked. Open KeeWebX from the website, or click "Open linked website".');
                broker.child.focus();
            } catch (error) { ui.state(State.Error, message(error)); }
        };
        ui.revoke.onclick = event => { if (event.isTrusted) { cancelAuthorization(); relayHost.revoke(); broker.revoke(); ui.state(State.ReadyToConnect, 'Disconnected.'); } };
        const authorize = async (guard = () => {}, deadline = () => Date.now() + 65000): Promise<boolean> => {
            if (broker.authorizing) return false;
            const epoch = ++authorizationGeneration;
            const assertAuthorization = () => { if (epoch !== authorizationGeneration) throw new Error('Authorization was canceled.'); guard(); };
            broker.authorizing = true; broker.clear(); ui.authorize.disabled = true;
            ui.state(State.Connecting, 'Connecting. Approve account listing in the KeeWebX dialog.');
            try {
                const keys = await identity(true);
                assertAuthorization();
                const authorizationBridge = bridge;
                const protocol = new ProtocolImpl({ request: request => { assertAuthorization(); return authorizationBridge.request(request, deadline()); } }, runtime);
                await protocol.ping(); await protocol.changePublicKeys(); await protocol.pair(keys);
                assertAuthorization();
                if ((await protocol.features()).locked) throw new Error('Unlock the KeeWebX database before authorizing Connect.');
                const list = await protocol.getEntries(undefined, undefined);
                assertAuthorization();
                if (list.locked || !(await protocol.features()).canList) throw new Error('Allow account listing before continuing.');
                assertAuthorization();
                knownIdentity = true;
                ui.state(State.Connected, 'Authorized. Return to the website to find and fill matching accounts.');
                return true;
            } catch (error) { if (epoch === authorizationGeneration) ui.state(State.Error, message(error)); return false; }
            finally { if (epoch === authorizationGeneration) { broker.clear(); broker.authorizing = false; ui.authorize.disabled = false; } }
        };
        ui.authorize.onclick = event => { if (event.isTrusted && !relayPairing) void authorize(); };
        ui.pair.onclick = async event => {
            if (!event.isTrusted || relayPairing || broker.authorizing) return;
            const pairingHost = relayHost;
            relayPairing = true; ui.pair.disabled = true; ui.authorize.disabled = true;
            try {
                await pairingHost.reserve();
                if (pairingHost !== relayHost) throw new Error('The app page changed during pairing.');
                pairingHost.beginAuthorization();
                broker.revoke();
                if (!await authorize(() => pairingHost.assertAuthorization(), () => pairingHost.authorizationDeadline)) throw new Error('Authorization was not completed. Find app tabs again to retry.');
                pairingHost.complete();
            } catch (error) { pairingHost.revoke(); if (pairingHost === relayHost) ui.state(State.Error, message(error)); }
            finally { if (pairingHost === relayHost) { relayPairing = false; ui.pair.disabled = false; ui.authorize.disabled = false; } }
        };
        ui.decline.onclick = event => { if (event.isTrusted) { if (relayPairing) cancelAuthorization(); else relayHost.decline(); } };
        ui.probe.hidden = true;
        let setupObserver: MutationObserver | undefined;
        if (new URL(location.href).searchParams.has('kwx-connect')) {
            const showAfterUnlock = () => {
                if (!document.querySelector('.vault')) return;
                setupObserver?.disconnect(); ui.show('config');
            };
            setupObserver = new MutationObserver(showAfterUnlock);
            setupObserver.observe(document.body, { childList: true, subtree: true });
            showAfterUnlock();
        }
        addEventListener('pagehide', () => {
            authorizationGeneration++; resumeChild = broker.child;
            setupObserver?.disconnect();
            relayHost.dispose(); broker.dispose(); bridge.dispose(); ui.authorize.disabled = false;
        });
        addEventListener('pageshow', event => {
            if (event.persisted) {
                bridge = new AppBridge(); broker = new AppBroker(bridge);
                relayHost = new RelayHost(endpoint, request => { ui.pairing(request?.site); ui.authorize.hidden = !!request; }, () => { if (relayPairing) cancelAuthorization(); }); relayPairing = false; ui.pair.disabled = false;
                if (resumeChild && !resumeChild.closed) broker.associate(resumeChild);
                ui.state(State.ReadyToConnect, 'Page restored. Return to the website and find accounts again.');
            }
        });
        return;
    }

    addEventListener('message', event => {
        if (event.isTrusted && event.source === original && event.origin === endpoint.origin && event.data?.marker === SETUP_MARK &&
            event.data.kind === 'ready' && typeof event.data.nonce === 'string') {
            original?.postMessage({ marker: SETUP_MARK, kind: 'site', nonce: event.data.nonce }, endpoint.origin);
        }
    });

    const openApp = () => {
        clean();
        original = findOrOpenApp(endpoint, openedByUs ? original : undefined);
        openedByUs = true;
        original.postMessage({ marker: SETUP_MARK, kind: 'reconnect' }, endpoint.origin);
        ui.hide();
        ui.state(State.ReadyToConnect, 'KeeWebX opened. Confirm in the app tab you want to use, then return to this website.');
    };
    ui.open.onclick = event => { if (event.isTrusted) try { openApp(); } catch (error) { ui.state(State.Error, message(error)); } };

    function rpc(epoch = generation): NativeRpc {
        if (!original || original.closed) throw new Error('Open KeeWebX first.');
        return new NativeRpc(original, (text, locked) => {
            if (epoch !== generation) return;
            if (locked) clean();
            ui.state(locked ? State.ReadyToConnect : State.Connecting, text);
        }, endpoint.origin);
    }

    ui.probe.onclick = async event => {
        if (!event.isTrusted) return;
        if (!original || original.closed) { try { openApp(); } catch (error) { ui.state(State.Error, message(error)); } return; }
        clean(); ui.busy(true); ui.state(State.Connecting, 'Testing the native message connection...');
        const epoch = generation;
        const connection = rpc();
        inFlight = connection;
        const started = performance.now();
        try {
            await connection.connect();
            assertOperation(epoch);
            const result = await connection.call('probe', undefined, 5000);
            assertOperation(epoch);
            ui.state(State.Connected, `Native postMessage: ${Math.round(performance.now() - started)} ms; KeeWebX ${result.visibility}; page ${String(result.appBoot).slice(0, 8)}.`);
        } catch (error) { if (epoch === generation) ui.state(State.Error, message(error)); }
        finally { connection.dispose(); if (inFlight === connection) inFlight = undefined; if (epoch === generation) ui.busy(false); }
    };

    async function choose(entry: KeeWebXEntry): Promise<void> {
        const active = current;
        if (!active || selecting) return;
        const epoch = generation;
        selecting = true; ui.busy(true);
        try {
            active.rpc.assertCurrent(); assertTargets(active.target);
            if (!matchesOrigin(entry.url, active.origin) || location.origin !== active.origin) throw new Error('The account website does not match. Filling stopped.');
            const fields = [...(active.target.user ? ['user'] : []), ...(active.target.password ? ['password'] : [])];
            const values = await active.protocol.getEntryFields(entry.handle, fields);
            assertOperation(epoch);
            active.rpc.assertCurrent(); assertTargets(active.target);
            const features = await active.protocol.features();
            assertOperation(epoch);
            if (current !== active || features.locked || !features.canList || !features.paired) throw new Error('The database or authorization changed. Filling stopped.');
            active.rpc.assertCurrent(); assertTargets(active.target);
            fill(active.target, values, () => { assertOperation(epoch); active.rpc.assertCurrent(); if (current !== active) throw new Error('The account selection is no longer valid.'); });
            ui.hide();
            ui.state(State.Connected, 'Filled the account details. The form was not submitted.');
        } catch (error) { if (epoch === generation) { clean(); ui.state(State.Error, message(error)); } }
        finally { if (epoch === generation) { selecting = false; ui.busy(false); } }
    }

    const lookup = async (event: MouseEvent) => {
        if (!event.isTrusted) return;
        if (ui.lookup.disabled || selecting) return;
        if (!original || original.closed || (!knownIdentity && !openedByUs)) {
            try { openApp(); } catch (error) { ui.state(State.Error, message(error)); } return;
        }
        clean(); ui.busy(true); ui.state(State.Connecting, 'Finding accounts for this website...');
        const epoch = generation;
        let connection: NativeRpc | undefined;
        try {
            const target = targets(selected);
            const origin = location.origin;
            const keys = await identity(); assertOperation(epoch); knownIdentity = true;
            connection = rpc(epoch); inFlight = connection;
            await connection.connect();
            assertOperation(epoch);
            const protocol = new ProtocolImpl({ request: request => connection!.call('wire', request) }, runtime);
            await protocol.ping(); await protocol.changePublicKeys();
            assertOperation(epoch);
            if (!await protocol.pair(keys)) throw new Error('Complete the initial authorization in the KeeWebX userscript panel first.');
            assertOperation(epoch);
            const features = await protocol.features();
            assertOperation(epoch);
            if (features.locked) throw new Error('The database is locked. Open KeeWebX to unlock it.');
            if (!features.paired || !features.canList) throw new Error('Authorize account listing in the KeeWebX userscript panel.');
            const list = await protocol.getEntries(location.origin, undefined);
            assertOperation(epoch);
            connection.assertCurrent(); assertTargets(target);
            if (list.locked) throw new Error('The database is locked.');
            const entries = list.suggested.filter(entry => matchesOrigin(entry.url, origin)).slice(0, 10);
            current = { rpc: connection, protocol, target, origin };
            inFlight = undefined;
            ui.clear();
            if (!entries.length) ui.empty('No matching accounts for this website. Check the website address in your KeeWebX entries.');
            entries.forEach((entry, index) => ui.entry(index, entry.title, entry.user, () => { void choose(entry); }));
            ui.state(State.Connected, entries.length ? `Found ${entries.length} matching account(s). Select one to fill.` : 'Connected. No matching accounts found.');
            ui.show('accounts');
        } catch (error) {
            connection?.dispose();
            if (epoch === generation) { clean(); ui.state(State.Error, message(error)); }
        } finally { if (epoch === generation) ui.busy(false); }
    };
    ui.lookup.onclick = lookup;
    ui.onOpen = event => { if (eligible(selected)) void lookup(event); };

    document.addEventListener('focusin', event => {
        const field = event.composedPath()[0];
        if (eligible(field)) { selected = field; ui.anchor(field); }
    }, true);
    const invalidate = () => { if ((current && current.rpc.href !== location.href) || (inFlight && inFlight.href !== location.href)) { clean(); ui.state(State.ReadyToConnect, 'The page changed. Find accounts again.'); } };
    addEventListener('popstate', invalidate); addEventListener('hashchange', invalidate);
    addEventListener('pagehide', clean);
    addEventListener('visibilitychange', () => {
        if (document.hidden) { clean(); ui.state(State.ReadyToConnect, 'Find accounts again when you return.'); }
    });
    addEventListener('pageshow', event => { if (event.persisted) { clean(); ui.state(State.ReadyToConnect, 'Page restored. Find accounts again.'); } });
}

void start().catch(error => {
    // Startup occurs before any credential operation; report only the error class.
    console.warn('KeeWebX Connect initialization failed. Check Userscripts permissions.', error instanceof Error ? error.name : 'InitializationError');
});
