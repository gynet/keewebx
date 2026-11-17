import { watchManagerGrant, watchManagerStorage } from './manager-events';
import { AppPortReceiver, SitePortLink } from './direct-ports';
import { signPortReady } from './port-auth';
import { ReplyReceipt, type ReceiptBinding } from './reply-receipt';
import { sign } from 'tweetnacl';
import { fromBase64, toBase64 } from '../../src/background/utils';
import { AppBridge, appReceiptsSupported } from './app-bridge';
import { identity } from './identity';
import { isId, object, SESSION_TTL, uuid } from './native-rpc';
import { SiteLink, SETUP_MARK } from './site-link';
import { ConnectMailbox, mailboxRequest, mailboxRelease } from './connect-mailbox';
import { transportEvent } from './transport-events';

const MARK = 'keewebx-native-connect-v1';
class RequestDeadlineError extends Error {}
const channelName = (endpoint: URL) => `${MARK}:${endpoint.href}`;
const routeKey = (endpoint: URL) => `${MARK}:selected:${endpoint.href}`;
type Keys = { publicKey: Uint8Array; secretKey: Uint8Array };
type Route = { host: string; owner: string; endpoint: string; publicKey: string; mailbox?: boolean; messagePort?: number; readyProof?: number; wireReceipt?: number; authorizationRevision?: number };
type Packet = { type: 'request' | 'reply'; host: string; endpoint: string; id: string; document: string; origin: string;
    operation: 'hello' | 'wire' | 'probe' | 'focus' | 'release'; deadline: number; scope?: string; body?: any; error?: string };
type Signed = { packet: Packet; signature: string };
declare const GM: { getValue(key: string): Promise<any>; setValue(key: string, value: any): Promise<void>; deleteValue(key: string): Promise<void>;
    getTab?(): Promise<any>; saveTab?(value: any): Promise<void> };
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : object(value)
    ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(canonical(value)));
