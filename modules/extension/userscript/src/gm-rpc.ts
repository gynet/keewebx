import { sign } from 'tweetnacl';
import { fromBase64, toBase64 } from '../../src/background/utils';
import { AppBridge } from './app-bridge';
import { identity } from './identity';
import { isId, object, SESSION_TTL, uuid } from './native-rpc';

declare const GM: {
    getValue(key: string): Promise<any>;
    setValue(key: string, value: any): Promise<void>;
    deleteValue(key: string): Promise<void>;
    listValues(): Promise<string[]>;
    getTab?: () => Promise<Record<string, any>>;
    saveTab?: (value: Record<string, any>) => Promise<void>;
};
type Keys = { publicKey: Uint8Array; secretKey: Uint8Array };
type Route = { host: string; endpoint: string; publicKey: string };
type Packet = { host: string; endpoint: string; id: string; document: string; origin: string;
    operation: 'hello' | 'wire' | 'probe' | 'release'; deadline: number; scope?: string; body?: any; error?: string };
type Signed = { packet: Packet; signature: string };
const ROOT = 'keewebx-userscript-connect-';
const requestPrefix = (host: string) => `${ROOT}request-v2:${host}:`;
const replyKey = (host: string, id: string) => `${ROOT}reply-v2:${host}:${id}`;
const routeKey = (endpoint: URL) => `${ROOT}route-v2:${endpoint.href}`;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const signed = (packet: Packet, keys: Keys): Signed => ({ packet, signature: toBase64(sign.detached(bytes(packet), keys.secretKey)) });
const verified = (value: unknown, key: Uint8Array): value is Signed => {
    if (!object(value) || !object(value.packet) || typeof value.signature !== 'string') return false;
    try { return sign.detached.verify(bytes(value.packet), fromBase64(value.signature), key); } catch { return false; }
};
export async function approvedRoute(endpoint: URL): Promise<Route | undefined> {
    const value = await GM.getValue(routeKey(endpoint));
    if (object(value) && isId(value.host) && value.endpoint === endpoint.href && typeof value.publicKey === 'string') return value as Route;
}

/** The script manager transports signed envelopes; credential payloads stay encrypted. */
export class GmHost {
    private keys?: Keys;
    private timer?: ReturnType<typeof setTimeout>;
    private live = false;
    private polling = false;
    private activeUntil = 0;
    private sessions = new Map<string, { origin: string; scope: string; expiresAt: number; bridge: AppBridge; locked?: boolean }>();
    private processing = new Set<string>();
    private consumed = new Map<string, number>();
    private idPromise: Promise<string>;
    constructor(private endpoint: URL) { this.idPromise = this.tabId(); }

    private async tabId(): Promise<string> {
        const key = `${ROOT}host-v2:${this.endpoint.href}`;
        if (GM.getTab && GM.saveTab) {
            try {
                const tab = await GM.getTab();
                if (!isId(tab[key])) { tab[key] = uuid(); await GM.saveTab(tab); }
                return tab[key];
            } catch { /* Older managers can use the tab's session storage instead. */ }
        }
        let id: string | null = null;
        try { id = sessionStorage.getItem(key); } catch {}
        if (!isId(id)) { id = uuid(); try { sessionStorage.setItem(key, id); } catch {} }
        return id!;
    }

    async selected(): Promise<boolean> {
        const route = await approvedRoute(this.endpoint);
        return !route || route.host === await this.idPromise;
    }
    async authorize(keys: Keys): Promise<void> {
        this.keys = keys;
        const host = await this.idPromise;
        await GM.setValue(routeKey(this.endpoint), { host, endpoint: this.endpoint.href, publicKey: toBase64(keys.publicKey) } satisfies Route);
        this.resume();
    }
    resume(): void { if (!this.keys || this.live) return; this.live = true; void this.poll(); }
    pause(): void {
        this.live = false; clearTimeout(this.timer);
        for (const session of this.sessions.values()) session.bridge.dispose();
        this.sessions.clear();
    }
    async revoke(): Promise<void> {
        this.pause(); this.keys = undefined;
        const host = await this.idPromise;
        if ((await approvedRoute(this.endpoint))?.host === host) await GM.deleteValue(routeKey(this.endpoint));
    }

