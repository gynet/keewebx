import { sign } from 'tweetnacl';
import { fromBase64, toBase64 } from '../../src/background/utils';
import { AppBridge } from './app-bridge';
import { identity } from './identity';
import { isId, object, SESSION_TTL, uuid } from './native-rpc';
import { SiteLink, SETUP_MARK } from './site-link';
import { ConnectMailbox, mailboxRequest, mailboxRelease } from './connect-mailbox';

const MARK = 'keewebx-native-connect-v1';
const channelName = (endpoint: URL) => `${MARK}:${endpoint.href}`;
const routeKey = (endpoint: URL) => `${MARK}:selected:${endpoint.href}`;
type Keys = { publicKey: Uint8Array; secretKey: Uint8Array };
type Route = { host: string; owner: string; endpoint: string; publicKey: string; mailbox?: boolean };
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
export async function approvedRoute(endpoint: URL): Promise<Route | undefined> {
    const route = await managerCall(() => GM.getValue(routeKey(endpoint)));
    if (object(route) && isId(route.host) && isId(route.owner) && route.endpoint === endpoint.href && typeof route.publicKey === 'string') return route as Route;
}
const valid = (p: Packet) => isId(p.host) && isId(p.id) && isId(p.document) && /^https:\/\/[^/]+$/.test(p.origin) &&
    Number.isFinite(p.deadline) && p.deadline > Date.now() && p.deadline <= Date.now() + 66000 &&
    ['hello', 'wire', 'probe', 'focus', 'release'].includes(p.operation);

