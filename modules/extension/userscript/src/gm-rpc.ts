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
    getTab?: () => Promise<Record<string, any> | null>;
    saveTab?: (value: Record<string, any>) => Promise<void>;
};
type Keys = { publicKey: Uint8Array; secretKey: Uint8Array };
type Route = { host: string; endpoint: string; publicKey: string; format?: string };
type Packet = { host: string; endpoint: string; id: string; document: string; origin: string;
    operation: 'hello' | 'wire' | 'probe' | 'focus' | 'release'; deadline: number; scope?: string; body?: any; error?: string };
type Signed = { packet: Packet; signature: string };
const ROOT = 'keewebx-userscript-connect-';
const requestPrefix = (host: string) => `${ROOT}request-v2:${host}:`;
const replyKey = (host: string, id: string) => `${ROOT}reply-v2:${host}:${id}`;
const routeKey = (endpoint: URL) => `${ROOT}route-v2:${endpoint.href}`;
// Safari's native storage bridge can reorder dictionary keys. Sign values,
// not the enumeration order returned by a particular storage implementation.
const canonical = (value: any): any => Array.isArray(value) ? value.map(canonical) : object(value)
    ? Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, canonical(value[key])])) : value;
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(canonical(value)));
export function managerCall<T>(operation: () => Promise<T>, description = 'Userscripts storage', timeout = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${description} did not respond. Open the Userscripts extension and retry.`)), timeout);
        Promise.resolve().then(operation).then(value => { clearTimeout(timer); resolve(value); }, error => {
            clearTimeout(timer); reject(error instanceof Error ? error : new Error(`${description} failed.`));
        });
    });
}
const signed = (packet: Packet, keys: Keys): Signed => {
    const value = canonical(JSON.parse(JSON.stringify(packet))) as Packet;
    return { packet: value, signature: toBase64(sign.detached(bytes(value), keys.secretKey)) };
};
const verified = (value: unknown, key: Uint8Array, legacy = false): value is Signed => {
    if (!object(value) || !object(value.packet) || typeof value.signature !== 'string') return false;
    try {
        const signature = fromBase64(value.signature);
        return sign.detached.verify(bytes(value.packet), signature, key) ||
            legacy && sign.detached.verify(new TextEncoder().encode(JSON.stringify(value.packet)), signature, key);
    } catch { return false; }
};
export async function approvedRoute(endpoint: URL): Promise<Route | undefined> {
    const value = await managerCall(() => GM.getValue(routeKey(endpoint)));
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
    constructor(private endpoint: URL, private onError: (error: Error) => void = () => {}) { this.idPromise = this.tabId(); }

    private async tabId(): Promise<string> {
        const key = `${ROOT}host-v2:${this.endpoint.href}`;
        let saved: string | null = null;
        try { saved = sessionStorage.getItem(key); } catch {}
        const remember = (id: string) => { try { sessionStorage.setItem(key, id); } catch {} return id; };
        if (GM.getTab && GM.saveTab) {
            try {
                const state = await managerCall(() => GM.getTab!(), 'Userscripts tab state', 1200);
                const tab = object(state) ? state : {};
                if (!isId(tab[key])) {
                    tab[key] = isId(saved) ? saved : uuid();
                    // Retain the same identity even if saveTab fails or times out.
                    saved = remember(tab[key]);
                    await managerCall(() => GM.saveTab!(tab), 'Userscripts tab state', 1200);
                }
                return remember(tab[key]);
            } catch { /* Older managers can use the tab's session storage instead. */ }
        }
        return remember(isId(saved) ? saved! : uuid());
    }

    async selected(): Promise<boolean> {
        const route = await approvedRoute(this.endpoint);
        return !route || route.host === await this.idPromise;
    }
    async authorize(keys: Keys): Promise<void> {
        const host = await this.idPromise;
        if (typeof GM.listValues !== 'function' || typeof GM.deleteValue !== 'function') throw new Error('Update or reinstall this Connect script so Userscripts grants its storage permissions.');
        await managerCall(() => GM.listValues(), 'Userscripts request queue');
        this.keys = keys;
        await managerCall(() => GM.setValue(routeKey(this.endpoint), { host, endpoint: this.endpoint.href, publicKey: toBase64(keys.publicKey), format: 'canonical-1' } satisfies Route));
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
            const keys = await managerCall(() => GM.listValues(), 'Userscripts request queue');
            if (!this.live) return;
            for (const key of keys) {
                if (key.startsWith(requestPrefix(host)) && !this.processing.has(key)) {
                    this.processing.add(key); this.activeUntil = now + 5000;
                    void this.handle(key, host).finally(() => this.processing.delete(key));
                } else if (key.startsWith(`${ROOT}reply-v2:${host}:`)) {
                    const value = await managerCall(() => GM.getValue(key));
                    if (!Number.isFinite(value?.packet?.deadline) || value.packet.deadline <= now) await managerCall(() => GM.deleteValue(key));
                }
            }
        } catch (error) { if (this.live) this.onError(error instanceof Error ? error : new Error('Userscripts storage failed.')); }
        finally {
            this.polling = false;
            if (this.live) this.timer = setTimeout(() => { void this.poll(); }, Date.now() < this.activeUntil ? 60 : 500);
        }
    }

    private async handle(key: string, host: string): Promise<void> {
        try {
            const value = await managerCall(() => GM.getValue(key));
            await managerCall(() => GM.deleteValue(key));
            const keys = this.keys;
            if (!this.live || !keys || !verified(value, keys.publicKey)) return;
            const p = value.packet;
            if (p.host !== host || p.endpoint !== this.endpoint.href || key !== requestPrefix(host) + p.id ||
                !isId(p.id) || !isId(p.document) || !/^https:\/\/[^/]+$/.test(p.origin) ||
                !Number.isFinite(p.deadline) || p.deadline <= Date.now() || p.deadline > Date.now() + 66000 ||
                !['hello', 'wire', 'probe', 'focus', 'release'].includes(p.operation)) return;
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
                    if (p.operation === 'probe' || p.operation === 'focus') {
                        if (p.operation === 'focus') window.focus();
                        body = { visibility: document.visibilityState, appBoot: host };
                    }
                    else {
                        if (session.locked) throw new Error('KeeWebX is locked. Unlock the existing app tab and find accounts again.');
                        body = await session.bridge.request(p.body, Math.min(p.deadline, session.expiresAt));
                    }
                    if (this.sessions.get(p.document) !== session) return;
                }
            } catch (reason) { error = reason instanceof Error ? reason.message : 'The KeeWebX request failed.'; }
            if (this.live && this.keys === keys && Date.now() < p.deadline) {
                await managerCall(() => GM.setValue(replyKey(host, p.id), signed({ ...p, body, error }, keys)));
            }
        } catch (error) { if (this.live) this.onError(error instanceof Error ? error : new Error('Userscripts could not process the request.')); }
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
        this.keys = await managerCall(() => identity()); this.assertCurrent();
        this.route = await approvedRoute(this.endpoint); this.assertCurrent();
        if (!this.route || this.route.publicKey !== toBase64(this.keys.publicKey)) throw new Error('Authorize Connect once in your KeeWebX tab. Then all websites can use it.');
        // A stored version flag is advisory. Only a signed live handshake can
        // establish compatibility; old metadata must not force a reload loop.
        const result = await this.call('hello', undefined, 8000);
        if (!object(result) || !isId(result.scope) || result.appBoot !== this.route.host ||
            !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now() || result.expiresAt > Date.now() + SESSION_TTL + 1000) throw new Error('Invalid KeeWebX connection response.');
        this.scope = result.scope; this.expiresAt = result.expiresAt;
    }
    async call(operation: Packet['operation'], body?: any, timeout = 15000): Promise<any> {
        await this.assertSelected();
        const route = this.route, keys = this.keys;
        if (!route || !keys) throw new Error('Connect to your authorized KeeWebX tab first.');
        // 0.4.0 supports probing but not focus. Never navigate an existing app.
        if (operation === 'focus' && route.format !== 'canonical-1') operation = 'probe';
        const p: Packet = { host: route.host, endpoint: this.endpoint.href, id: uuid(), document: this.document,
            origin: location.origin, operation, scope: this.scope, deadline: Math.min(Date.now() + timeout, this.scope ? this.expiresAt : Infinity), body };
        const request = requestPrefix(route.host) + p.id, reply = replyKey(route.host, p.id);
        return new Promise((resolve, reject) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            let watchdog: ReturnType<typeof setTimeout> | undefined;
            let checkRouteAt = Date.now() + 500;
            const finish = (error?: Error, result?: any) => {
                if (!this.pending.delete(p.id)) return;
                clearTimeout(timer);
                clearTimeout(watchdog);
                void Promise.allSettled([GM.deleteValue(request), GM.deleteValue(reply)]);
                if (error) reject(error); else resolve(result);
            };
            this.pending.set(p.id, { request, reply, cancel: () => finish(new Error('The website operation was canceled.')) });
            // This must remain independent of a manager API promise that never settles.
            watchdog = setTimeout(() => finish(new Error('The authorized KeeWebX tab did not reply. Keep that tab unlocked and retry.')), Math.max(1, p.deadline - Date.now()));
            const poll = async () => {
                try {
                    this.assertCurrent();
                    if (Date.now() >= p.deadline) throw new Error('The authorized KeeWebX tab did not reply. Resume that tab and try again.');
                    if (Date.now() >= checkRouteAt) { await this.assertSelected(); checkRouteAt = Date.now() + 500; }
                    const result = await GM.getValue(reply);
                    this.assertCurrent();
                    if (!this.pending.has(p.id)) return;
                    if (verified(result, keys.publicKey, route.format !== 'canonical-1')) {
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
