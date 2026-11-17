import { CONNECT_VERSION } from './version';
import { verifyPortReady, type PortIdentity } from './port-auth';
import { isId, object, uuid } from './native-rpc';
import { transportEvent } from './transport-events';
import type { DiagnosticData } from '../../../diagnostics/src';

export const PORT_MARK = 'keewebx-connect-port-v1';
export const PORT_IDLE_MS = 10 * 60 * 1000;
const PORT_SETUP_MS = 25000;
export class AppSetupTimeoutError extends Error {}
export interface PortRoute { host: string; endpoint: string; publicKey: string; messagePort?: number; readyProof?: number }
const originValid = (value: unknown): value is string => {
    if (typeof value !== 'string') return false;
    try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; } catch { return false; }
};
const small = (value: unknown) => {
    try { return object(value) && JSON.stringify(value).length <= 300000; } catch { return false; }
};
const protocolId = (value: unknown): string | undefined => typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value) ? value : undefined;
const recordPortEvent = (event: DiagnosticData['event'], data: unknown, detail?: DiagnosticData['detail'], runtimeCount?: number) => {
    transportEvent({ event, detail, runtimeCount, ...(object(data) ? {
        traceId: protocolId(data.traceId), portId: protocolId(data.connectionId)
    } : {}) });
};