/** One explicitly selected app, one active encrypted protocol session. */
export class NativeHost {
    private host = uuid();
    private owner = uuid();
    private ownerReady: Promise<void>;
    private authorization = 0;
    private channel: BroadcastChannel;
    private mailbox: ConnectMailbox;
    private keys?: Keys;
    private live = false;
    private locked = false;
    private consumed = new Map<string, number>();
    private session?: { document: string; origin: string; scope: string; expiresAt: number; bridge: AppBridge; locked: boolean; busy: boolean };
    constructor(private endpoint: URL, private onError: (error: Error) => void = () => {}) {
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
        this.mailbox = new ConnectMailbox(this.host, (value, reply) => this.receive(value, reply), this.onError);
    }
    async selected(): Promise<boolean> { await this.ownerReady; const route = await approvedRoute(this.endpoint); return !route || route.owner === this.owner; }
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
        const valid = () => generation === this.authorization && current();
        await this.ownerReady;
        if (!valid()) throw new Error('Authorization was canceled.');
        try {
            await this.updateRoute(async () => {
                if (!valid()) throw new Error('Authorization was canceled.');
                if (mode === 'restore') {
                    const route = await GM.getValue(routeKey(this.endpoint));
                    if (route && route.owner !== this.owner) throw new Error('Another KeeWebX tab was selected. Authorize this tab explicitly to replace it.');
                    if (!valid()) throw new Error('Authorization was canceled.');
                }
                await GM.setValue(routeKey(this.endpoint), { host: this.host, owner: this.owner, endpoint: this.endpoint.href, publicKey: toBase64(keys.publicKey), mailbox: this.mailbox.available } satisfies Route);
                if (!valid() && (await GM.getValue(routeKey(this.endpoint)))?.host === this.host) await GM.deleteValue(routeKey(this.endpoint));
            });
        } catch (error) { if (generation === this.authorization) this.authorization++; throw error; }
        if (!valid()) throw new Error('Authorization was canceled.');
        this.keys = keys; this.locked = false; this.live = true; this.mailbox.start();
    }
    resume(): void { if (this.keys) { this.live = true; this.mailbox.start(); } }
    lock(): void { this.locked = true; this.session?.bridge.dispose(); this.session = undefined; }
    pause(): void { this.authorization++; this.live = false; this.mailbox.stop(); this.session?.bridge.dispose(); this.session = undefined; }
    async revoke(): Promise<void> {
        this.pause(); this.keys = undefined;
        await this.updateRoute(async () => {
            if ((await GM.getValue(routeKey(this.endpoint)))?.host === this.host) await GM.deleteValue(routeKey(this.endpoint));
        });
    }
    private async receive(value: unknown, reply: (value: Signed) => void | Promise<void> = value => this.channel.postMessage({ marker: MARK, value })): Promise<void> {
        const authorization = this.authorization;
        const keys = this.keys;
        if (!this.live || !keys || !verified(value, keys.publicKey)) return;
        const p = value.packet;
        if (p.type !== 'request' || p.host !== this.host || p.endpoint !== this.endpoint.href || !valid(p)) return;
        for (const [id, until] of this.consumed) if (until <= Date.now()) this.consumed.delete(id);
        if (this.consumed.has(p.id) || this.consumed.size >= 1024) return;
        this.consumed.set(p.id, p.deadline);
        // A previously selected tab must stop serving after another app wins.
        if ((await approvedRoute(this.endpoint))?.host !== this.host || authorization !== this.authorization || !this.live || this.keys !== keys || Date.now() >= p.deadline) return;
        let body: any, error: string | undefined;
        try {
            if (this.locked) throw new Error('KeeWebX is locked. Unlock that app tab, then retry.');
            let session = this.session;
            if (p.operation === 'hello') {
                if (session?.busy) throw new Error('Another website request is finishing. Retry.');
                session?.bridge.dispose();
                session = { document: p.document, origin: p.origin, scope: uuid(), expiresAt: Date.now() + SESSION_TTL, bridge: new AppBridge(), locked: false, busy: false };
                const current = session;
                session.bridge.onLocked = () => { current.locked = true; };
                this.session = session;
                body = { scope: session.scope, appBoot: this.host, expiresAt: session.expiresAt };
            } else {
                if (!session || session.document !== p.document || session.origin !== p.origin || session.scope !== p.scope || session.expiresAt <= Date.now()) throw new Error('The website session changed. Find accounts again.');
                if (p.operation === 'release') { session.bridge.dispose(); this.session = undefined; return; }
                if (p.operation === 'probe' || p.operation === 'focus') body = { visibility: document.visibilityState, appBoot: this.host };
                else {
                    if (session.locked) throw new Error('KeeWebX is locked. Unlock that app tab, then retry.');
                    if (session.busy) throw new Error('A request is already running. Retry.');
                    session.busy = true;
                    try { body = await session.bridge.request(p.body, Math.min(p.deadline, session.expiresAt)); }
                    finally { session.busy = false; }
                }
                if (this.session !== session) return;
            }
        } catch (reason) { error = reason instanceof Error ? reason.message : 'KeeWebX could not complete the request.'; }
        if (authorization === this.authorization && this.live && this.keys === keys && Date.now() < p.deadline) {
            try { await reply(signed({ ...p, type: 'reply', body, error }, keys)); }
            catch (reason) { this.onError(reason instanceof Error ? reason : new Error('The connection page is unavailable.')); }
        }
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
    private cancelSetup?: () => void;
    private pending = new Map<string, { packet: Packet; resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; stop?: () => void }>();
    constructor(private endpoint: URL, private peer: () => Window | undefined, private progress: (stage: string) => void = () => {}) { addEventListener('message', this.receive); }
    assertCurrent(): void {
        if (!this.live || location.href !== this.href || this.window?.closed) throw new Error('The website or connection page changed. Connect again.');
        if (this.scope && Date.now() >= this.expiresAt) throw new Error('The account list expired. Find accounts again.');
    }
    async assertSelected(): Promise<void> {
        this.assertCurrent();
        const current = await approvedRoute(this.endpoint); this.assertCurrent();
        if (!this.route || current?.host !== this.route.host || current.publicKey !== this.route.publicKey) throw new Error('The selected app changed. Find accounts again.');
    }
    async connect(): Promise<void> {
        this.window = this.peer(); if (this.window?.closed) this.window = undefined; this.assertCurrent();
        this.progress('Checking saved authorization');
        this.keys = await managerCall(() => identity()); this.route = await approvedRoute(this.endpoint); this.assertCurrent();
        if (!this.route || this.route.publicKey !== toBase64(this.keys.publicKey)) throw new Error('Unlock KeeWebX and authorize Connect there once.');
        if (this.window) try {
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
                const timer = setTimeout(() => finish(new Error('The connection page did not respond.')), 2000);
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
        if (!this.window && !this.route.mailbox) throw new Error('Update Connect in your existing KeeWebX app tab, or open its connection page once.');
        this.progress('Contacting the selected app');
        const result = await this.call('hello', undefined, 8000);
        if (!object(result) || !isId(result.scope) || result.appBoot !== this.route.host || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now() || result.expiresAt > Date.now() + SESSION_TTL + 1000) throw new Error('Invalid app handshake.');
        this.scope = result.scope; this.expiresAt = result.expiresAt;
    }
    private receive = (event: MessageEvent) => {
        if (!event.isTrusted || event.source !== this.window || event.origin !== this.endpoint.origin || event.data?.marker !== MARK) return;
        this.accept(event.data.value);
    };
    private accept = (value: unknown) => {
        if (!this.keys || !verified(value, this.keys.publicKey)) return;
        const p = value.packet, pending = this.pending.get(p.id);
        if (!pending) return;
        const q = pending.packet;
        if (p.type !== 'reply' || p.host !== q.host || p.endpoint !== q.endpoint || p.document !== q.document || p.origin !== q.origin || p.operation !== q.operation || p.scope !== q.scope || p.deadline !== q.deadline) return;
        this.pending.delete(p.id); clearTimeout(pending.timer); pending.stop?.();
        try { this.assertCurrent(); if (Date.now() >= p.deadline) throw new Error('The reply expired. Retry.'); if (p.error) throw new Error(p.error); pending.resolve(p.body); }
        catch (error) { pending.reject(error instanceof Error ? error : new Error('Invalid reply.')); }
    };
    async call(operation: Packet['operation'], body?: any, timeout = 15000): Promise<any> {
        await this.assertSelected();
        this.assertCurrent();
        const route = this.route, keys = this.keys, peer = this.window;
        if (!route || !keys) throw new Error('Connect to KeeWebX first.');
        const p: Packet = { type: 'request', host: route.host, endpoint: this.endpoint.href, id: uuid(), document: this.document, origin: location.origin,
            operation, scope: this.scope, deadline: Math.min(Date.now() + timeout, this.scope ? this.expiresAt : Infinity), body };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.get(p.id)?.stop?.();
                this.pending.delete(p.id);
                reject(new Error('Visit your existing KeeWebX tab, unlock if needed, then retry. No new page is needed.'));
            }, Math.max(1, p.deadline - Date.now()));
            this.pending.set(p.id, { packet: p, resolve, reject, timer });
            try {
                if (peer) peer.postMessage({ marker: MARK, value: signed(p, keys) }, this.endpoint.origin);
                else this.pending.get(p.id)!.stop = mailboxRequest(signed(p, keys), this.accept, error => {
                    this.pending.get(p.id)?.stop?.(); this.pending.delete(p.id); clearTimeout(timer); reject(error);
                });
            }
            catch (error) { clearTimeout(timer); this.pending.delete(p.id); reject(error); }
        });
    }
    dispose(): void {
        if (!this.live) return;
        this.live = false; removeEventListener('message', this.receive);
        this.cancelSetup?.();
        for (const item of this.pending.values()) { clearTimeout(item.timer); item.stop?.(); item.reject(new Error('The operation was canceled.')); }
        this.pending.clear();
        if (this.scope && this.route && this.keys) {
            try {
                const p: Packet = { type: 'request', host: this.route.host, endpoint: this.endpoint.href, id: uuid(), document: this.document,
                    origin: new URL(this.href).origin, operation: 'release', scope: this.scope, deadline: Date.now() + 3000 };
                if (this.window && !this.window.closed) this.window.postMessage({ marker: MARK, value: signed(p, this.keys) }, this.endpoint.origin);
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
    const app = document.createElement('a'); app.textContent = 'Open KeeWebX'; app.href = endpoint.href; app.target = '_blank'; app.rel = 'noopener noreferrer'; app.style.marginLeft = '16px';
    const note = document.createElement('p'); note.textContent = 'Keep this connection page open. It forwards encrypted messages to the app you authorized. If the app is asleep, visit its existing tab and return.';
    note.style.fontSize = '13px';
    panel.append(heading, status, back, app, note); document.body.append(panel);
    if (!window.opener) {
        status.textContent = 'This website did not keep a window link. Return to it and choose Find accounts; the authorized app can be used without this page.';
        note.textContent = 'You can close this optional connection page.';
        app.hidden = true; back.disabled = false; back.textContent = 'Close connection page';
        back.onclick = event => { if (event.isTrusted) window.close(); };
        return;
    }
    const channel = new BroadcastChannel(channelName(endpoint));
    let peer: Window | undefined, origin: string | undefined, active = true;
    const pending = new Map<string, Packet>();
    const link = new SiteLink(window.opener, (window, site) => {
        if (peer !== window || origin !== site) pending.clear();
        peer = window; origin = site; back.disabled = false;
        status.textContent = `Connection page ready for ${site}. Return to your website and select an account.`;
        peer.postMessage({ marker: MARK, kind: 'ready', routingId, endpoint: endpoint.href }, site);
    }, expired => {
        if (!peer || expired) status.textContent = 'Return to your website. If the connection is unavailable, choose Connect to KeeWebX there.';
    }, { followOpener: true, routingId, endpoint: endpoint.href });
    back.onclick = event => { if (event.isTrusted && peer && !peer.closed) peer.focus(); };
    addEventListener('message', event => {
        if (!active || !event.isTrusted || event.source !== peer || event.origin !== origin || event.data?.marker !== MARK || !object(event.data.value?.packet)) return;
        const p = event.data.value.packet as Packet;
        if (p.type !== 'request' || p.origin !== event.origin || p.endpoint !== endpoint.href || !valid(p)) return;
        for (const [id, request] of pending) if (request.deadline <= Date.now()) pending.delete(id);
        if (pending.size >= 32) return;
        if (p.operation !== 'release') pending.set(p.id, p);
        channel.postMessage({ marker: MARK, value: event.data.value });
    });
    channel.onmessage = event => {
        if (!active || !event.isTrusted || event.origin !== location.origin || event.data?.marker !== MARK || !object(event.data.value?.packet)) return;
        const p = event.data.value.packet as Packet, q = pending.get(p.id);
        if (!q || p.type !== 'reply' || !peer || peer.closed || p.origin !== origin || p.document !== q.document || p.host !== q.host || p.endpoint !== q.endpoint || p.scope !== q.scope || p.operation !== q.operation || p.deadline !== q.deadline || Date.now() >= p.deadline) return;
        pending.delete(p.id); peer.postMessage({ marker: MARK, value: event.data.value }, origin!);
    };
    const resume = () => {
        active = true; link.restart();
    };
    addEventListener('pagehide', () => { active = false; link.pause(); pending.clear(); });
    addEventListener('pageshow', event => { if (event.persisted) resume(); });
    addEventListener('visibilitychange', () => { if (active && !document.hidden) link.restart(); });
    resume();
}