    private async poll(): Promise<void> {
        if (!this.live || this.polling) return;
        this.polling = true;
        try {
            const host = await this.idPromise;
            const now = Date.now();
            for (const [id, deadline] of this.consumed) if (deadline <= now) this.consumed.delete(id);
            for (const [id, session] of this.sessions) if (session.expiresAt <= now) { session.bridge.dispose(); this.sessions.delete(id); }
            const keys = await GM.listValues();
            if (!this.live) return;
            for (const key of keys) {
                if (key.startsWith(requestPrefix(host)) && !this.processing.has(key)) {
                    this.processing.add(key); this.activeUntil = now + 5000;
                    void this.handle(key, host).finally(() => this.processing.delete(key));
                } else if (key.startsWith(`${ROOT}reply-v2:${host}:`)) {
                    const value = await GM.getValue(key);
                    if (!Number.isFinite(value?.packet?.deadline) || value.packet.deadline <= now) await GM.deleteValue(key);
                }
            }
        } catch { /* A transient manager-storage error is retried without opening tabs. */ }
        finally {
            this.polling = false;
            if (this.live) this.timer = setTimeout(() => { void this.poll(); }, Date.now() < this.activeUntil ? 60 : 500);
        }
    }

    private async handle(key: string, host: string): Promise<void> {
        try {
            const value = await GM.getValue(key);
            await GM.deleteValue(key);
            const keys = this.keys;
            if (!this.live || !keys || !verified(value, keys.publicKey)) return;
            const p = value.packet;
            if (p.host !== host || p.endpoint !== this.endpoint.href || key !== requestPrefix(host) + p.id ||
                !isId(p.id) || !isId(p.document) || !/^https:\/\/[^/]+$/.test(p.origin) ||
                !Number.isFinite(p.deadline) || p.deadline <= Date.now() || p.deadline > Date.now() + 66000 ||
                !['hello', 'wire', 'probe', 'release'].includes(p.operation)) return;
            if (this.consumed.has(p.id)) return;
            this.consumed.set(p.id, p.deadline);
            let body: any;
            let error: string | undefined;
            try {
                let session = this.sessions.get(p.document);
                if (p.operation === 'hello') {
                    if (session && session.origin !== p.origin) throw new Error('The website origin changed. Find accounts again.');
                    if (!session) {
                        if (this.sessions.size >= 128) throw new Error('Too many active website connections. Close unused login tabs and retry.');
                        session = { origin: p.origin, scope: uuid(), expiresAt: Date.now() + SESSION_TTL, bridge: new AppBridge() };
                        const connection = session;
                        session.bridge.onLocked = () => { connection.locked = true; };
                        this.sessions.set(p.document, session);
                    }
                    body = { scope: session.scope, appBoot: host, expiresAt: session.expiresAt };
                } else {
                    if (!session || session.origin !== p.origin || session.scope !== p.scope || session.expiresAt <= Date.now()) throw new Error('Find accounts again to renew this website connection.');
                    if (p.operation === 'release') { session.bridge.dispose(); this.sessions.delete(p.document); return; }
                    if (p.operation === 'probe') body = { visibility: document.visibilityState, appBoot: host };
                    else {
                        if (session.locked) throw new Error('KeeWebX is locked. Unlock the existing app tab and find accounts again.');
                        body = await session.bridge.request(p.body, Math.min(p.deadline, session.expiresAt));
                    }
                    if (this.sessions.get(p.document) !== session) return;
                }
            } catch (reason) { error = reason instanceof Error ? reason.message : 'The KeeWebX request failed.'; }
            if (this.live && this.keys === keys && Date.now() < p.deadline) {
                await GM.setValue(replyKey(host, p.id), signed({ ...p, body, error }, keys));
            }
        } catch { /* Invalid or canceled packets never grant access or log their payload. */ }
    }
}