/** Ports survive helper closure. Only their two owning documents retain them. */
export class SitePortLink {
    private route?: PortRoute;
    private port?: MessagePort;
    private helper?: Window;
    private id?: string;
    private nonce?: string;
    private sent = false;
    private ready = false;
    private verifiedReady = false;
    private verifiedReply = false;
    private consecutiveTimeouts = 0;
    private lastSeen = 0;
    private promise?: Promise<void>;
    private openingFailure?: Error;
    private resolve?: () => void;
    private reject?: (error: Error) => void;
    private timer?: ReturnType<typeof setTimeout>;
    private transfer?: MessagePort;
    private closingRequested = false;
    private setupDeadline = 0;
    private listeners = new Set<(value: unknown) => void>();
    private closed = new Set<(reason: string) => void>();
    onGrantEnded = () => {};
    generation = 0;
    href = location.href;
    constructor(readonly endpoint: URL) { addEventListener('message', this.receive); }
    get connectionId(): string | undefined { return this.port ? this.id : undefined; }
    get authenticatedReady(): boolean { return this.ready && this.verifiedReady && this.href === location.href; }
    get hasVerifiedReply(): boolean { return this.verifiedReply && this.href === location.href; }
    configure(route: PortRoute): void {
        if (this.route && (route.host !== this.route.host || route.publicKey !== this.route.publicKey)) this.reset('The selected KeeWebX App changed. Reconnect.');
        this.route = route;
    }
    open(force = false): void {
        if (this.href !== location.href) { this.reset('The website navigated.'); this.href = location.href; }
        if (!this.route || this.route.messagePort !== 1) throw new Error('Authorize the updated Connect script in your existing KeeWebX tab first.');
        if (force || this.ready && Date.now() - this.lastSeen > PORT_IDLE_MS) this.reset('The idle connection expired.');
        if (this.ready || this.promise) return;
        this.openingFailure = undefined;
        const channel = new MessageChannel(); this.port = channel.port1; this.transfer = channel.port2;
        this.id = uuid(); this.nonce = uuid(); this.sent = false; this.closingRequested = false;
        this.promise = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
        // Handle startup failure even when the UI is canceled before awaiting connect.
        void this.promise.catch(() => {});
        const current = this.port, generation = this.generation;
        this.setupDeadline = Date.now() + PORT_SETUP_MS;
        const expire = (message: string) => {
            recordPortEvent('discovery-timeout', { connectionId: this.id }, 'expired');
            this.failSetup(new AppSetupTimeoutError(message));
        };
        current.onmessage = event => {
            if (this.port !== current || generation !== this.generation) { recordPortEvent('port-rejected', event.data, 'wrong-generation'); return; }
            if (!small(event.data) || event.data.marker !== PORT_MARK) { recordPortEvent('port-rejected', event.data, 'wrong-shape'); return; }
            const data = event.data;
            recordPortEvent('port-received', data);
            if (!this.ready && Date.now() >= this.setupDeadline) {
                expire('The connection attempt expired. Return to the existing KeeWebX App, then reconnect.'); return;
            }
            if (data.kind === 'error') {
                const message = typeof data.message === 'string' ? data.message : 'The original App could not receive the connection.';
                if (!this.ready && this.relayError(data)) return;
                this.failSetup(new Error(message));
                return;
            }
            const mismatch = data.connectionId !== this.id ? 'wrong-port' : data.appBoot !== this.route?.host ? 'wrong-host'
                : data.endpoint !== this.endpoint.href ? 'wrong-address' : data.siteOrigin !== location.origin ? 'wrong-origin' : undefined;
            if (mismatch) { recordPortEvent('port-rejected', data, mismatch); return; }
            if (data.kind === 'ready' && !this.ready) {
                const authenticated = verifyPortReady(data as PortIdentity, data.proof, this.route!.publicKey);
                if (!authenticated && (this.route?.readyProof === 1 || data.proof !== undefined)) {
                    recordPortEvent('port-rejected', data, 'bad-signature');
                    this.reset('The App port signature could not be verified. Reconnect to your original App.'); return;
                }
                recordPortEvent('port-ready', data, authenticated ? 'matched' : 'legacy');
                this.ready = true; this.verifiedReady = authenticated; this.lastSeen = Date.now(); clearTimeout(this.timer);
                // Release the foreground helper in this event, as in the Lab.
                // RPC session creation still uses the existing signed hello.
                if (authenticated) this.confirm();
                this.resolve?.(); this.resolve = this.reject = undefined;
            } else if (data.kind === 'reply' && this.ready) {
                this.lastSeen = Date.now(); for (const listener of this.listeners) listener(data.value);
            } else if (data.kind === 'closed') {
                if (data.reason === 'authorization-ended') this.onGrantEnded();
                this.reset('KeeWebX disconnected this port. Reconnect to the existing App.');
            }
        };
        current.onmessageerror = () => { if (this.port === current) this.reset('The connection could not decode a reply. Reconnect.'); };
        current.start();
        const url = new URL('connect-port/relay.html', this.endpoint);
        url.searchParams.set('site', location.origin); url.searchParams.set('nonce', this.nonce); url.searchParams.set('endpoint', this.endpoint.href);
        this.helper = window.open(url.href, PORT_MARK + ':' + this.id) || undefined;
        if (!this.helper) { this.failSetup(new Error('Safari blocked the temporary connection page. Allow pop-ups and retry.')); return; }
        recordPortEvent('relay-opened', { connectionId: this.id });
        this.timer = setTimeout(() => {
            if (this.port === current && !this.ready) expire('The original KeeWebX App did not reply. Visit that tab, then reconnect.');
        }, Math.max(0, this.setupDeadline - Date.now()));
    }
    private failSetup(error: Error): void {
        const opening = !this.ready;
        this.reset(error);
        if (opening) this.openingFailure = error;
    }
    private relayError(data: Record<string, unknown>): boolean {
        const startupFailure = data.code === 'worker-unavailable' || data.code === 'timeout';
        if (data.nonce !== this.nonce || (this.id !== data.connectionId && !(startupFailure && data.connectionId === '')) ||
            typeof data.code !== 'string' || typeof data.message !== 'string' || data.message.length > 2048) return false;
        const recoverable = startupFailure || data.code === 'app-timeout';
        transportEvent({ event: 'relay-error', portId: this.id, reason: data.code === 'app-timeout' || data.code === 'timeout' ? 'timeout' : 'unavailable' });
        if (data.code === 'app-timeout') recordPortEvent('discovery-timeout', data);
        this.failSetup(recoverable ? new AppSetupTimeoutError(data.message) : new Error(data.message));
        return true;
    }
    private receive = (event: MessageEvent) => {
        if (!event.isTrusted || !this.helper || event.source !== this.helper || event.origin !== this.endpoint.origin || !object(event.data) ||
            event.ports.length || event.data.marker !== PORT_MARK || event.data.nonce !== this.nonce) return;
        if (event.data.kind === 'error' && !this.ready) { this.relayError(event.data); return; }
        if (event.data.kind !== 'relay-ready' || event.data.endpoint !== this.endpoint.href || this.sent || !this.transfer || !this.route) return;
        recordPortEvent('relay-ready', { connectionId: this.id });
        this.sent = true;
        try { this.helper.postMessage({ marker: PORT_MARK, kind: 'attach', nonce: this.nonce, appBoot: this.route.host,
            connectionId: this.id, endpoint: this.endpoint.href, siteOrigin: location.origin }, this.endpoint.origin, [this.transfer]); this.transfer = undefined; }
        catch { this.failSetup(new AppSetupTimeoutError('The temporary connection page could not receive its port. Reconnect.')); }
    };
    async connect(): Promise<number> {
        if (!this.promise) throw this.openingFailure ?? new Error('Select Find accounts or Test connection again to reconnect to the existing App.');
        await this.promise;
        if (!this.ready || !this.port || this.href !== location.href) throw new Error('The website connection changed. Reconnect.');
        return this.generation;
    }
    confirm(): void {
        if (!this.ready || !this.helper) return;
        const helper = this.helper;
        try { if (helper.closed) { this.helper = undefined; return; } } catch {}
        if (!this.closingRequested) {
            this.closingRequested = true;
            try { helper.postMessage({ marker: PORT_MARK, kind: 'relay-complete', nonce: this.nonce,
                connectionId: this.id, endpoint: this.endpoint.href }, this.endpoint.origin); } catch {}
            try { helper.close(); } catch {}
        }
        // Do not lose the reference merely because close() returned normally.
        try { if (helper.closed && this.helper === helper) this.helper = undefined; } catch {}
    }
    assert(generation: number): void {
        if (!this.ready || !this.port || generation !== this.generation || this.href !== location.href) throw new Error('The website port is no longer connected. Reconnect to the existing App.');
    }
    requestTimedOut(generation: number): void {
        if (generation !== this.generation) return;
        // Safari can suspend delivery while the App is foreground. Retain a
        // proven physical channel for one fresh user request, never its session.
        if (!this.authenticatedReady || ++this.consecutiveTimeouts >= 2) this.reset('The KeeWebX port timed out. Reconnect to the original App.');
    }
    acknowledge(generation: number): void {
        this.assert(generation);
        // Only NativeRpc's verified, matching, unexpired replies acknowledge RPC.
        this.verifiedReply = true;
        this.consecutiveTimeouts = 0;
    }
    send(value: unknown): void {
        this.assert(this.generation); this.lastSeen = Date.now();
        try {
            this.port!.postMessage({ marker: PORT_MARK, kind: 'request', connectionId: this.id, value });
            transportEvent({ event: 'port-posted', portId: this.id,
                traceId: object(value) && object(value.packet) ? protocolId(value.packet.id) : undefined });
        }
        catch (error) { this.reset('The website port could not send a request. Reconnect.'); throw error; }
    }
    subscribe(listener: (value: unknown) => void, closed?: (reason: string) => void): () => void {
        this.listeners.add(listener); if (closed) this.closed.add(closed);
        return () => { this.listeners.delete(listener); if (closed) this.closed.delete(closed); };
    }
    reset(reason: string | Error = 'The website connection closed.'): void {
        const error = typeof reason === 'string' ? new Error(reason) : reason;
        this.openingFailure = undefined;
        if (this.port) recordPortEvent('port-rejected', { connectionId: this.id }, 'closed');
        this.generation++; clearTimeout(this.timer);
        if (this.helper) {
            if (this.closingRequested) {
                // The retained WindowProxy may now contain another document.
                // Only the original helper can recognize this scoped command.
                try { this.helper.postMessage({ marker: PORT_MARK, kind: 'relay-complete', nonce: this.nonce,
                    connectionId: this.id, endpoint: this.endpoint.href }, this.endpoint.origin); } catch {}
            } else {
                try { this.helper.postMessage({ marker: PORT_MARK, kind: 'relay-cancel', nonce: this.nonce,
                    connectionId: this.id, endpoint: this.endpoint.href }, this.endpoint.origin); } catch {}
                try { this.helper.close(); } catch {}
            }
        }
        this.helper = undefined;
        try { this.port?.postMessage({ marker: PORT_MARK, kind: 'close', connectionId: this.id }); } catch {}
        this.port?.close(); this.transfer?.close(); this.port = this.transfer = undefined;
        this.ready = false; this.verifiedReady = false; this.verifiedReply = false;
        this.consecutiveTimeouts = 0; this.sent = false; this.promise = undefined;
        for (const closed of [...this.closed]) closed(error.message);
        this.reject?.(error); this.resolve = this.reject = undefined;
    }
    dispose(): void { this.reset(); this.listeners.clear(); this.closed.clear(); removeEventListener('message', this.receive); }
}

