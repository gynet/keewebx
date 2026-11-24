import { CONNECT_VERSION } from './version';
import { Operation } from './operation';
import { ProtocolImpl, type KeeWebXEntry } from '../../src/background/protocol/protocol-impl';
import { BackendConnectionState as State } from '../../src/common/backend-connection-state';
import { AppBridge, appReceiptsSupported, watchAppLockState } from './app-bridge';
import { ConnectUI } from './connect-ui';
import { approvedRoute, NativeHost, NativeRpc, managerCall, openConnector, startConnector, connectorTabId, registerConnector, prepareDirect, openDirect, directCredentials, watchApprovedRoute } from './native-connect';
import { identity } from './identity';
import { DEFAULT_ENDPOINT, loadEndpoint, saveEndpoint } from './settings';
import { targets, assertTargets, fill, type Targets } from './form-targets';
import { isLoginField, watchLoginFields } from './login-fields';
import { userscriptPreferences } from './preferences';
import { claimRuntime } from './runtime-owner';

const VERSION = CONNECT_VERSION;
const LOOKUP_BUDGET_MS = 30000;
const runtime = { getVersion: () => VERSION, getMessage: (key: string) => key === 'errorAppReturnedError' ? 'KeeWebX returned an error' : key, allowDebug: false };
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const assertWebsiteScope = (features: { features: string[]; websiteOrigin?: string }, origin: string) => {
    if (!features.features.includes('website-matching-v1') || features.websiteOrigin !== origin) {
        throw new Error('Save database changes and reload your existing KeeWebX tab to enable app-side account matching.');
    }
};

