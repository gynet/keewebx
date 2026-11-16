import { ProtocolImpl, type KeeWebXEntry } from '../../src/background/protocol/protocol-impl';
import { BackendConnectionState as State } from '../../src/common/backend-connection-state';
import { AppBridge } from './app-bridge';
import { ConnectUI } from './connect-ui';
import { approvedRoute, NativeHost, NativeRpc, managerCall, openConnector, startConnector, connectorTabId, registerConnector } from './native-connect';
import { identity } from './identity';
import { DEFAULT_ENDPOINT, loadEndpoint, saveEndpoint } from './settings';
import { eligible, targets, assertTargets, fill, matchesOrigin, type Targets } from './form-targets';

const VERSION = '0.5.1';
const runtime = { getVersion: () => VERSION, getMessage: (key: string) => key === 'errorAppReturnedError' ? 'KeeWebX returned an error' : key, allowDebug: false };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

async function start(): Promise<void> {
    if (window.top !== window || location.protocol !== 'https:') return;
    let endpoint: URL;
    try { endpoint = await loadEndpoint(); } catch { endpoint = new URL(DEFAULT_ENDPOINT); }
    if (location.origin === endpoint.origin && location.pathname === new URL('connect.html', endpoint).pathname && new URL(location.href).searchParams.get('kwx-native') === '1') {
        startConnector(endpoint);
        return;
    }
    const app = location.origin === endpoint.origin && location.pathname.replace(/\/$/, '') === endpoint.pathname.replace(/\/$/, '');
    const ui = new ConnectUI(app, endpoint.href);
    const version = document.createElement('p');
    version.className = 'status'; version.dataset.role = 'version'; version.textContent = `Connect ${VERSION}`;
    ui.panel.append(version);
    if (app) {
        const host = new NativeHost(endpoint, error => ui.state(State.Error, message(error)));
        const bridge = new AppBridge();
        let generation = 0, authorizing = false, attempted = false, revoked = false, authorized = false, restoreRequested = false;
        ui.address.readOnly = true; ui.save.hidden = true; ui.open.hidden = true;
        ui.returnToSite.hidden = true; ui.pair.hidden = true; ui.decline.hidden = true;
        ui.targetSite.parentElement!.hidden = true;
        ui.authorize.textContent = 'Authorize Connect';
        ui.panel.querySelectorAll('.note')[ui.panel.querySelectorAll('.note').length - 1].textContent = 'Authorize this app once for all websites. Lookups use this tab without opening another page.';
        const authorize = async (explicit: boolean) => {
            if (authorizing) return;
            authorizing = true; ui.authorize.disabled = true;
            const epoch = ++generation;
            const guard = () => { if (epoch !== generation) throw new Error('Authorization was canceled.'); };
            try {
                const keys = await managerCall(() => identity(explicit)); guard();
                if (!explicit && !await host.selected()) return;
                const protocol = new ProtocolImpl({ request: request => { guard(); return bridge.request(request, Date.now() + (explicit ? 65000 : 8000)); } }, runtime);
                await protocol.ping(); await protocol.changePublicKeys(); await protocol.pair(keys); guard();
                let features = await protocol.features(); guard();
                if (features.locked) {
                    if (explicit) throw new Error('Unlock this database, then authorize Connect once.');
                    return;
                }
                if (explicit && !features.canList) {
                    ui.state(State.Connecting, 'Approve account listing in the KeeWebX dialog. This authorization works for all websites.');
                    const list = await protocol.getEntries(undefined, undefined); guard();
                    if (list.locked) throw new Error('Unlock this database before authorizing Connect.');
                    features = await protocol.features(); guard();
                }
                if (!features.paired || !features.canList) {
                    if (explicit) throw new Error('Allow account listing to enable Connect for all websites.');
                    return;
                }
                await host.authorize(keys, () => epoch === generation); guard(); revoked = false; authorized = true;
                ui.state(State.Connected, 'Authorized. All websites can use this tab. Return to your website and select an account.');
                ui.authorize.textContent = 'Use this tab for all websites';
            } catch (error) { if (epoch === generation && explicit) ui.state(State.Error, message(error)); }
            finally {
                if (epoch === generation) {
                    authorizing = false; ui.authorize.disabled = false; bridge.reset();
                    const retry = !explicit && restoreRequested && !authorized && !revoked;
                    restoreRequested = false;
                    if (retry) queueMicrotask(retryRestore);
                }
            }
        };
        ui.authorize.onclick = event => { if (event.isTrusted) void authorize(true); };
        ui.revoke.onclick = event => {
            if (!event.isTrusted) return;
            revoked = true; authorized = false; restoreRequested = false; generation++; authorizing = false; bridge.reset(); ui.authorize.disabled = false;
            void host.revoke().then(() => ui.state(State.ReadyToConnect, 'Disconnected. Authorize this tab once to enable all websites again.'));
        };
        ui.onClose = () => {
            if (authorizing) { generation++; authorizing = false; host.pause(); bridge.reset(); ui.authorize.disabled = false; }
        };
        const restored = () => {
            const unlocked = !!document.querySelector('.vault');
            if (!unlocked) {
                if (authorized) { host.lock(); ui.state(State.ReadyToConnect, 'KeeWebX is locked. Unlock this tab to resume Connect.'); }
                attempted = false; authorized = false; return;
            }
            if (attempted || revoked || authorizing) return;
            attempted = true; void authorize(false);
        };
        new MutationObserver(restored).observe(document.body, { childList: true, subtree: true });
        restored();
        // A transient startup failure must not permanently consume restoration.
        // Retry on an actual app return without prompting or changing the vault.
        const retryRestore = () => {
            if (document.hidden || authorized || revoked) return;
            if (authorizing) { restoreRequested = true; return; }
            attempted = false; restored();
        };
        ui.onOpen = retryRestore;
        addEventListener('focus', retryRestore);
        addEventListener('visibilitychange', retryRestore);
        if (new URL(location.href).searchParams.has('kwx-connect')) ui.show('config');
        addEventListener('pagehide', event => {
            generation++; authorizing = false; bridge.reset();
            if (event.persisted) host.pause(); else void host.revoke();
        });
        addEventListener('pageshow', event => { if (event.persisted) { host.resume(); attempted = false; restored(); } });
        return;
    }

    let selected: HTMLInputElement | undefined;
    let connector: Window | undefined;
    let clientId: string | undefined;
    const register = () => {
        if (clientId) registerConnector(endpoint, clientId, peer => {
            if (!connector || connector.closed) {
                connector = peer;
                ui.state(State.ReadyToConnect, 'Connection page linked to this browser tab. Find accounts to continue.');
            }
        });
    };
    void connectorTabId().then(id => { clientId = id; register(); }).catch(error => ui.state(State.Error, message(error)));
    let generation = 0, selecting = false;
    let pending: NativeRpc | undefined;
    let current: { rpc: NativeRpc; protocol: ProtocolImpl; target: Targets; origin: string } | undefined;
    const clean = () => {
        generation++; pending?.dispose(); pending = undefined; current?.rpc.dispose(); current = undefined;
        selecting = false; ui.clear(); ui.busy(false);
        ui.state(State.ReadyToConnect, 'Connection test or lookup stopped. You can retry.');
    };
    const guard = (epoch: number) => { if (epoch !== generation) throw new Error('The operation was canceled. Find accounts again.'); };
    ui.onClose = clean;
    ui.onConfig = () => { clean(); ui.state(State.ReadyToConnect, 'Your authorized KeeWebX tab is used on every website. Test the connection here.'); };
    ui.save.onclick = async event => {
        if (!event.isTrusted) return;
        clean(); const epoch = generation;
        try { endpoint = await saveEndpoint(ui.address.value); guard(epoch); connector = undefined; register(); ui.state(State.ReadyToConnect, 'Address saved. Authorize that KeeWebX tab once.'); }
        catch (error) { if (epoch === generation) ui.state(State.Error, message(error)); }
    };
    ui.open.textContent = 'Open connection page';
    const openConnection = () => {
        clean();
        try {
            if (!clientId) throw new Error('Connection settings are not ready. Reopen the panel and retry.');
            connector = openConnector(endpoint, clientId, connector);
            ui.state(State.ReadyToConnect, 'Connection page opened. Return here and find accounts. Keep that page open.');
        } catch (error) { ui.state(State.Error, message(error)); }
    };
    ui.open.onclick = event => { if (event.isTrusted) openConnection(); };
    const setup = () => { ui.show('config'); ui.state(State.ReadyToConnect, 'Authorize Connect once in your existing KeeWebX tab, then return here and find accounts.'); };

    async function choose(entry: KeeWebXEntry): Promise<void> {
        const active = current;
        if (!active || selecting) return;
        const epoch = generation;
        selecting = true; ui.busy(true);
        try {
            active.rpc.assertCurrent(); assertTargets(active.target);
            await active.rpc.assertSelected(); guard(epoch);
            if (!matchesOrigin(entry.url, active.origin) || location.origin !== active.origin) throw new Error('The account website does not match. Filling stopped.');
            const before = await active.protocol.features(); guard(epoch);
            if (before.locked || !before.canList || !before.paired) throw new Error('The database is locked or access was revoked. Unlock the existing KeeWebX tab.');
            const fields = [...(active.target.user ? ['user'] : []), ...(active.target.password ? ['password'] : [])];
            const values = await active.protocol.getEntryFields(entry.handle, fields); guard(epoch);
            active.rpc.assertCurrent(); assertTargets(active.target);
            const features = await active.protocol.features(); guard(epoch);
            if (current !== active || features.locked || !features.canList || !features.paired) throw new Error('The database or authorization changed. Filling stopped.');
            active.rpc.assertCurrent(); assertTargets(active.target);
            await active.rpc.assertSelected(); guard(epoch);
            fill(active.target, values, () => { guard(epoch); active.rpc.assertCurrent(); if (current !== active) throw new Error('The account selection is no longer valid.'); });
            ui.hide(); ui.state(State.Connected, 'Filled the account details. The form was not submitted.');
        } catch (error) { if (epoch === generation) { clean(); ui.state(State.Error, message(error)); } }
        finally { if (epoch === generation) { selecting = false; ui.busy(false); } }
    }
    const lookup = async (event: MouseEvent) => {
        if (!event.isTrusted || ui.lookup.disabled || selecting) return;
        clean(); ui.busy(true); ui.state(State.Connecting, 'Finding accounts in your authorized KeeWebX tab...');
        const epoch = generation;
        let rpc: NativeRpc | undefined;
        try {
            const target = targets(selected), origin = location.origin;
            if (!await approvedRoute(endpoint)) { guard(epoch); setup(); return; }
            const keys = await managerCall(() => identity()); guard(epoch);
            rpc = new NativeRpc(endpoint, () => connector); pending = rpc; await rpc.connect(); guard(epoch);
            const protocol = new ProtocolImpl({ request: request => rpc!.call('wire', request) }, runtime);
            await protocol.ping(); await protocol.changePublicKeys();
            if (!await protocol.pair(keys)) throw new Error('Authorize Connect once in your KeeWebX tab.');
            guard(epoch);
            const features = await protocol.features(); guard(epoch);
            if (features.locked) throw new Error('The database is locked. Unlock the existing KeeWebX tab.');
            if (!features.canList || !features.paired) throw new Error('Connect access was revoked. Authorize it again in KeeWebX.');
            const list = await protocol.getEntries(origin, undefined); guard(epoch);
            rpc.assertCurrent(); assertTargets(target);
            if (list.locked) throw new Error('The database is locked.');
            const entries = list.suggested.filter(entry => matchesOrigin(entry.url, origin)).slice(0, 10);
            current = { rpc, protocol, target, origin }; pending = undefined; ui.clear();
            if (!entries.length) ui.empty('No matching accounts for this website.');
            entries.forEach((entry, index) => ui.entry(index, entry.title, entry.user, () => { void choose(entry); }));
            ui.state(State.Connected, entries.length ? `Found ${entries.length} matching account(s). Select one to fill.` : 'Connected. No matching accounts found.');
            ui.show('accounts');
        } catch (error) { rpc?.dispose(); if (epoch === generation) { clean(); ui.state(State.Error, message(error)); } }
        finally { if (epoch === generation) ui.busy(false); }
    };
    ui.lookup.onclick = lookup;
    ui.onOpen = event => { if (eligible(selected)) void lookup(event); };
    const testConnection = async () => {
        clean(); const epoch = generation; ui.busy(true);
        let stage = 'Starting the connection test';
        let rpc: NativeRpc | undefined;
        const startedAt = Date.now(), deadline = startedAt + 15000;
        const progress = () => {
            if (epoch !== generation) { clearInterval(timer); return; }
            const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
            if (Date.now() >= deadline) {
                clearInterval(timer);
                clean(); ui.state(State.Error, `${stage} timed out after 15 seconds. The test stopped; you can retry.`);
            } else ui.state(State.Connecting, `${stage}… (${elapsed}s)`);
        };
        const timer = setInterval(progress, 250);
        addEventListener('pageshow', progress); addEventListener('focus', progress);
        progress();
        try {
            rpc = new NativeRpc(endpoint, () => connector, value => { guard(epoch); stage = value; progress(); }); pending = rpc;
            const started = performance.now(); await rpc.connect(); guard(epoch);
            stage = 'Checking the KeeWebX reply'; progress(); guard(epoch);
            const result = await rpc.call('probe', undefined, 5000); guard(epoch);
            ui.state(State.Connected, `Connected to the authorized KeeWebX tab (${Math.round(performance.now() - started)} ms; ${result.visibility}).`);
        } catch (error) { if (epoch === generation) ui.state(State.Error, message(error)); }
        finally {
            clearInterval(timer); removeEventListener('pageshow', progress); removeEventListener('focus', progress);
            rpc?.dispose(); if (pending === rpc) pending = undefined; if (epoch === generation) ui.busy(false);
        }
    };
    ui.probe.onclick = event => {
        if (!event.isTrusted) return;
        void testConnection();
    };
    document.addEventListener('focusin', event => { const field = event.composedPath()[0]; if (eligible(field)) { selected = field; ui.anchor(field); } }, true);
    const invalidated = () => { if (current?.rpc.href !== undefined && current.rpc.href !== location.href || pending && pending.href !== location.href) clean(); };
    addEventListener('popstate', invalidated); addEventListener('hashchange', invalidated);
    addEventListener('pagehide', clean);
    addEventListener('visibilitychange', () => { if (document.hidden && (!pending || selecting)) { clean(); ui.state(State.ReadyToConnect, 'Find accounts again when you return.'); } });
    addEventListener('pageshow', event => { if (event.persisted) clean(); });
}

void start().catch(error => console.warn('KeeWebX Connect initialization failed.', error instanceof Error ? error.name : 'InitializationError'));