/** One website document's client. Only pending operations poll manager-private storage. */
export class GmRpc {
    readonly document = uuid();
    readonly href = location.href;
    private route?: Route;
    private keys?: Keys;
    private live = true;
    private scope?: string;
    private expiresAt = 0;
    private pending = new Map<string, { request: string; reply: string; cancel(): void }>();
    constructor(private endpoint: URL) {}
    assertCurrent(): void {
        if (!this.live || location.href !== this.href) throw new Error('The website changed. Find accounts again.');
        if (this.scope && Date.now() >= this.expiresAt) throw new Error('The account list expired. Find accounts again.');
    }
    async assertSelected(): Promise<void> {
        this.assertCurrent();
        const selected = await approvedRoute(this.endpoint);
        this.assertCurrent();
        if (!this.route || selected?.host !== this.route.host || selected.publicKey !== this.route.publicKey) throw new Error('The authorized KeeWebX tab changed. Find accounts again.');
    }
    async connect(): Promise<void> {
        this.keys = await identity(); this.assertCurrent();
        this.route = await approvedRoute(this.endpoint); this.assertCurrent();
        if (!this.route || this.route.publicKey !== toBase64(this.keys.publicKey)) throw new Error('Authorize Connect once in your KeeWebX tab. Then all websites can use it.');
        const result = await this.call('hello', undefined, 15000);
        if (!object(result) || !isId(result.scope) || result.appBoot !== this.route.host ||
            !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now() || result.expiresAt > Date.now() + SESSION_TTL + 1000) throw new Error('Invalid KeeWebX connection response.');
        this.scope = result.scope; this.expiresAt = result.expiresAt;
    }
    async call(operation: Packet['operation'], body?: any, timeout = 65000): Promise<any> {
        await this.assertSelected();
        const route = this.route, keys = this.keys;
        if (!route || !keys) throw new Error('Connect to your authorized KeeWebX tab first.');
        const p: Packet = { host: route.host, endpoint: this.endpoint.href, id: uuid(), document: this.document,
            origin: location.origin, operation, scope: this.scope, deadline: Math.min(Date.now() + timeout, this.scope ? this.expiresAt : Infinity), body };
        const request = requestPrefix(route.host) + p.id, reply = replyKey(route.host, p.id);
        return new Promise((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            let checkRouteAt = Date.now() + 500;
            const finish = (error?: Error, result?: any) => {
                if (!this.pending.delete(p.id)) return;
                clearTimeout(timer);
                void Promise.allSettled([GM.deleteValue(request), GM.deleteValue(reply)]);
                if (error) reject(error); else resolve(result);
            };
            this.pending.set(p.id, { request, reply, cancel: () => finish(new Error('The website operation was canceled.')) });
            const poll = async () => {
                try {
                    this.assertCurrent();
                    if (Date.now() >= p.deadline) throw new Error('The authorized KeeWebX tab did not reply. Resume that tab and try again.');
                    if (Date.now() >= checkRouteAt) { await this.assertSelected(); checkRouteAt = Date.now() + 500; }
                    const result = await GM.getValue(reply);
                    this.assertCurrent();
                    if (!this.pending.has(p.id)) return;
                    if (verified(result, keys.publicKey)) {
                        const response = result.packet;
                        if (response.host === p.host && response.endpoint === p.endpoint && response.id === p.id &&
                            response.document === p.document && response.origin === p.origin && response.operation === p.operation &&
                            response.scope === p.scope && response.deadline === p.deadline && Date.now() < p.deadline) {
                            if (response.error) throw new Error(response.error);
                            finish(undefined, response.body); return;
                        }
                    }
                    timer = setTimeout(() => { void poll(); }, 80);
                } catch (error) { finish(error instanceof Error ? error : new Error('The script manager request failed.')); }
            };
            void GM.setValue(request, signed(p, keys)).then(() => {
                if (this.pending.has(p.id)) void poll(); else void GM.deleteValue(request);
            }, error => finish(error instanceof Error ? error : new Error('The script manager could not send the request.')));
        });
    }
    dispose(): void {
        if (!this.live) return;
        for (const item of [...this.pending.values()]) item.cancel();
        if (this.scope && this.route && this.keys) {
            const p: Packet = { host: this.route.host, endpoint: this.endpoint.href, id: uuid(), document: this.document,
                origin: new URL(this.href).origin, operation: 'release', scope: this.scope, deadline: Date.now() + 3000 };
            void GM.setValue(requestPrefix(p.host) + p.id, signed(p, this.keys)).catch(() => {});
        }
        this.live = false;
    }
}
