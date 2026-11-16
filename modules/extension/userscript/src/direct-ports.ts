import { CONNECT_VERSION } from './version';
import { verifyPortReady, type PortIdentity } from './port-auth';
import { isId, object, uuid } from './native-rpc';

export const PORT_MARK = 'keewebx-connect-port-v1';
export const PORT_IDLE_MS = 10 * 60 * 1000;
export interface PortRoute { host: string; endpoint: string; publicKey: string; messagePort?: number; readyProof?: number }
const originValid = (value: unknown): value is string => {
    if (typeof value !== 'string') return false;
    try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; } catch { return false; }
};
const small = (value: unknown) => {
    try { return object(value) && JSON.stringify(value).length <= 300000; } catch { return false; }
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
    private lastSeen = 0;
    private promise?: Promise<void>;
    private resolve?: () => void;
    private reject?: (error: Error) => void;
    private timer?: ReturnType<typeof setTimeout>;
    private transfer?: MessagePort;
    private listeners = new Set<(value: unknown) => void>();
    private closed = new Set<(reason: string) => void>();
    onGrantEnded = () => {};
    generation = 0;
    href = location.href;
    constructor(readonly endpoint: URL) { addEventListener('message', this.receive); }
    configure(route: PortRoute): void {
        if (this.route && (route.host !== this.route.host || route.publicKey !== this.route.publicKey)) this.reset('The selected KeeWebX App changed. Reconnect.');
        this.route = route;
    }
    open(force = false): void {
        if (this.href !== location.href) { this.reset('The website navigated.'); this.href = location.href; }
        if (!this.route || this.route.messagePort !== 1) throw new Error('Authorize the updated Connect script in your existing KeeWebX tab first.');
        if (force || this.ready && Date.now() - this.lastSeen > PORT_IDLE_MS) this.reset('The idle connection expired.');
        if (this.ready || this.promise) return;
        const channel = new MessageChannel(); this.port = channel.port1; this.transfer = channel.port2;
        this.id = uuid(); this.nonce = uuid(); this.sent = false;
        this.promise = new Promise<void>((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
        // Handle startup failure even when the UI is canceled before awaiting connect.
        void this.promise.catch(() => {});
        const current = this.port, generation = this.generation;
        current.onmessage = event => {
            if (this.port !== current || generation !== this.generation || !small(event.data) || event.data.marker !== PORT_MARK) return;
            const data = event.data;
            if (data.kind === 'error') { this.reset(typeof data.message === 'string' ? data.message : 'The original App could not receive the connection.'); return; }
            if (data.connectionId !== this.id || data.appBoot !== this.route?.host || data.endpoint !== this.endpoint.href || data.siteOrigin !== location.origin) return;
            if (data.kind === 'ready' && !this.ready) {
                const authenticated = verifyPortReady(data as PortIdentity, data.proof, this.route!.publicKey);
                if (!authenticated && (this.route?.readyProof === 1 || data.proof !== undefined)) {
                    this.reset('The App port signature could not be verified. Reconnect to your original App.'); return;
                }
                this.ready = true; this.lastSeen = Date.now(); clearTimeout(this.timer);
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
        if (!this.helper) { this.reset('Safari blocked the temporary connection page. Allow pop-ups and retry.'); return; }
        this.timer = setTimeout(() => { if (this.port === current && !this.ready) this.reset('The original KeeWebX App did not reply. Visit that tab, then reconnect.'); }, 25000);
    }
    private receive = (event: MessageEvent) => {
        if (!event.isTrusted || !this.helper || event.source !== this.helper || event.origin !== this.endpoint.origin || !object(event.data) ||
            event.data.marker !== PORT_MARK || event.data.kind !== 'relay-ready' || event.data.nonce !== this.nonce || event.data.endpoint !== this.endpoint.href || this.sent || !this.transfer || !this.route) return;
        this.sent = true;
        try { this.helper.postMessage({ marker: PORT_MARK, kind: 'attach', nonce: this.nonce, appBoot: this.route.host,
            connectionId: this.id, endpoint: this.endpoint.href, siteOrigin: location.origin }, this.endpoint.origin, [this.transfer]); this.transfer = undefined; }
        catch { this.reset('The temporary connection page could not receive its port. Reconnect.'); }
    };
    async connect(): Promise<number> {
        if (!this.promise) throw new Error('Select Find accounts or Test connection again to reconnect to the existing App.');
        await this.promise;
        if (!this.ready || !this.port || this.href !== location.href) throw new Error('The website connection changed. Reconnect.');
        return this.generation;
    }
    confirm(): void { if (this.ready) try { this.helper?.close(); this.helper = undefined; } catch {} }
    assert(generation: number): void {
        if (!this.ready || !this.port || generation !== this.generation || this.href !== location.href) throw new Error('The website port is no longer connected. Reconnect to the existing App.');
    }
    send(value: unknown): void {
        this.assert(this.generation); this.lastSeen = Date.now();
        this.port!.postMessage({ marker: PORT_MARK, kind: 'request', connectionId: this.id, value });
    }
    subscribe(listener: (value: unknown) => void, closed?: (reason: string) => void): () => void {
        this.listeners.add(listener); if (closed) this.closed.add(closed);
        return () => { this.listeners.delete(listener); if (closed) this.closed.delete(closed); };
    }
    reset(reason = 'The website connection closed.'): void {
        this.generation++; clearTimeout(this.timer);
        try { this.helper?.close(); } catch {} this.helper = undefined;
        try { this.port?.postMessage({ marker: PORT_MARK, kind: 'close', connectionId: this.id }); } catch {}
        this.port?.close(); this.transfer?.close(); this.port = this.transfer = undefined;
        this.ready = false; this.sent = false; this.promise = undefined;
        for (const closed of [...this.closed]) closed(reason);
        this.reject?.(new Error(reason)); this.resolve = this.reject = undefined;
    }
    dispose(): void { this.reset(); this.listeners.clear(); this.closed.clear(); removeEventListener('message', this.receive); }
}

/** The worker can discover this receiver without waiting for extension storage. */
export class AppPortReceiver {
    private ports = new Map<string, { port: MessagePort; origin: string; lastSeen: number }>();
    constructor(private endpoint: URL, private snapshot: () => { host: string; active: boolean },
        private request: (value: unknown, reply: (value: unknown) => void, origin: string, id: string) => Promise<void>,
        private released: (id: string) => void, private diagnostic: (value: string) => void = () => {},
        private admit: () => boolean = () => this.snapshot().active,
        private prove?: (value: PortIdentity) => string) {
        navigator.serviceWorker.addEventListener('message', this.receive);
        navigator.serviceWorker.startMessages?.();
        this.diagnostic('Direct receiver registered');
        setInterval(() => { for (const [id, peer] of this.ports) if (Date.now() - peer.lastSeen > PORT_IDLE_MS) this.remove(id); }, 30000);
    }
    private remove(id: string, reason = 'expired'): void {
        const peer = this.ports.get(id); if (!peer) return;
        try { peer.port.postMessage({ marker: PORT_MARK, kind: 'closed', connectionId: id, appBoot: this.snapshot().host,
            endpoint: this.endpoint.href, siteOrigin: peer.origin, reason }); } catch {}
        peer.port.close(); this.ports.delete(id); this.released(id);
    }
    private receive = (event: MessageEvent) => {
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
        if (data.kind === 'find-app') {
            // No extension or WebStorage reads may block a discovery acknowledgement.
            port.postMessage({ marker: PORT_MARK,
                kind: matchesAddress && state.active && data.appBoot === state.host ? 'app-ready' : 'app-state',
                appBoot: state.host, endpoint: data.endpoint,
                state: !matchesAddress ? 'address-mismatch' : state.active ? 'enabled' : 'disabled', receiverVersion: CONNECT_VERSION });
            this.diagnostic(`Discovery reply posted: ${state.active ? 'enabled' : 'disabled'}; selected=${data.appBoot === state.host ? 'match' : 'changed'}`);
            const timer = setTimeout(() => port.close(), 10000);
            port.onmessage = event => {
                if (event.data?.marker === PORT_MARK && event.data.kind === 'probe-done') {
                    const result = ['ready', 'refreshed', 'disabled', 'address-mismatch', 'timeout', 'unreachable'].includes(event.data.state) ? event.data.state : 'received';
                    this.diagnostic('Discovery worker result: ' + result);
                }
                clearTimeout(timer); port.close();
            }; port.start(); return;
        }
        if (data.kind !== 'attach-port' || !matchesAddress || data.appBoot !== state.host || !state.active || !isId(data.connectionId) || !originValid(data.siteOrigin)) { port.close(); return; }
        this.diagnostic('Handoff received; validating selected App grant');
        if (!this.admit()) {
            this.diagnostic('Handoff rejected: selected App grant unavailable');
            port.postMessage({ marker: PORT_MARK, kind: 'error', code: 'inactive', message: 'The selected App grant is unavailable. Select this tab again in Connect.' });
            port.close(); return;
        }
        const ready = { marker: PORT_MARK, kind: 'ready', connectionId: data.connectionId, appBoot: state.host, endpoint: this.endpoint.href, siteOrigin: data.siteOrigin };
        let proof: string | undefined;
        try { proof = this.prove?.(ready); }
        catch {
            this.diagnostic('Handoff rejected: port signing failed');
            port.postMessage({ marker: PORT_MARK, kind: 'error', message: 'The App could not authenticate this port. Reconnect.' });
            port.close(); return;
        }
        for (const [id, peer] of this.ports) if (Date.now() - peer.lastSeen > PORT_IDLE_MS) this.remove(id);
        if (this.ports.size >= 32) { port.postMessage({ marker: PORT_MARK, kind: 'error', message: 'Too many website connections. Close an old website and retry.' }); port.close(); return; }
        const id = data.connectionId, origin = data.siteOrigin; this.remove(id);
        const peer = { port, origin, lastSeen: Date.now() }; this.ports.set(id, peer);
        const reply = (value: unknown) => {
            if (this.ports.get(id) === peer && this.snapshot().active) {
                peer.lastSeen = Date.now(); port.postMessage({ marker: PORT_MARK, kind: 'reply', connectionId: id,
                    appBoot: state.host, endpoint: this.endpoint.href, siteOrigin: origin, value });
            }
        };
        port.onmessage = message => {
            const value = message.data;
            if (this.ports.get(id) !== peer || !small(value) || value.marker !== PORT_MARK || value.connectionId !== id) return;
            if (!this.snapshot().active || Date.now() - peer.lastSeen > PORT_IDLE_MS || value.kind === 'close') { this.remove(id); return; }
            peer.lastSeen = Date.now();
            if (value.kind === 'request') void this.request(value.value, reply, origin, id).catch(() => this.remove(id));
        };
        port.onmessageerror = () => this.remove(id); port.start();
        port.postMessage({ ...ready, ...(proof ? { proof } : {}) });
        this.diagnostic(proof ? 'Authenticated port ready posted' : 'Legacy port ready posted');
    };
    clear(): void { for (const id of [...this.ports.keys()]) this.remove(id, 'authorization-ended'); }
}