const signed = (packet: Packet, keys: Keys): Signed => ({ packet: canonical(JSON.parse(JSON.stringify(packet))), signature: toBase64(sign.detached(bytes(packet), keys.secretKey)) });
const verified = (value: unknown, key: Uint8Array): value is Signed => {
    if (!object(value) || !object(value.packet) || typeof value.signature !== 'string') return false;
    try { return sign.detached.verify(bytes(value.packet), fromBase64(value.signature), key); } catch { return false; }
};
export function managerCall<T>(operation: () => Promise<T>, description = 'Userscripts settings', timeout = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${description} did not respond.`)), timeout);
        Promise.resolve().then(operation).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
    });
}
export async function approvedRoute(endpoint: URL, strict = false): Promise<Route | undefined> {
    const route = await managerCall(() => GM.getValue(routeKey(endpoint)));
    if (object(route) && isId(route.host) && isId(route.owner) && route.endpoint === endpoint.href && typeof route.publicKey === 'string') return route as Route;
    if (strict && route != null) throw new Error('Saved app selection is invalid. Reauthorize your existing KeeWebX tab.');
}
const valid = (p: Packet) => isId(p.host) && isId(p.id) && isId(p.document) && /^https:\/\/[^/]+$/.test(p.origin) &&
    Number.isFinite(p.deadline) && p.deadline > Date.now() && p.deadline <= Date.now() + 66000 &&
    ['hello', 'wire', 'probe', 'focus', 'release'].includes(p.operation);

const directClients = new Map<string, { link: SitePortLink; route?: Route; keys?: Keys; revision: number }>();
function directClient(endpoint: URL) {
    let client = directClients.get(endpoint.href);
    if (!client) {
        client = { link: new SitePortLink(endpoint), revision: 0 }; directClients.set(endpoint.href, client);
        const current = client;
        current.link.onGrantEnded = () => { current.revision++; current.route = undefined; current.keys = undefined; };
        addEventListener('pagehide', () => { current.link.reset(); current.revision++; });
    }
    return client;
}
/** Prepare while the website is foreground; handoff never depends on a late GM read. */
export async function prepareDirect(endpoint: URL): Promise<void> {
    const client = directClient(endpoint), revision = ++client.revision;
    try {
        const route = await approvedRoute(endpoint);
        const keys = route?.messagePort === 1 ? await managerCall(() => identity()) : undefined;
        // Canceling a physical connection must not discard the latest grant read.
        // New reads, grant invalidations and document departure still fence it.
        if (client.revision !== revision) return;
        if (!route || route.publicKey !== (keys ? toBase64(keys.publicKey) : route.publicKey)) {
            client.link.reset('The saved Connect authorization changed.'); client.route = undefined; client.keys = undefined; return;
        }
        if (client.route && client.route.host !== route.host) client.link.reset('The selected KeeWebX App changed.');
        client.route = route; client.keys = keys;
        if (route.messagePort === 1) client.link.configure(route);
    } catch (error) {
        if (client.revision === revision) {
            client.route = undefined; client.keys = undefined;
            client.link.reset('The saved Connect authorization could not be checked.');
        }
        throw error;
    }
}
/** Storage events invalidate pending reads and wake a fresh authenticated read. */
export function watchApprovedRoute(endpoint: URL, onChange: () => void): () => void {
    const client = directClient(endpoint);
    return watchManagerStorage([routeKey(endpoint)], () => {
        client.revision++;
        onChange();
    });
}
export function directCredentials(endpoint: URL): Keys | undefined { return directClient(endpoint).keys; }
/** Must be called synchronously from a trusted tap, before awaiting anything. */
export function openDirect(endpoint: URL, force = false): boolean {
    const client = directClient(endpoint);
    if (client.route?.messagePort !== 1 || !client.keys) return false;
    client.link.open(force); return true;
}

/** One explicitly selected app, one active encrypted protocol session. */
export class NativeHost {
    private host = uuid();
    private owner = uuid();
    private ownerReady: Promise<void>;
    private authorization = 0;
    private publishedAuthorization?: number;
    private channel: BroadcastChannel;
    private mailbox: ConnectMailbox;
    private keys?: Keys;
    private live = false;
    private locked = false;
    private direct?: AppPortReceiver;
    private leaseKey: string;
    private consumed = new Map<string, number>();
    private session?: { document: string; origin: string; scope: string; expiresAt: number; bridge: AppBridge; locked: boolean; busy: boolean; port?: string;
        wire: ReplyReceipt<true>; hello?: { request: string; reply: Signed; authorization: number; keys: Keys } };
    constructor(private endpoint: URL, private onError: (error: Error) => void = () => {}, private diagnostic: (message: string) => void = () => {}) {
        this.leaseKey = `${MARK}:active:${endpoint.href}`;
        try {
            if (navigator.serviceWorker) {
                this.direct = new AppPortReceiver(endpoint, () => ({ host: this.host, active: this.live && !!this.keys && this.canServe() }),
                    (value, reply, origin, id) => this.receive(value, reply, { origin, id }), id => {
                        if (this.session?.port === id) { this.session.bridge.dispose(); this.session = undefined; }
                    }, this.diagnostic, () => this.live && !!this.keys && this.canServe() && this.selectedDirect(), value => {
                        if (!this.keys) throw new Error('Connect is inactive.');
                        return signPortReady(value, this.keys.secretKey);
                    });
                addEventListener('storage', event => { if (event.key === this.leaseKey && !this.selectedDirect()) {
                    this.direct?.clear(); this.session?.bridge.dispose(); this.session = undefined;
                } });
            }
            else this.diagnostic('Direct receiver unavailable: ServiceWorker API missing');
        } catch (error) { this.diagnostic('Direct receiver startup failed: ' + (error instanceof Error ? error.name : 'Error')); }
        watchManagerGrant(routeKey(endpoint), () => ({ host: this.host, revision: this.publishedAuthorization }), () => {
            if (this.selectedDirect()) localStorage.removeItem(this.leaseKey);
            this.direct?.clear(); this.session?.bridge.dispose(); this.session = undefined;
        });
        // Browser tab identity is not copied when a vault tab is duplicated.
        // Managers without these APIs require explicit selection after reload.
        const key = `${MARK}:owner:${endpoint.href}`;
        this.ownerReady = managerCall(async () => {
            if (!GM.getTab || !GM.saveTab) return;
            const saved = await GM.getTab();
            const tab = object(saved) ? saved : {};
            const owner = isId(tab[key]) ? tab[key] : this.owner;
            await GM.saveTab({ ...tab, [key]: owner });
            this.owner = owner;
        }).catch(() => {});
        this.channel = new BroadcastChannel(channelName(endpoint));
        this.channel.onmessage = event => {
            if (event.isTrusted && event.origin === location.origin && event.data?.marker === MARK) {
                void this.receive(event.data.value).catch(error => this.onError(error instanceof Error ? error : new Error('Connection settings are unavailable.')));
            }
        };
        this.mailbox = new ConnectMailbox(this.host, (value, reply) => this.receive(value, reply), error => {
            // Optional legacy storage failure must not overwrite a healthy direct receiver.
            if (!this.direct) this.onError(error);
        });
    }
    get hasDirectReceiver(): boolean { return !!this.direct; }
    diagnostics(): Readonly<{ locked: boolean; live: boolean; selected: boolean; direct: boolean; hasSession: boolean; authorization: number; runtimeCount: number }> {
        return Object.freeze({ locked: this.locked || !!this.session?.locked, live: this.live && this.canServe(), selected: this.canServe() && this.selectedDirect(),
            direct: !!this.direct, hasSession: !!this.session, authorization: this.authorization, runtimeCount: this.direct?.runtimeCount ?? 0 });
    }
    private appRole(): string | undefined {
        return typeof document === 'undefined' ? undefined : document.documentElement?.dataset?.appInstance;
    }
    private canServe(): boolean { const role = this.appRole(); return role === undefined || role === 'primary'; }
    private selectedDirect(): boolean { try { return localStorage.getItem(this.leaseKey) === this.host; } catch { return false; } }
    private restorationBlocked(): boolean { try { return localStorage.getItem(this.leaseKey + ':restore-blocked') === '1'; } catch { return false; } }
    async selected(): Promise<boolean> {
        await this.ownerReady;
        if (!this.canServe() || this.restorationBlocked()) return false;
        const route = await approvedRoute(this.endpoint);
        return this.canServe() && (!route || route.owner === this.owner || this.appRole() === 'primary');
    }
    private updateRoute(operation: () => Promise<void>): Promise<void> {
        // App tabs share this origin and endpoint lock. Only the caller times
        // out: the lock remains held until the actual GM work and cleanup end.
        return managerCall(async () => {
            if (typeof navigator === 'undefined' || typeof navigator.locks?.request !== 'function') {
                throw new Error('This browser needs Web Locks support to change the selected KeeWebX app safely.');
            }
            let acquired = false;
            try {
                await navigator.locks.request(`${MARK}:route:${this.endpoint.href}`, { mode: 'exclusive' }, async () => {
                    acquired = true;
                    await operation();
                });
            } catch (error) {
                if (!acquired) throw new Error('The browser could not lock the KeeWebX app selection. Retry authorization.');
                throw error;
            }
        }, 'KeeWebX app selection');
    }
    async authorize(keys: Keys, current: () => boolean = () => true, mode: 'explicit' | 'restore' = 'explicit'): Promise<void> {
        const generation = ++this.authorization;
        const valid = () => generation === this.authorization && this.canServe() && current();
        await this.ownerReady;
        if (!valid()) throw new Error('Authorization was canceled.');
        try {
            await this.updateRoute(async () => {
                if (!valid()) throw new Error('Authorization was canceled.');
                if (mode === 'restore') {
                    if (this.restorationBlocked()) throw new Error('Connect was disconnected. Authorize this App explicitly to enable it again.');
                    const route = await approvedRoute(this.endpoint, true);
                    if (!valid()) throw new Error('Authorization was canceled.');
                    // The caller has already checked pairing, unlock and listing
                    // permissions. Only the elected New UI can inherit another
                    // tab's grant, and only with the same userscript identity.
                    if (route && route.publicKey !== toBase64(keys.publicKey)) throw new Error('The saved Connect identity changed. Authorize this App explicitly.');
                    if (route && route.owner !== this.owner && this.appRole() !== 'primary') throw new Error('Another KeeWebX tab was selected. Authorize this tab explicitly to replace it.');
                }
                // Fail closed before publication, including selection by a legacy-only host.
                if (typeof localStorage !== 'undefined') localStorage.removeItem(this.leaseKey);
                await GM.setValue(routeKey(this.endpoint), { host: this.host, owner: this.owner, endpoint: this.endpoint.href, publicKey: toBase64(keys.publicKey), authorizationRevision: generation, mailbox: this.mailbox.available, ...(this.direct ? { messagePort: 1, readyProof: 1, ...(appReceiptsSupported() ? { wireReceipt: 1 } : {}) } : {}) } satisfies Route);
                if (!valid()) {
                    // The exclusive route lock is still held; no replacement can publish yet.
                    await GM.deleteValue(routeKey(this.endpoint));
                    return;
                }
                try {
                    if (this.direct) localStorage.setItem(this.leaseKey, this.host);
                    if (mode === 'explicit' && typeof localStorage !== 'undefined') localStorage.removeItem(this.leaseKey + ':restore-blocked');
                    this.publishedAuthorization = generation;
                }
                catch (error) { await GM.deleteValue(routeKey(this.endpoint)); throw error; }
            });
        } catch (error) { if (generation === this.authorization) this.authorization++; throw error; }
        if (!valid()) throw new Error('Authorization was canceled.');
        this.keys = keys; this.locked = false; this.live = true; this.mailbox.start(!this.direct);
    }
    resume(): void { if (this.keys && this.canServe()) { this.live = true; this.mailbox.start(!this.direct); } }
    unlock(): boolean {
        if (!this.canServe() || !this.direct || !this.live || !this.keys || !this.selectedDirect()) return false;
        // Unlock resumes the grant, never a locked protocol scope or its receipts.
        if (this.locked || this.session?.locked) {
            this.session?.bridge.dispose(); this.session = undefined;
        }
        this.locked = false; return true;
    }
    lock(): void { this.locked = true; this.session?.bridge.dispose(); this.session = undefined; }
    pause(): void { this.authorization++; this.live = false; this.mailbox.stop(); this.direct?.clear(); this.session?.bridge.dispose(); this.session = undefined; }
    async revoke(explicit = true): Promise<void> {
        this.pause(); this.keys = undefined;
        // Persist explicit disconnect independently of optional GM cleanup, so
        // reloading cannot silently restore a revoked grant from stale metadata.
        if (explicit) try { localStorage.setItem(this.leaseKey + ':restore-blocked', '1'); } catch {}
        await this.updateRoute(async () => {
            // The public marker may be stale if an older receiver was selected.
            // Never delete another App's route; an unavailable read leaves only
            // stale discovery metadata, with this receiver already disabled.
            let route: any;
            try { route = await managerCall(() => GM.getValue(routeKey(this.endpoint)), 'Revocation ownership check', 1000); }
            catch { if (this.selectedDirect()) localStorage.removeItem(this.leaseKey); return; }
            if (route?.host === this.host) await GM.deleteValue(routeKey(this.endpoint));
            if (this.selectedDirect()) localStorage.removeItem(this.leaseKey);
        });
    }
    private async receive(value: unknown, reply: (value: Signed) => void | Promise<void> = value => this.channel.postMessage({ marker: MARK, value }), direct?: { origin: string; id: string }): Promise<void> {
        const authorization = this.authorization;
        const keys = this.keys;
        if (!this.canServe() || !this.live || !keys || !verified(value, keys.publicKey)) return;
        const p = value.packet;
        if (p.type !== 'request' || p.host !== this.host || p.endpoint !== this.endpoint.href || !valid(p) || direct && p.origin !== direct.origin) return;
        if (direct) transportEvent({ event: 'rpc-received', traceId: p.id, portId: direct.id });
        for (const [id, until] of this.consumed) if (until <= Date.now()) this.consumed.delete(id);
        if (direct && p.operation === 'hello') this.diagnostic('Signed hello received; checking selected App grant');
        // A previously selected tab must stop serving after another app wins.
        const selected = direct ? this.selectedDirect() : (await approvedRoute(this.endpoint))?.host === this.host;
        if (!this.canServe() || !selected || authorization !== this.authorization || !this.live || this.keys !== keys || Date.now() >= p.deadline) {
            if (direct) transportEvent({ event: 'rpc-rejected', traceId: p.id, portId: direct.id,
                detail: !selected ? 'not-selected' : Date.now() >= p.deadline ? 'expired' : 'wrong-generation' });
            if (direct && p.operation === 'hello') this.diagnostic(`Hello rejected: selected=${selected}; current=${authorization === this.authorization && this.live && this.keys === keys}; expired=${Date.now() >= p.deadline}`);
            return;
        }
        if (this.consumed.has(p.id)) {
            const session = this.session;
            // A duplicate can only resend an exact receipt. It cannot execute
            // work again or replace the active encrypted protocol session.
            if (direct && p.operation === 'hello' && !this.locked && session && !session.locked && session.port === direct.id &&
                session.expiresAt > Date.now() && session.hello?.authorization === authorization && session.hello.keys === keys &&
                session.hello.request === JSON.stringify(canonical(p))) {
                try {
                    await reply(session.hello.reply);
                    transportEvent({ event: 'rpc-sent', traceId: p.id, portId: direct.id });
                    this.diagnostic('Cached signed hello reply posted');
                } catch (reason) {
                    this.diagnostic('Hello reply failed: ' + (reason instanceof Error ? reason.name : 'Error'));
                    this.onError(reason instanceof Error ? reason : new Error('The connection page is unavailable.'));
                }
            } else if (direct && p.operation === 'wire' && !this.locked && session && !session.locked && !session.busy &&
                session.port === direct.id && session.scope === p.scope && session.document === p.document &&
                session.origin === p.origin && session.expiresAt > Date.now()) {
                if (session.wire.read(this.receiptBinding(p, direct.id, authorization, keys))) {
                    session.busy = true;
                    try {
                        // The App prepares its cached response again, checking
                        // current permissions and entry/session lifetime before publication.
                        const body = await session.bridge.replay(p.body, Math.min(p.deadline, session.expiresAt));
                        if (this.canServe() && this.session === session && !session.locked && !this.locked && this.live &&
                            authorization === this.authorization && this.keys === keys && this.selectedDirect() && Date.now() < p.deadline) {
                            await reply(signed({ ...p, type: 'reply', body }, keys));
                            transportEvent({ event: 'rpc-sent', traceId: p.id, portId: direct.id });
                            this.diagnostic('Revalidated encrypted protocol receipt posted');
                        }
                    } catch (error) {
                        if (this.canServe() && this.session === session && authorization === this.authorization && this.live && this.keys === keys &&
                            this.selectedDirect() && Date.now() < p.deadline) {
                            await reply(signed({ ...p, type: 'reply', body: undefined, error: error instanceof Error ? error.message : 'The App receipt could not be checked. Find accounts again.' }, keys));
                        }
                    } finally { session.busy = false; }
                }
            }
            return;
        }
        if (this.consumed.size >= 1024) return;
        this.consumed.set(p.id, p.deadline);
        let body: any, error: string | undefined;
        try {
            if (this.locked) throw new Error('KeeWebX is locked. Unlock that app tab, then retry.');
            let session = this.session;
            if (p.operation === 'hello') {
                if (session?.busy) throw new Error('Another website request is finishing. Retry.');
                session?.bridge.dispose();
                session = { document: p.document, origin: p.origin, scope: uuid(), expiresAt: Date.now() + SESSION_TTL, bridge: new AppBridge(location.origin, p.origin), locked: false, busy: false, port: direct?.id, wire: new ReplyReceipt<true>() };
                const current = session;
                session.bridge.onLocked = () => { current.locked = true; current.hello = undefined; current.wire.clear(); };
                this.session = session;
                body = { scope: session.scope, appBoot: this.host, expiresAt: session.expiresAt };
            } else {
                if (!session || session.document !== p.document || session.origin !== p.origin || session.scope !== p.scope || session.port !== direct?.id || session.expiresAt <= Date.now()) throw new Error('The website session changed. Find accounts again.');
                if (p.operation === 'release') { session.bridge.dispose(); this.session = undefined; return; }
                if (p.operation === 'probe' || p.operation === 'focus') body = { visibility: document.visibilityState, appBoot: this.host };
                else {
                    if (session.locked) throw new Error('KeeWebX is locked. Unlock that app tab, then retry.');
                    if (session.busy) throw new Error('A request is already running. Retry.');
                    session.busy = true;
                    this.diagnostic('Encrypted protocol request received');
                    try { body = await session.bridge.request(p.body, Math.min(p.deadline, session.expiresAt)); }
                    finally { session.busy = false; }
                }
                if (this.session !== session) return;
            }
        } catch (reason) { error = reason instanceof Error ? reason.message : 'KeeWebX could not complete the request.'; }
        if (this.canServe() && authorization === this.authorization && this.live && this.keys === keys && (!direct || this.selectedDirect()) && Date.now() < p.deadline) {
            try {
                const response = signed({ ...p, type: 'reply', body, error }, keys);
                if (direct && p.operation === 'hello' && !error && this.session?.port === direct.id) {
                    this.session.hello = { request: JSON.stringify(canonical(p)), reply: response, authorization, keys };
                }
                if (direct && p.operation === 'wire' && this.session?.port === direct.id && this.session.scope === p.scope) {
                    this.session.wire.remember(this.receiptBinding(p, direct.id, authorization, keys), true);
                }
                await reply(response);
                if (direct) transportEvent({ event: 'rpc-sent', traceId: p.id, portId: direct.id });
                if (direct && p.operation === 'wire') this.diagnostic(error ? 'Encrypted protocol error reply posted' : 'Encrypted protocol reply posted');
                if (direct && p.operation === 'hello') this.diagnostic(error ? 'Signed hello error reply posted' : 'Signed hello reply posted');
            }
            catch (reason) {
                if (direct && p.operation === 'hello') this.diagnostic('Hello reply failed: ' + (reason instanceof Error ? reason.name : 'Error'));
                this.onError(reason instanceof Error ? reason : new Error('The connection page is unavailable.'));
            }
        } else if (direct && p.operation === 'hello') {
            this.diagnostic('Hello reply suppressed: grant changed or request expired');
        }
    }
    private receiptBinding(request: Packet, port: string, authorization: number, keys: Keys): ReceiptBinding {
        return { request: JSON.stringify(canonical(request)), port, authorization, key: keys, deadline: request.deadline };
    }
}

const peers = new Map<Window, { origin: string; routingId: string }>();
let client: { endpoint: URL; id: string; recovered(peer: Window): void } | undefined;

/** A browser-tab identity survives navigation to a different website. */
export async function connectorTabId(): Promise<string> {
    const key = `${MARK}:client-tab`;
    return managerCall(async () => {
        if (!GM.getTab || !GM.saveTab) throw new Error('This script manager must support GM.getTab and GM.saveTab.');
        const saved = await GM.getTab(), tab = object(saved) ? saved : {};
        const id = isId(tab[key]) ? tab[key] : uuid();
        await GM.saveTab({ ...tab, [key]: id });
        return id;
    });
}
export function registerConnector(endpoint: URL, id: string, recovered: (peer: Window) => void): void {
    client = { endpoint, id, recovered };
}
const connectorName = (endpoint: URL, id: string) => `${MARK}:${endpoint.href}:${id}`;
let cancelWebsiteReturn: (() => void) | undefined;
addEventListener('message', event => {
    if (!event.isTrusted || !event.source || event.source === window) return;
    const peer = event.source as Window;
    // A connector retains its opener WindowProxy across website navigation.
    // This public routing proof recovers only a window; signed RPC still authorizes data.
    if (client && event.origin === client.endpoint.origin && event.data?.marker === SETUP_MARK &&
        event.data.kind === 'ready' && event.data.routingId === client.id && event.data.endpoint === client.endpoint.href) {
        peers.set(peer, { origin: event.origin, routingId: client.id });
        client.recovered(peer);
    }
    const binding = peers.get(peer);
    if (!binding || binding.origin !== event.origin || event.data?.routingId !== binding.routingId) return;
    if (client && event.data?.marker === MARK && event.data.kind === 'return-to-website' &&
        event.origin === client.endpoint.origin && binding.routingId === client.id &&
        event.data.endpoint === client.endpoint.href && event.data.websiteOrigin === location.origin && isId(event.data.nonce)) {
        cancelWebsiteReturn?.();
        const nonce = event.data.nonce, websiteOrigin = location.origin, endpoint = client.endpoint.href;
        const deadline = Date.now() + 1800;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let stableTimer: ReturnType<typeof setTimeout> | undefined, focusedAt: number | undefined;
        const resetFocus = () => {
            clearTimeout(stableTimer); stableTimer = undefined; focusedAt = undefined;
        };
        const stop = () => {
            clearTimeout(timer); resetFocus();
            removeEventListener('focus', check);
            removeEventListener('blur', resetFocus);
            removeEventListener('visibilitychange', check);
            removeEventListener('pagehide', stop);
            if (cancelWebsiteReturn === stop) cancelWebsiteReturn = undefined;
        };
        const check = () => {
            if (Date.now() >= deadline || peers.get(peer) !== binding || location.origin !== websiteOrigin ||
                !client || client.id !== binding.routingId || client.endpoint.href !== endpoint || peer.closed) { stop(); return; }
            if (document.visibilityState !== 'visible' || !document.hasFocus()) { resetFocus(); return; }
            // A click can briefly focus the website before the helper regains focus.
            // Require a continuous settling period before reporting a successful return.
            if (focusedAt === undefined) {
                focusedAt = Date.now(); stableTimer = setTimeout(check, 200); return;
            }
            if (Date.now() - focusedAt < 200) return;
            stop();
            peer.postMessage({ marker: MARK, kind: 'website-focused', routingId: binding.routingId,
                endpoint, websiteOrigin, nonce, visible: true, focused: true }, binding.origin);
        };
        cancelWebsiteReturn = stop;
        addEventListener('focus', check);
        addEventListener('blur', resetFocus);
        addEventListener('visibilitychange', check);
        addEventListener('pagehide', stop);
        timer = setTimeout(stop, 1800);
        check();
    }
    if (event.data?.marker === SETUP_MARK && event.data.kind === 'ready' && typeof event.data.nonce === 'string') {
        peer.postMessage({ marker: SETUP_MARK, kind: 'site', nonce: event.data.nonce, routingId: binding.routingId, endpoint: event.data.endpoint }, event.origin);
    }
});

/** Only a trusted user action opens/focuses the connector; never navigate a vault. */
export function openConnector(endpoint: URL, id: string, existing?: Window): Window {
    let peer = existing;
    if (!peer || peer.closed) {
        const url = new URL('connect.html', endpoint); url.searchParams.set('kwx-native', '1');
        url.searchParams.set('kwx-client', id);
        peer = window.open('', connectorName(endpoint, id)) || undefined;
        if (!peer) throw new Error('Allow this connection page to open, then retry.');
        try { if (peer.location.href === 'about:blank') peer.location.href = url.href; }
        catch { /* An existing cross-origin connection page keeps its document. */ }
    }
    peers.set(peer, { origin: endpoint.origin, routingId: id });
    // Retain the reference even when a focus or setup hint cannot be delivered.
    try { peer.postMessage({ marker: SETUP_MARK, kind: 'reconnect', routingId: id, endpoint: endpoint.href }, endpoint.origin); } catch {}
    try { peer.focus(); } catch {}
    return peer;
}

/** Prefer an existing native link; recover lost window associations through the signed mailbox. */
export class NativeRpc {
    readonly document = uuid();
    readonly href = location.href;
    private route?: Route;
    private keys?: Keys;
    private window?: Window;
    private live = true;
    private scope?: string;
    private expiresAt = 0;
    private direct?: SitePortLink;
    private directGeneration?: number;
    private authenticated = false;
    private unsubscribeDirect?: () => void;
    private cancelSetup?: () => void;
    private pending = new Map<string, { packet: Packet; resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; stop?: () => void }>();
    constructor(private endpoint: URL, private peer: () => Window | undefined, private progress: (stage: string) => void = () => {}, private setupTimeout = 2000) { addEventListener('message', this.receive); }
    assertCurrent(): void {
        if (!this.live || location.href !== this.href || this.window?.closed) throw new Error('The website or connection page changed. Connect again.');
        if (this.direct && this.directGeneration !== undefined) this.direct.assert(this.directGeneration);
        if (this.scope && Date.now() >= this.expiresAt) throw new Error('The account list expired. Find accounts again.');
    }
    async assertSelected(): Promise<void> {
        this.assertCurrent();
        const current = await approvedRoute(this.endpoint); this.assertCurrent();
        if (!this.route || current?.host !== this.route.host || current.publicKey !== this.route.publicKey) throw new Error('The selected app changed. Find accounts again.');
    }
    async connect(deadline = Date.now() + 35000): Promise<void> {
        if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new RequestDeadlineError('The connection attempt expired. Try again.');
        this.window = this.peer(); if (this.window?.closed) this.window = undefined; this.assertCurrent();
        this.progress('Checking saved authorization');
        const prepared = directClient(this.endpoint);
        if (prepared.route?.messagePort === 1 && prepared.keys) {
            this.route = prepared.route; this.keys = prepared.keys; this.window = undefined; this.direct = prepared.link;
            this.unsubscribeDirect = this.direct.subscribe(this.accept, reason => {
                for (const item of this.pending.values()) { clearTimeout(item.timer); item.stop?.(); item.reject(new Error(reason)); }
                this.pending.clear();
            });
            this.progress('Connecting directly to the original KeeWebX App');
            this.directGeneration = this.direct.generation;
            await this.direct.connect(); this.assertCurrent();
        } else { this.keys = await managerCall(() => identity()); this.route = await approvedRoute(this.endpoint); this.assertCurrent(); }
        if (!this.direct && this.route?.messagePort === 1) throw new Error('Connection settings are loading. Tap Find accounts or Test connection again to connect directly.');
        if (!this.route || this.route.publicKey !== toBase64(this.keys.publicKey)) throw new Error('Unlock KeeWebX and authorize Connect there once.');
        if (!this.direct && this.window) try {
            this.progress('Connecting the website window');
            await new Promise<void>((resolve, reject) => {
                const finish = (error?: Error) => {
                    clearTimeout(timer); removeEventListener('message', receive); this.cancelSetup = undefined;
                    if (error) reject(error); else resolve();
                };
                const receive = (event: MessageEvent) => {
                    if (event.isTrusted && event.source === this.window && event.origin === this.endpoint.origin &&
                        event.data?.marker === MARK && event.data.kind === 'ready' &&
                        event.data.routingId === peers.get(this.window!)?.routingId && event.data.endpoint === this.endpoint.href) finish();
                };
                const timer = setTimeout(() => finish(new Error('The connection page did not respond.')), this.setupTimeout);
                this.cancelSetup = () => finish(new Error('The operation was canceled.'));
                addEventListener('message', receive);
                this.window!.postMessage({ marker: SETUP_MARK, kind: 'reconnect', routingId: peers.get(this.window!)?.routingId, endpoint: this.endpoint.href }, this.endpoint.origin);
            });
            this.assertCurrent();
        } catch (error) {
            // A closed or obsolete optional connector is a transport failure.
            // Clear it before checking document cancellation and trying recovery.
            this.window = undefined;
            this.assertCurrent(); if (!this.route.mailbox) throw error;
        }
        if (!this.direct && !this.window && !this.route.mailbox) throw new Error('Update Connect in your existing KeeWebX app tab, or open its connection page once.');
        this.progress('Contacting the selected app');
        let result: any;
        try { result = await this.call('hello', undefined, 8000, deadline); }
        catch (error) {
            this.assertCurrent();
            if (!(error instanceof RequestDeadlineError) || !this.direct?.authenticatedReady || Date.now() >= deadline) throw error;
            // A resumed website gets one fresh handshake on the proven port.
            // Expired replies stay invalid; no credential request is repeated.
            this.progress('Resuming the existing KeeWebX connection');
            result = await this.call('hello', undefined, 8000, deadline);
        }
        if (!object(result) || !isId(result.scope) || result.appBoot !== this.route.host || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now() || result.expiresAt > Date.now() + SESSION_TTL + 1000) throw new Error('Invalid app handshake.');
        this.scope = result.scope; this.expiresAt = result.expiresAt; this.direct?.confirm();
    }
    private receive = (event: MessageEvent) => {
        if (!event.isTrusted || event.source !== this.window || event.origin !== this.endpoint.origin || event.data?.marker !== MARK) return;
        this.accept(event.data.value);
    };
    private accept = (value: unknown) => {
        const traceId = object(value) && object(value.packet) && isId(value.packet.id) ? value.packet.id : undefined;
        const trace = { traceId, portId: this.direct?.connectionId };
        transportEvent({ ...trace, event: 'rpc-received' });
        if (!this.keys || !verified(value, this.keys.publicKey)) {
            transportEvent({ ...trace, event: 'rpc-rejected', detail: 'bad-signature' }); return;
        }
        const p = value.packet, pending = this.pending.get(p.id);
        if (!pending) { transportEvent({ ...trace, event: 'rpc-rejected', detail: 'no-pending' }); return; }
        const q = pending.packet;
        if (p.type !== 'reply' || p.host !== q.host || p.endpoint !== q.endpoint || p.document !== q.document || p.origin !== q.origin || p.operation !== q.operation || p.scope !== q.scope || p.deadline !== q.deadline) {
            transportEvent({ ...trace, event: 'rpc-rejected', detail: p.host !== q.host ? 'wrong-host' : p.origin !== q.origin ? 'wrong-origin' : 'wrong-shape' }); return;
        }
        this.pending.delete(p.id); clearTimeout(pending.timer); pending.stop?.();
        try {
            this.assertCurrent();
            if (Date.now() >= p.deadline) {
                transportEvent({ ...trace, event: 'rpc-rejected', detail: 'expired' });
                // A suspended tab may deliver its expired reply before its timer.
                if (this.direct && this.directGeneration !== undefined) this.direct.requestTimedOut(this.directGeneration);
                throw new RequestDeadlineError('The reply expired. Retry.');
            }
            if (this.direct && this.directGeneration !== undefined) {
                this.direct.acknowledge(this.directGeneration); this.authenticated = true; this.direct.confirm();
            }
            transportEvent({ ...trace, event: 'rpc-accepted', pending: this.pending.size });
            if (p.error) throw new Error(p.error);
            pending.resolve(p.body);
        }
        catch (error) { pending.reject(error instanceof Error ? error : new Error('Invalid reply.')); }
    };
    async call(operation: Packet['operation'], body?: any, timeout = 15000, deadline = Infinity): Promise<any> {
        // Foreground field selection calls assertSelected explicitly before and
        // after fetching fields, including detection of an older App selection.
        if (!this.direct) await this.assertSelected();
        this.assertCurrent();
        if (Date.now() >= deadline) throw new RequestDeadlineError('The connection attempt expired. Try again.');
        const route = this.route, keys = this.keys, peer = this.window;
        if (!route || !keys) throw new Error('Connect to KeeWebX first.');
        const p: Packet = { type: 'request', host: route.host, endpoint: this.endpoint.href, id: uuid(), document: this.document, origin: location.origin,
            operation, scope: this.scope, deadline: Math.min(Date.now() + timeout, this.scope ? this.expiresAt : Infinity, deadline), body };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const pending = this.pending.get(p.id);
                if (!pending) return;
                pending.stop?.();
                this.pending.delete(p.id);
                transportEvent({ event: 'rpc-rejected', traceId: p.id, portId: this.direct?.connectionId, detail: 'expired' });
                if (this.direct && this.directGeneration !== undefined) this.direct.requestTimedOut(this.directGeneration);
                reject(new RequestDeadlineError('The KeeWebX request timed out. Try Find accounts again.'));
            }, Math.max(1, p.deadline - Date.now()));
            this.pending.set(p.id, { packet: p, resolve, reject, timer });
            transportEvent({ event: 'rpc-sent', traceId: p.id, portId: this.direct?.connectionId, pending: this.pending.size });
            try {
                if (this.direct) {
                    const envelope = signed(p, keys), port = this.direct, generation = port.generation;
                    if (operation === 'hello' || operation === 'wire' && route.wireReceipt === 1) {
                        // Repeat only the identical signed envelope. A capable
                        // receiver resends its receipt without re-executing work.
                        const retry = setInterval(() => {
                            if (!this.pending.has(p.id) || Date.now() >= p.deadline) { clearInterval(retry); return; }
                            try { this.assertCurrent(); port.assert(generation); port.send(envelope); }
                            catch (error) {
                                const pending = this.pending.get(p.id);
                                if (pending) {
                                    pending.stop?.(); clearTimeout(pending.timer); this.pending.delete(p.id);
                                    pending.reject(error instanceof Error ? error : new Error('The website port is unavailable.'));
                                }
                            }
                        }, 750);
                        this.pending.get(p.id)!.stop = () => clearInterval(retry);
                    }
                    this.direct.send(envelope);
                }
                else if (peer) peer.postMessage({ marker: MARK, value: signed(p, keys) }, this.endpoint.origin);
                else this.pending.get(p.id)!.stop = mailboxRequest(signed(p, keys), this.accept, error => {
                    this.pending.get(p.id)?.stop?.(); this.pending.delete(p.id); clearTimeout(timer); reject(error);
                });
            }
            catch (error) { clearTimeout(timer); this.pending.get(p.id)?.stop?.(); this.pending.delete(p.id); reject(error); }
        });
    }
    dispose(): void {
        if (!this.live) return;
        this.live = false; removeEventListener('message', this.receive); this.unsubscribeDirect?.();
        this.cancelSetup?.();
        if (this.direct && !this.authenticated && !this.direct.authenticatedReady && this.directGeneration === this.direct.generation) this.direct.reset('The connection attempt was canceled.');
        for (const item of this.pending.values()) { clearTimeout(item.timer); item.stop?.(); item.reject(new Error('The operation was canceled.')); }
        this.pending.clear();
        if (this.scope && this.route && this.keys) {
            try {
                const p: Packet = { type: 'request', host: this.route.host, endpoint: this.endpoint.href, id: uuid(), document: this.document,
                    origin: new URL(this.href).origin, operation: 'release', scope: this.scope, deadline: Date.now() + 3000 };
                if (this.direct) this.direct.send(signed(p, this.keys));
                else if (this.window && !this.window.closed) this.window.postMessage({ marker: MARK, value: signed(p, this.keys) }, this.endpoint.origin);
                else if (this.route.mailbox) mailboxRelease(signed(p, this.keys));
            } catch {}
        }
    }
}

/** A small visible relay. It cannot decrypt the Connect wire payloads. */
export function startConnector(endpoint: URL): void {
    const routingId = new URL(location.href).searchParams.get('kwx-client');
    if (!isId(routingId)) {
        document.querySelector('#connect-helper-loading [role="status"]')!.textContent = 'This connection page is from an older version. Close it and choose Connect to KeeWebX once on your website.';
        return;
    }
    // Set the name after arrival: cross-site navigation may clear window.name.
    window.name = connectorName(endpoint, routingId);
    document.getElementById('connect-helper-loading')?.remove();
    const panel = document.createElement('main');
    panel.style.cssText = 'max-width:420px;margin:12vh auto;padding:24px;font:16px/1.6 system-ui;color:CanvasText;background:Canvas;border-radius:20px';
    const heading = document.createElement('h1'); heading.textContent = 'KeeWebX Connect'; heading.style.fontSize = '24px';
    const status = document.createElement('p'); status.textContent = 'Connecting to your website…'; status.setAttribute('role', 'status');
    const back = document.createElement('button'); back.textContent = 'Back to website'; back.disabled = true;
    back.style.cssText = 'font:inherit;padding:12px 20px;border:0;border-radius:12px;background:#1769e0;color:white';
    const app = document.createElement('a'); app.textContent = 'Open a new KeeWebX tab'; app.href = endpoint.href; app.target = '_blank'; app.rel = 'noopener noreferrer'; app.style.marginLeft = '16px'; app.hidden = true;
    const note = document.createElement('p'); note.textContent = 'This connection page restores the link to the KeeWebX tab you already authorized. It does not open another vault. If that app does not reply, visit its existing tab, unlock if needed, and return.';
    note.style.fontSize = '13px';
    const returnStatus = document.createElement('p'); returnStatus.hidden = true;
    returnStatus.setAttribute('aria-live', 'polite'); returnStatus.setAttribute('data-role', 'website-return-status');
    panel.append(heading, status, back, app, note, returnStatus); document.body.append(panel);
    void approvedRoute(endpoint, true).then(selected => {
        // A missing route is a first-use situation. An unresponsive authorized
        // route must never be treated as permission to open a replacement vault.
        if (!selected && window.opener) {
            app.hidden = false;
            note.textContent = 'No app is authorized. Authorize Connect in an existing KeeWebX tab first. Open a new tab only if you do not already have one.';
        }
    }).catch(() => { note.textContent = 'Connection settings could not be read. Return to your existing KeeWebX tab and retry; do not open another vault.'; });
    if (!window.opener) {
        status.textContent = 'This website did not keep a window link. Return to it and choose Find accounts; the authorized app can be used without this page.';
        note.textContent = 'You can close this optional connection page.';
        app.hidden = true; back.disabled = false; back.textContent = 'Close connection page';
        back.onclick = event => { if (event.isTrusted) window.close(); };
        return;
    }
    const channel = new BroadcastChannel(channelName(endpoint));
    let peer: Window | undefined, origin: string | undefined, active = true;
    let returning: { peer: Window; origin: string; nonce: string; deadline: number; timer?: ReturnType<typeof setTimeout> } | undefined;
    const stopReturn = () => {
        clearTimeout(returning?.timer); returning = undefined;
        back.textContent = 'Back to website';
    };
    const finishReturn = (focused: boolean) => {
        stopReturn(); back.disabled = false; returnStatus.hidden = false;
        returnStatus.textContent = focused
            ? 'Your website is visible and focused. Keep this connection page open while using Connect.'
            : 'The website has not confirmed focus. Use Safari’s tabs button to switch to your existing website. Keep this connection page open so Connect stays linked.';
    };
    const pending = new Map<string, Packet>();
    const link = new SiteLink(window.opener, (window, site) => {
        if (peer !== window || origin !== site) { pending.clear(); if (returning) finishReturn(false); }
        peer = window; origin = site; back.disabled = false;
        status.textContent = `Connection page ready for ${site}. Checking your existing KeeWebX tab…`;
        peer.postMessage({ marker: MARK, kind: 'ready', routingId, endpoint: endpoint.href }, site);
    }, expired => {
        if (!peer || expired) status.textContent = 'Return to your website and choose Reconnect to existing tab if needed.';
    }, { followOpener: true, routingId, endpoint: endpoint.href });
    back.onclick = event => {
        if (!event.isTrusted || !active) return;
        stopReturn();
        if (!peer || peer.closed || !origin) { finishReturn(false); return; }
        const attempt = { peer, origin, nonce: uuid(), deadline: Date.now() + 2000, timer: undefined as ReturnType<typeof setTimeout> | undefined };
        returning = attempt; back.disabled = true; back.textContent = 'Checking website…';
        returnStatus.hidden = false; returnStatus.textContent = 'Switching to your existing website and checking that it is visible and focused…';
        attempt.timer = setTimeout(() => { if (returning === attempt) finishReturn(false); }, 2000);
        try {
            // Keep the focus request in the trusted tap's synchronous call stack.
            peer.focus();
            peer.postMessage({ marker: MARK, kind: 'return-to-website', routingId, endpoint: endpoint.href,
                websiteOrigin: origin, nonce: attempt.nonce }, origin);
        } catch { finishReturn(false); }
    };
    addEventListener('message', event => {
        if (!active || !event.isTrusted || event.source !== peer || event.origin !== origin || event.data?.marker !== MARK) return;
        if (event.data.kind === 'website-focused') {
            if (returning && event.source === returning.peer && event.origin === returning.origin &&
                !returning.peer.closed && Date.now() < returning.deadline && event.data.nonce === returning.nonce &&
                event.data.routingId === routingId && event.data.endpoint === endpoint.href && event.data.websiteOrigin === origin &&
                event.data.visible === true && event.data.focused === true) finishReturn(true);
            return;
        }
        if (!object(event.data.value?.packet)) return;
        const p = event.data.value.packet as Packet;
        if (p.type !== 'request' || p.origin !== event.origin || p.endpoint !== endpoint.href || !valid(p)) return;
        for (const [id, request] of pending) if (request.deadline <= Date.now()) pending.delete(id);
        if (pending.size >= 32) return;
        if (p.operation !== 'release') pending.set(p.id, p);
        channel.postMessage({ marker: MARK, value: event.data.value });
    });
    channel.onmessage = event => { void (async () => {
        if (!active || !event.isTrusted || event.origin !== location.origin || event.data?.marker !== MARK || !object(event.data.value?.packet)) return;
        const p = event.data.value.packet as Packet, q = pending.get(p.id);
        if (!q || p.type !== 'reply' || !peer || peer.closed || p.origin !== origin || p.document !== q.document || p.host !== q.host || p.endpoint !== q.endpoint || p.scope !== q.scope || p.operation !== q.operation || p.deadline !== q.deadline || Date.now() >= p.deadline) return;
        const destination = peer, site = origin;
        const selected = await approvedRoute(endpoint, true);
        // Same-origin channel messages are not proof of app identity. Verify
        // before consuming a pending reply or displaying connectivity status.
        if (!selected || selected.host !== p.host || !verified(event.data.value, fromBase64(selected.publicKey)) ||
            !active || peer !== destination || origin !== site || pending.get(p.id) !== q || Date.now() >= p.deadline) return;
        if (['hello', 'probe'].includes(p.operation)) {
            app.hidden = true;
            if (p.error) status.textContent = 'Your existing KeeWebX tab replied but is not ready. Visit that tab, unlock if needed, then return to the website.';
            else if (p.body?.appBoot === selected.host) status.textContent = 'Connected to your existing KeeWebX tab. Return to the website to find accounts.';
        }
        pending.delete(p.id); destination.postMessage({ marker: MARK, value: event.data.value }, site!);
    })().catch(() => { status.textContent = 'Could not verify the existing app connection. Return to your existing KeeWebX tab, then retry.'; }); };
    const resume = () => {
        active = true; link.restart();
    };
    addEventListener('pagehide', () => { active = false; link.pause(); pending.clear(); if (returning) finishReturn(false); });
    addEventListener('pageshow', event => { if (event.persisted) resume(); });
    addEventListener('visibilitychange', () => { if (active && !document.hidden) link.restart(); });
    resume();
}