type AppReceiverRegistration = {
    host: () => string; endpoint: string; workerURL: string; receive: (event: MessageEvent) => void;
};
const appReceiverCoordinator = Symbol.for(PORT_MARK + ':app-receivers');
type ReceiverContainer = ServiceWorkerContainer & { [appReceiverCoordinator]?: AppReceiverCoordinator };

/** Every listener on one container sees the same transferred endpoint. Route it once. */
class AppReceiverCoordinator {
    private receivers = new Set<AppReceiverRegistration>();
    constructor(private container: ReceiverContainer) { container.addEventListener('message', this.receive); }
    get size(): number { return Math.min(32, this.receivers.size); }
    add(receiver: AppReceiverRegistration): () => void {
        this.receivers.add(receiver);
        if (this.receivers.size > 1) recordPortEvent('runtime-duplicate', undefined, 'duplicate-runtime', this.size);
        return () => {
            this.receivers.delete(receiver);
            if (!this.receivers.size) {
                this.container.removeEventListener('message', this.receive);
                if (this.container[appReceiverCoordinator] === this) delete this.container[appReceiverCoordinator];
            }
        };
    }
    private receive = (event: MessageEvent) => {
        const data = event.data;
        if (!object(data) || data.marker !== PORT_MARK || !['find-app', 'attach-port'].includes(data.kind)) return;
        const received = data.kind === 'find-app' ? 'discovery-received' : 'port-received';
        const rejected = data.kind === 'find-app' ? 'discovery-rejected' : 'port-rejected';
        recordPortEvent(received, data, undefined, this.size);
        let workerURL: string | undefined;
        try { workerURL = (event.source as ServiceWorker | null)?.scriptURL; } catch {}
        const candidates = [...this.receivers].filter(receiver => receiver.workerURL === workerURL);
        if (!candidates.length) { recordPortEvent(rejected, data, 'wrong-source', this.size); return; }
        if (event.ports.length !== 1) { recordPortEvent(rejected, data, 'wrong-port', this.size); return; }
        const owner = candidates.find(receiver => receiver.host() === data.appBoot);
        // A single stale-state reply preserves reload diagnosis. Never let an
        // unrelated receiver answer ahead of the owner or close its endpoint.
        const receiver = owner ?? (data.kind === 'find-app'
            ? candidates.find(receiver => receiver.endpoint === data.endpoint) ?? candidates[0] : undefined);
        if (!receiver) { recordPortEvent(rejected, data, 'wrong-host', this.size); return; }
        receiver.receive(event);
    };
}