async function start(): Promise<void> {
    if (window.top !== window || location.protocol !== 'https:' || /\/connect-port(?:-poc)?\//.test(location.pathname)) return;
    const owner = claimRuntime(globalThis, document);
    if (!owner) return;
    let endpoint: URL;
    try { endpoint = await loadEndpoint(); } catch { endpoint = new URL(DEFAULT_ENDPOINT); }
    if (location.origin === endpoint.origin && location.pathname === new URL('connect.html', endpoint).pathname && new URL(location.href).searchParams.get('kwx-native') === '1') {
        startConnector(endpoint);
        return;
    }
    const app = location.origin === endpoint.origin && (location.pathname.replace(/\/$/, '') === endpoint.pathname.replace(/\/$/, '') || endpoint.pathname === '/app' && ['/next.html', '/index.html'].includes(location.pathname));
    const ui = new ConnectUI(app ? 'app' : 'website', endpoint.href);
    if (app) {
        const host = new NativeHost(endpoint, error => ui.state(State.Error, message(error)));
        const bridge = new AppBridge();
        let generation = 0, authorizing = false, authorizationExplicit = false, attempted = false, revoked = false, authorized = false, restoreRequested = false;
        ui.connectionSnapshot = () => ({ ...host.diagnostics(), authorized, authorizing });
        let appUnlocked: boolean | undefined;
        let resumePending = false;
        const authorize = async (explicit: boolean) => {
            if (authorizing) return;
            authorizing = true; authorizationExplicit = explicit; ui.action('authorize', { disabled: true });
            const epoch = ++generation;
            const guard = () => { if (epoch !== generation) throw new Error('Authorization was canceled.'); };
            try {
                if (!host.hasDirectReceiver) throw new Error('The direct receiver could not start. Reload your existing App tab, then retry.');
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
                if (!appReceiptsSupported()) throw new Error('Save database changes and reload KeeWebX to update its Connect receiver.');
                await host.authorize(keys, () => epoch === generation, explicit ? 'explicit' : 'restore'); guard(); revoked = false; authorized = true; attempted = true;
                ui.state(State.Connected, 'Authorized. All websites can use this tab. Return to your website and select an account.');
                ui.action('authorize', { label: 'Use this tab for all websites' });
            } catch (error) { if (epoch === generation && explicit) ui.state(State.Error, message(error)); }
            finally {
                if (epoch === generation) {
                    authorizing = false; ui.action('authorize', { disabled: false }); bridge.reset();
                    const retry = !explicit && restoreRequested && !authorized && !revoked;
                    restoreRequested = false;
                    if (retry) queueMicrotask(retryRestore);
                }
            }
        };
        ui.on('authorize', event => { if (event.isTrusted) void authorize(true); });
        ui.on('revoke', event => {
            if (!event.isTrusted) return;
            revoked = true; authorized = false; restoreRequested = false; resumePending = false; generation++; authorizing = false; bridge.reset(); ui.action('authorize', { disabled: false });
            const epoch = generation;
            void host.revoke().then(() => {
                if (epoch === generation) ui.state(State.ReadyToConnect, 'Disconnected. Authorize this tab once to enable all websites again.');
            }, error => {
                if (epoch === generation) ui.state(State.Error, `Disconnected in this tab. ${message(error)}`);
            });
        });
        ui.onClose = () => {
            // Silent restoration belongs to the App lifecycle, not this panel.
            if (!authorizing || !authorizationExplicit) return;
            const resumeAuthorized = authorized;
            generation++; authorizing = false; authorized = false; attempted = true; restoreRequested = false;
            host.pause(); bridge.reset(); ui.action('authorize', { disabled: false });
            ui.state(State.ReadyToConnect, 'Connection setup canceled.');
            // Closing setup cancels the pending attempt. Restore a previously
            // approved grant through the same unlock and permission checks.
            if (resumeAuthorized) queueMicrotask(retryRestore);
        };
        const restored = () => {
            if (resumePending) {
                const role = document.documentElement.dataset.appInstance;
                if (role !== undefined && role !== 'primary') return;
                resumePending = false;
                if (!revoked) host.resume();
                attempted = false;
            }
            const unlocked = appUnlocked ?? !!document.querySelector('.vault');
            if (!unlocked) {
                host.lock();
                if (authorizing) { generation++; authorizing = false; bridge.reset(); ui.action('authorize', { disabled: false }); }
                if (authorized) ui.state(State.ReadyToConnect, 'KeeWebX is locked. Unlock this tab to resume Connect.');
                attempted = false; authorized = false; return;
            }
            if (!authorized && !revoked && !authorizing && host.unlock()) {
                authorized = true; attempted = true;
                ui.state(State.Connected, 'Authorized. Connect resumed; existing vault permissions still apply.');
                return;
            }
            if (authorized || attempted || revoked || authorizing) return;
            attempted = true; void authorize(false);
        };
        watchAppLockState(unlocked => { appUnlocked = unlocked; restored(); });
        new MutationObserver(restored).observe(document.body, { childList: true, subtree: true });
        // A cached pageshow can precede asynchronous App lock reacquisition.
        // Resume the existing grant once ownership returns, without republishing.
        new MutationObserver(() => { if (resumePending) restored(); }).observe(document.documentElement,
            { attributes: true, attributeFilter: ['data-app-instance'] });
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
            resumePending = false; generation++; authorizing = false; bridge.reset();
            if (event.persisted) host.pause(); else void host.revoke(false).catch(() => {});
        });
        addEventListener('pageshow', event => { if (event.persisted) { resumePending = true; restored(); } });
        return;
    }

    let autoFillSingle = false;
    let connectionRevision = 0, pageAlive = true;
    let refreshing: Promise<void> | undefined;
    let stopRouteWatching = () => {};
    const refreshConnection = (force = false): Promise<void> => {
        if (refreshing && !force) return refreshing;
        const revision = ++connectionRevision;
        ui.preparingConnection(true);
        const work = prepareDirect(endpoint).finally(() => {
            if (revision === connectionRevision && pageAlive) { refreshing = undefined; ui.preparingConnection(false); }
        });
        refreshing = work;
        return work;
    };
    const refreshForeground = () => {
        if (!pageAlive || document.hidden) return;
        void refreshConnection().catch(error => ui.state(State.Error, message(error)));
    };
    const watchRoute = () => {
        stopRouteWatching();
        stopRouteWatching = watchApprovedRoute(endpoint, () => {
            ++connectionRevision; refreshing = undefined; ui.preparingConnection(true);
            if (pageAlive && !document.hidden) void refreshConnection(true).catch(error => ui.state(State.Error, message(error)));
        });
    };
    watchRoute();
    const preferencesReady = userscriptPreferences.load().then(preferences => {
        autoFillSingle = preferences.autoFillSingle; ui.preference(autoFillSingle);
    }, () => ui.preference(false, false, 'Preferences could not be loaded. Single-account fill is off.'));
    ui.busy(true); ui.action('open', { disabled: true });
    ui.state(State.Connecting, 'Loading saved Connect settings…');
    void Promise.all([refreshConnection(), preferencesReady]).then(() => {
        ui.state(State.ReadyToConnect, 'Ready. Find matching accounts or test the connection.');
    }, error => ui.state(State.Error, message(error))).finally(() => { ui.busy(false); ui.action('open', { disabled: false }); });
    addEventListener('focus', refreshForeground);
    let selected: HTMLInputElement | undefined;
    let detected: HTMLInputElement | undefined;
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
    let operation: Operation | undefined;
    let pending: NativeRpc | undefined;
    let current: { rpc: NativeRpc; protocol: ProtocolImpl; target: Targets; origin: string } | undefined;
    const clean = () => {
        operation?.cancel(); operation = undefined;
        generation++; pending?.dispose(); pending = undefined; current?.rpc.dispose(); current = undefined;
        selecting = false; ui.clear(); ui.busy(false);
        ui.state(State.ReadyToConnect, 'Connection test or lookup stopped. You can retry.');
    };
    const guard = (epoch: number) => { if (epoch !== generation) throw new Error('The operation was canceled. Find accounts again.'); };
    const beginOperation = (stage: string, epoch: number) => {
        const active = new Operation(stage, LOOKUP_BUDGET_MS, stage => {
            if (epoch === generation) ui.state(State.Connecting, stage + '…');
        }, stage => {
            if (epoch !== generation) return;
            clean(); ui.state(State.Error, `${stage} timed out. Try Find accounts again.`);
        });
        operation = active;
        return active;
    };
    const wireTimeout = () => Math.min(15000, operation?.remainingMs ?? 15000);
    ui.onClose = clean;
    ui.onConfig = () => { clean(); ui.state(State.ReadyToConnect, 'Your authorized KeeWebX tab is used on every website. Test the connection here.'); };
    ui.on('save', async event => {
        if (!event.isTrusted) return;
        clean(); const epoch = generation;
        try { endpoint = await saveEndpoint(ui.address); guard(epoch); connector = undefined; refreshing = undefined; watchRoute(); await refreshConnection(true); guard(epoch); register(); ui.state(State.ReadyToConnect, 'Address saved. Authorize that KeeWebX tab once.'); }
        catch (error) { if (epoch === generation) ui.state(State.Error, message(error)); }
    });
    ui.onAutoFillSingleChange = enabled => {
        clean();
        ui.preference(enabled, true);
        void userscriptPreferences.save({ autoFillSingle: enabled }).then(() => {
            autoFillSingle = enabled; ui.preference(enabled);
        }, () => ui.preference(autoFillSingle, false, 'Could not save this preference. Try again.'));
    };
    ui.on('open', event => { if (event.isTrusted) void testConnection(true); });
    const setup = () => { ui.show('config'); ui.state(State.ReadyToConnect, 'Authorize Connect once in your existing KeeWebX tab, then return here and find accounts.'); };

    async function choose(entry: KeeWebXEntry, existingTask?: Operation): Promise<void> {
        const active = current;
        if (!active || selecting) return;
        const epoch = generation;
        selecting = true; ui.busy(true);
        const task = existingTask ?? beginOperation('Checking account access', epoch);
        try {
            active.rpc.assertCurrent(); assertTargets(active.target);
            await task.run('Checking account access', () => active.rpc.assertSelected()); guard(epoch);
            if (location.origin !== active.origin) throw new Error('The website changed. Filling stopped.');
            const before = await task.run('Checking account access', () => active.protocol.features()); guard(epoch);
            assertWebsiteScope(before, active.origin);
            if (before.locked || !before.canList || !before.paired) throw new Error('The database is locked or access was revoked. Unlock the existing KeeWebX tab.');
            const fields = [...(active.target.user ? ['user'] : []), ...(active.target.password ? ['password'] : [])];
            const values = await task.run('Reading account details', () => active.protocol.getEntryFields(entry.handle, fields)); guard(epoch);
            active.rpc.assertCurrent(); assertTargets(active.target);
            const features = await task.run('Checking access before filling', () => active.protocol.features()); guard(epoch);
            assertWebsiteScope(features, active.origin);
            if (current !== active || features.locked || !features.canList || !features.paired) throw new Error('The database or authorization changed. Filling stopped.');
            active.rpc.assertCurrent(); assertTargets(active.target);
            await task.run('Checking access before filling', () => active.rpc.assertSelected()); guard(epoch);
            task.assert();
            fill(active.target, values, () => { guard(epoch); active.rpc.assertCurrent(); if (current !== active) throw new Error('The account selection is no longer valid.'); });
            ui.hide(); ui.state(State.Connected, 'Filled the account details. The form was not submitted.');
        } catch (error) { if (epoch === generation) { clean(); ui.state(State.Error, `${task.stage}: ${message(error)}`); } }
        finally { task.cancel(); if (operation === task) operation = undefined; if (epoch === generation) { selecting = false; ui.busy(false); } }
    }
    const lookup = async (event: MouseEvent) => {
        if (!event.isTrusted || ui.isDisabled('lookup') || selecting) return;
        clean(); ui.busy(true); ui.state(State.Connecting, 'Finding accounts in your authorized KeeWebX tab...');
        const epoch = generation;
        const task = beginOperation('Connecting to KeeWebX', epoch);
        let rpc: NativeRpc | undefined;
        try {
            const anchor = isLoginField(selected) ? selected : isLoginField(detected) ? detected : undefined;
            if (!anchor) throw new Error('This login form changed. Focus its username or password field and try again.');
            const target = targets(anchor), origin = location.origin;
            // A previous successful probe does not prove its port is still live.
            // Start each user operation with a new handoff in this trusted tap.
            const direct = openDirect(endpoint, true);
            rpc = new NativeRpc(endpoint, () => connector, stage => {
                if (epoch === generation) ui.state(State.Connecting, stage + '…');
            }); pending = rpc;
            if (!direct && !await approvedRoute(endpoint)) { guard(epoch); setup(); return; }
            const keys = directCredentials(endpoint) || await managerCall(() => identity()); guard(epoch);
            let waitingForApp = false;
            await task.run('Connecting to KeeWebX', () => rpc!.connect(task.deadline, budgetMs => {
                waitingForApp = true;
                return task.resetBudget(budgetMs);
            })); guard(epoch);
            if (waitingForApp) task.resetBudget(LOOKUP_BUDGET_MS);
            const protocol = new ProtocolImpl({ request: request => rpc!.call('wire', request, wireTimeout()) }, runtime);
            await task.run('Connecting to KeeWebX', () => protocol.ping());
            await task.run('Connecting to KeeWebX', () => protocol.changePublicKeys());
            if (!await task.run('Checking account access', () => protocol.pair(keys))) throw new Error('Authorize Connect once in your KeeWebX tab.');
            guard(epoch);
            const features = await task.run('Checking account access', () => protocol.features()); guard(epoch);
            assertWebsiteScope(features, origin);
            if (features.locked) throw new Error('The database is locked. Unlock the existing KeeWebX tab.');
            if (!features.canList || !features.paired) throw new Error('Connect access was revoked. Authorize it again in KeeWebX.');
            const list = await task.run('Finding matching accounts', () => protocol.getEntries(undefined, undefined)); guard(epoch);
            rpc.assertCurrent(); assertTargets(target);
            if (list.locked) throw new Error('The database is locked.');
            const entries = list.suggested.slice(0, 10);
            current = { rpc, protocol, target, origin }; pending = undefined; ui.clear();
            if (autoFillSingle && list.suggested.length === 1) {
                await choose(entries[0], task);
                return;
            }
            if (!entries.length) ui.empty('No matching accounts for this website.');
            entries.forEach((entry, index) => ui.entry(index, entry.title, entry.user, () => { void choose(entry); }));
            ui.state(State.Connected, entries.length ? `Found ${entries.length} matching account(s). Select one to fill.` : 'Connected. No matching accounts found.');
            ui.show('accounts');
        } catch (error) { rpc?.dispose(); if (epoch === generation) { clean(); ui.state(State.Error, `${task.stage}: ${message(error)}`); } }
        finally { task.cancel(); if (operation === task) operation = undefined; if (epoch === generation) ui.busy(false); }
    };
    ui.on('lookup', lookup);
    ui.onOpen = event => {
        if (!event.isTrusted) return;
        if (isLoginField(selected)) void lookup(event);
        else if (isLoginField(detected) && !ui.isDisabled('probe')) void testConnection();
    };
    const testConnection = async (recovery = false) => {
        clean(); const epoch = generation; ui.busy(true);
        let stage = 'Starting the connection test';
        let rpc: NativeRpc | undefined;
        const startedAt = Date.now();
        let deadline = startedAt + 35000, waitingForApp = false;
        const progress = () => {
            if (epoch !== generation) { clearInterval(timer); return; }
            const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
            if (Date.now() >= deadline) {
                clearInterval(timer);
                clean(); ui.state(State.Error, `${stage} timed out. You can retry.`);
            } else ui.state(State.Connecting, `${stage}… (${elapsed}s)`);
        };
        const timer = setInterval(progress, 250);
        addEventListener('pageshow', progress); addEventListener('focus', progress);
        progress();
        try {
            const direct = openDirect(endpoint, true);
            if (recovery && !direct) {
                if (!clientId) throw new Error('Connection settings are not ready. Reopen the panel and retry.');
                connector = openConnector(endpoint, clientId, connector);
            }
            rpc = new NativeRpc(endpoint, () => connector, value => { guard(epoch); stage = value; progress(); }, recovery ? 5000 : 2000); pending = rpc;
            const started = performance.now();
            await rpc.connect(deadline, budgetMs => {
                guard(epoch); waitingForApp = true;
                return deadline = Date.now() + budgetMs;
            }); guard(epoch);
            if (waitingForApp) deadline = Date.now() + 5000;
            stage = 'Checking the KeeWebX reply'; progress(); guard(epoch);
            const result = await rpc.call('probe', undefined, 5000); guard(epoch);
            ui.state(State.Connected, `Connected to the authorized KeeWebX tab (${Math.round(performance.now() - started)} ms; ${result.visibility}).`);
        } catch (error) { if (epoch === generation) ui.state(State.Error, message(error)); }
        finally {
            clearInterval(timer); removeEventListener('pageshow', progress); removeEventListener('focus', progress);
            rpc?.dispose(); if (pending === rpc) pending = undefined; if (epoch === generation) ui.busy(false);
        }
    };
    ui.on('probe', event => {
        if (!event.isTrusted) return;
        void testConnection();
    });
    document.addEventListener('focusin', event => {
        if (!event.isTrusted) return;
        const field = event.composedPath()[0];
        if (isLoginField(field)) { selected = field; ui.anchor(field); }
    }, true);
    const observeFields = (field?: HTMLInputElement) => {
        detected = field;
        if (!isLoginField(selected)) selected = undefined;
        ui.anchor(field);
    };
    let stopWatching = watchLoginFields(observeFields);
    const invalidated = () => { if (current?.rpc.href !== undefined && current.rpc.href !== location.href || pending && pending.href !== location.href) clean(); };
    addEventListener('popstate', invalidated); addEventListener('hashchange', invalidated);
    addEventListener('pagehide', event => {
        pageAlive = false; ++connectionRevision; refreshing = undefined;
        clean(); stopWatching();
        if (!event.persisted) stopRouteWatching();
    });
    addEventListener('visibilitychange', () => {
        if (document.hidden && (!pending || selecting)) { clean(); ui.state(State.ReadyToConnect, 'Find accounts again when you return.'); }
        if (!document.hidden) refreshForeground();
    });
    addEventListener('pageshow', event => {
        if (event.persisted) { pageAlive = true; clean(); stopWatching = watchLoginFields(observeFields); refreshForeground(); }
    });
}

void start().catch(error => console.warn('KeeWebX Connect initialization failed.', error instanceof Error ? error.name : 'InitializationError'));