/** The worker can discover this receiver without waiting for extension storage. */
export class AppPortReceiver {
    private ports = new Map<string, { port: MessagePort; origin: string; lastSeen: number; setupDeadline: number; setupTimer?: ReturnType<typeof setTimeout> }>();
    private probes = new Map<MessagePort, ReturnType<typeof setTimeout>>();
    private coordinator: AppReceiverCoordinator;
    private unregister: () => void;
    private idleTimer: ReturnType<typeof setInterval>;
    private disposed = false;
    constructor(private endpoint: URL, private snapshot: () => { host: string; active: boolean },
        private request: (value: unknown, reply: (value: unknown) => void, origin: string, id: string) => Promise<void>,
        private released: (id: string) => void, private diagnostic: (value: string) => void = () => {},
        private admit: () => boolean = () => this.snapshot().active,
        private prove?: (value: PortIdentity) => string) {
        const container = navigator.serviceWorker as ReceiverContainer;
        this.coordinator = container[appReceiverCoordinator] ??= new AppReceiverCoordinator(container);
        this.unregister = this.coordinator.add({ host: () => this.snapshot().host, endpoint: endpoint.href,
            workerURL: new URL('connect-port/worker.js', endpoint).href, receive: this.receive });
        navigator.serviceWorker.startMessages?.();
        this.diagnostic('Direct receiver registered');
        this.idleTimer = setInterval(() => { for (const [id, peer] of this.ports) if (Date.now() - peer.lastSeen > PORT_IDLE_MS) this.remove(id); }, 30000);
    }
    get runtimeCount(): number { return this.coordinator.size; }
    get portCount(): number { return this.ports.size; }
    private closeProbe(port: MessagePort): void {
        clearTimeout(this.probes.get(port)); this.probes.delete(port);
        port.onmessage = null; port.close();
    }
    private remove(id: string, reason = 'expired'): void {
        const peer = this.ports.get(id); if (!peer) return;
        transportEvent({ event: 'port-closed', portId: id, reason: reason === 'expired' ? 'timeout'
            : reason === 'authorization-ended' || reason === 'replaced' ? 'changed'
                : reason === 'peer-closed' ? 'canceled' : 'unavailable' });
        clearTimeout(peer.setupTimer);
        try { peer.port.postMessage({ marker: PORT_MARK, kind: 'closed', connectionId: id, appBoot: this.snapshot().host,
            endpoint: this.endpoint.href, siteOrigin: peer.origin, reason }); } catch {}
        peer.port.close(); this.ports.delete(id); this.released(id);
    }
    private receive = (event: MessageEvent) => {
        if (this.disposed) return;
        const data = event.data;
        if (!object(data) || data.marker !== PORT_MARK) return;
        let sourceMatches = false;
        try { sourceMatches = !!event.source && (event.source as ServiceWorker).scriptURL === new URL('connect-port/worker.js', this.endpoint).href; } catch {}
        const matchesAddress = data.endpoint === this.endpoint.href;
        this.diagnostic(`${data.kind === 'find-app' ? 'Discovery' : 'Handoff'}: worker=${sourceMatches ? 'match' : 'rejected'}; address=${matchesAddress ? 'match' : 'different'}; ports=${event.ports.length}; trusted=${event.isTrusted}`);
        // Discovery exchanges public metadata. Match the proven POC's worker/port
        // checks; credential requests still require the signed NativeHost protocol.
        if (!sourceMatches || event.ports.length !== 1) return;
        const port = event.ports[0], state = this.snapshot();
        if (data.kind === 'attach-port' && data.appBoot !== state.host) return;
        if (data.kind === 'attach-port' && data.handoffDeadline !== undefined &&
            (!Number.isFinite(data.handoffDeadline) || data.handoffDeadline <= Date.now() || data.handoffDeadline > Date.now() + PORT_SETUP_MS)) {
            recordPortEvent('port-rejected', data, 'expired', this.runtimeCount);
            port.postMessage({ marker: PORT_MARK, kind: 'error', code: 'expired', message: 'The connection attempt expired. Reconnect from the website.' });
            port.close(); return;
        }
        if (data.kind === 'find-app') {
            // No extension or WebStorage reads may block a discovery acknowledgement.
            const reply = { marker: PORT_MARK,
                kind: matchesAddress && state.active && data.appBoot === state.host ? 'app-ready' : 'app-state',
                appBoot: state.host, endpoint: data.endpoint,
                state: !matchesAddress ? 'address-mismatch' : state.active ? 'enabled' : 'disabled', receiverVersion: CONNECT_VERSION,
                ...(protocolId(data.traceId) ? { traceId: data.traceId } : {}) };
            try { port.postMessage(reply); } catch { /* The worker can still receive the other reply. */ }
            // Discovery can be acknowledged even when this temporary port stalls.
            // Only the worker that sent this probe receives the same public status.
            if (data.replyViaWorker === true && reply.traceId) {
                try { (event.source as ServiceWorker).postMessage(reply); } catch { /* The probe port remains available. */ }
            }
            recordPortEvent('discovery-sent', data, !matchesAddress ? 'wrong-address' : data.appBoot !== state.host ? 'wrong-host' : 'matched', this.runtimeCount);
            this.diagnostic(`Discovery reply posted: ${state.active ? 'enabled' : 'disabled'}; selected=${data.appBoot === state.host ? 'match' : 'changed'}`);
            this.probes.set(port, setTimeout(() => this.closeProbe(port), 10000));
            port.onmessage = event => {
                if (event.data?.marker === PORT_MARK && event.data.kind === 'probe-done') {
                    const result = ['ready', 'refreshed', 'disabled', 'address-mismatch', 'timeout', 'unreachable'].includes(event.data.state) ? event.data.state : 'received';
                    this.diagnostic('Discovery worker result: ' + result);
                }
                this.closeProbe(port);
            }; port.start(); return;
        }
        if (data.kind !== 'attach-port' || !matchesAddress || !isId(data.connectionId) || !originValid(data.siteOrigin)) {
            recordPortEvent('port-rejected', data, !matchesAddress ? 'wrong-address'
                : !originValid(data.siteOrigin) ? 'wrong-origin' : 'wrong-shape', this.runtimeCount);
            port.close(); return;
        }
        if (!state.active) {
            recordPortEvent('port-rejected', data, 'not-selected', this.runtimeCount);
            port.postMessage({ marker: PORT_MARK, kind: 'error', code: 'disabled',
                message: 'Connect is disabled in this KeeWebX App. Unlock it and authorize Connect, then retry.' });
            port.close(); return;
        }
        this.diagnostic('Handoff received; validating selected App grant');
        if (!this.admit()) {
            recordPortEvent('port-rejected', data, 'not-selected', this.runtimeCount);
            this.diagnostic('Handoff rejected: selected App grant unavailable');
            port.postMessage({ marker: PORT_MARK, kind: 'error', code: 'inactive', message: 'The selected App grant is unavailable. Select this tab again in Connect.' });
            port.close(); return;
        }
        const ready = { marker: PORT_MARK, kind: 'ready', connectionId: data.connectionId, appBoot: state.host, endpoint: this.endpoint.href, siteOrigin: data.siteOrigin };
        let proof: string | undefined;
        try { proof = this.prove?.(ready); }
        catch {
            recordPortEvent('port-rejected', data, 'bad-signature', this.runtimeCount);
            this.diagnostic('Handoff rejected: port signing failed');
            port.postMessage({ marker: PORT_MARK, kind: 'error', message: 'The App could not authenticate this port. Reconnect.' });
            port.close(); return;
        }
        for (const [id, peer] of this.ports) if (Date.now() - peer.lastSeen > PORT_IDLE_MS) this.remove(id);
        if (this.ports.size >= 32) { port.postMessage({ marker: PORT_MARK, kind: 'error', message: 'Too many website connections. Close an old website and retry.' }); port.close(); return; }
        const id = data.connectionId, origin = data.siteOrigin; this.remove(id, 'replaced');
        const peer = { port, origin, lastSeen: Date.now(), setupDeadline: Date.now() + PORT_SETUP_MS,
            setupTimer: undefined as ReturnType<typeof setTimeout> | undefined };
        this.ports.set(id, peer);
        // A dead website must not leave an unauthenticated peer occupying a slot.
        peer.setupTimer = setTimeout(() => { if (this.ports.get(id) === peer) this.remove(id); }, PORT_SETUP_MS);
        const reply = (value: unknown) => {
            const traceId = object(value) && object(value.packet) ? protocolId(value.packet.id) : undefined;
            if (this.ports.get(id) === peer && this.snapshot().active) {
                if (peer.setupTimer !== undefined && Date.now() >= peer.setupDeadline) { this.remove(id); return; }
                clearTimeout(peer.setupTimer); peer.setupTimer = undefined;
                peer.lastSeen = Date.now(); port.postMessage({ marker: PORT_MARK, kind: 'reply', connectionId: id,
                    appBoot: state.host, endpoint: this.endpoint.href, siteOrigin: origin, value });
                transportEvent({ event: 'port-posted', portId: id, traceId });
            } else transportEvent({ event: 'port-rejected', portId: id, traceId,
                detail: this.ports.get(id) !== peer ? 'wrong-generation' : 'inactive' });
        };
        port.onmessage = message => {
            const value = message.data;
            const traceId = object(value) && object(value.value) && object(value.value.packet) ? protocolId(value.value.packet.id) : undefined;
            transportEvent({ event: 'port-message', portId: id, traceId });
            const rejection = this.ports.get(id) !== peer ? 'wrong-generation' : !small(value) || value.marker !== PORT_MARK
                ? 'wrong-shape' : value.connectionId !== id ? 'wrong-port' : undefined;
            if (rejection) { transportEvent({ event: 'port-rejected', portId: id, traceId, detail: rejection }); return; }
            if (peer.setupTimer !== undefined && Date.now() >= peer.setupDeadline) { this.remove(id); return; }
            if (!this.snapshot().active) { this.remove(id, 'inactive'); return; }
            if (Date.now() - peer.lastSeen > PORT_IDLE_MS) { this.remove(id); return; }
            if (value.kind === 'close') { this.remove(id, 'peer-closed'); return; }
            peer.lastSeen = Date.now();
            if (value.kind === 'request') void this.request(value.value, reply, origin, id).catch(() => {
                transportEvent({ event: 'rpc-rejected', portId: id, traceId, detail: 'handler-error' });
                this.remove(id, 'handler-error');
            });
        };
        port.onmessageerror = () => {
            transportEvent({ event: 'port-rejected', portId: id, detail: 'decode-error' });
            this.remove(id, 'decode-error');
        }; port.start();
        port.postMessage({ ...ready, ...(proof ? { proof } : {}) });
        recordPortEvent('port-ready', data, proof ? 'matched' : 'legacy', this.runtimeCount);
        this.diagnostic(proof ? 'Authenticated port ready posted' : 'Legacy port ready posted');
    };
    clear(): void { for (const id of [...this.ports.keys()]) this.remove(id, 'authorization-ended'); }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true; this.unregister(); clearInterval(this.idleTimer);
        for (const port of this.probes.keys()) this.closeProbe(port);
        this.clear();
    }
}
