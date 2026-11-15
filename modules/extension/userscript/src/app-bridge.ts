import { APP_ORIGIN, MARK, SESSION_TTL, object, uuid, validEnvelope, type Envelope } from './native-rpc';

const ACTIONS = new Set(['ping', 'change-public-keys', 'kwx-pair', 'kwx-features', 'kwx-get-entries', 'kwx-get-entry-fields']);

export interface ConnectBridge {
    request(request: any, deadline?: number): Promise<any>;
    reset(reason?: string): void;
    dispose(): void;
    onAttention: () => void;
    onLocked: () => void;
}

/** Same-window adapter to the application's existing, encrypted Connect endpoint. */
export class AppBridge {
    private live = true;
    private port = uuid();
    private pending?: { request: any; deadline: number; resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
    onAttention = () => {};
    onLocked = () => {};
    constructor(private origin = location.origin) { addEventListener('message', this.receive); }

    private receive = (event: MessageEvent) => {
        if (!event.isTrusted || event.source !== window || event.origin !== this.origin || !object(event.data) ||
            event.data.kwConnect !== 'response' || event.data.kwConnection !== this.port) return;
        const response = event.data;
        if (response.action === 'attention-required') { this.onAttention(); return; }
        if (response.action === 'database-locked') { this.onLocked(); this.reset('KeeWebX is locked.'); return; }
        if (response.action === 'database-unlocked') return;
        const pending = this.pending;
        if (!pending) return;
        const matches = pending.request.action === 'ping'
            ? response.data === pending.request.data || response.action === 'ping'
            : response.action === pending.request.action;
        if (!matches) return;
        if (Date.now() >= pending.deadline) { this.reset('The KeeWebX request expired.'); return; }
        this.pending = undefined;
        clearTimeout(pending.timer);
        const { kwConnect, kwConnection, ...wire } = response;
        pending.resolve(wire);
    };

    request(request: any, deadline = Date.now() + 65000): Promise<any> {
        if (!this.live) return Promise.reject(new Error('The connection is closed.'));
        if (!object(request) || !ACTIONS.has(request.action) || JSON.stringify(request).length > 262144) return Promise.reject(new Error('Unsupported Connect request.'));
        if (this.pending) return Promise.reject(new Error('KeeWebX is processing another request.'));
        if (deadline <= Date.now()) return Promise.reject(new Error('The request expired.'));
        return new Promise((resolve, reject) => {
            const pending = { request, deadline, resolve, reject, timer: undefined as unknown as ReturnType<typeof setTimeout> };
            pending.timer = setTimeout(() => { if (this.pending === pending) this.reset('The KeeWebX Connect request timed out.'); }, deadline - Date.now());
            this.pending = pending;
            window.postMessage({ ...request, kwConnect: 'request', kwConnection: this.port }, this.origin);
        });
    }

    reset(reason = 'The connection was reset.'): void {
        if (!this.live) return;
        // Matching disconnection cancels an old app prompt and advances the app's
        // transport generation before a new owner/handshake can be admitted.
        window.postMessage({ kwConnect: 'disconnected', kwConnection: this.port }, this.origin);
        this.port = uuid();
        const pending = this.pending;
        this.pending = undefined;
        if (pending) {
            clearTimeout(pending.timer);
            pending.reject(new Error(reason));
        }
    }

    dispose(): void { this.reset(); this.live = false; removeEventListener('message', this.receive); }
}

export class AppBroker {
    readonly appBoot = uuid();
    child?: Window;
    private childOrigin?: string;
    authorizing = false;
    private canceled = new Set<string>();
    private owner?: { hello: string; document: string; origin: string; scope: string; expiresAt: number };
    constructor(readonly bridge: ConnectBridge) {
        addEventListener('message', this.receive);
        const notice = (kind: string) => {
            if (!this.child || !this.owner) return;
            const now = Date.now();
            this.child.postMessage({ marker: MARK, direction: 'notice', id: uuid(), document: this.owner.document,
                operation: 'wire', scope: this.owner.scope, sentAt: now, deadline: now + 5000, body: { kind } }, this.owner.origin);
        };
        bridge.onAttention = () => notice('attention');
        bridge.onLocked = () => { notice('locked'); this.owner = undefined; };
    }

    associate(child: Window, origin?: string): void { this.clear(); this.child = child; this.childOrigin = origin; }
    clear(): void { this.owner = undefined; this.bridge.reset(); }
    revoke(): void { this.clear(); this.child = undefined; }
    private reply(event: MessageEvent, request: Envelope, body?: any, error?: string): void {
        if (Date.now() >= request.deadline) return;
        (event.source as Window).postMessage({ ...request, direction: 'response', body, error }, event.origin);
    }

    private receive = async (event: MessageEvent) => {
        if (!event.isTrusted || event.source === window || event.source !== this.child || (this.childOrigin && event.origin !== this.childOrigin) || !/^https:\/\/[^/]+$/.test(event.origin) ||
            !validEnvelope(event.data) || event.data.direction !== 'request') return;
        const request = event.data;
        if (Date.now() >= request.deadline) return;
        try {
            if (this.authorizing) throw new Error('Complete the current authorization in KeeWebX first.');
            if (request.operation === 'cancel') {
                if (!this.canceled.has(request.id)) {
                    this.canceled.add(request.id);
                    if (this.canceled.size > 64) this.canceled.delete(this.canceled.values().next().value!);
                    this.clear();
                }
                this.reply(event, request, { canceled: true });
                return;
            }
            if (request.operation === 'hello') {
                let owner = this.owner;
                if (!owner || owner.hello !== request.id || owner.document !== request.document || owner.origin !== event.origin || Date.now() >= owner.expiresAt) {
                    if (owner && Date.now() < owner.expiresAt) throw new Error('An account selection is already in progress. Cancel the existing connection first.');
                    this.clear();
                    owner = { hello: request.id, document: request.document, origin: event.origin, scope: uuid(), expiresAt: Date.now() + SESSION_TTL };
                    this.owner = owner;
                }
                this.reply(event, request, { scope: owner.scope, appBoot: this.appBoot, expiresAt: owner.expiresAt });
                return;
            }
            const owner = this.owner;
            if (!owner || owner.document !== request.document || owner.origin !== event.origin || owner.scope !== request.scope) {
                throw new Error('The link is no longer valid. Connect again.');
            }
            if (Date.now() >= owner.expiresAt || request.deadline > owner.expiresAt) {
                this.clear(); throw new Error('The account list expired. Find accounts again.');
            }
            if (request.operation === 'release') { this.clear(); return; }
            if (request.operation === 'probe') {
                this.reply(event, request, { visibility: document.visibilityState, appBoot: this.appBoot }); return;
            }
            if (request.operation !== 'wire') throw new Error('Unsupported request.');
            const response = await this.bridge.request(request.body, request.deadline);
            if (this.owner !== owner || Date.now() >= owner.expiresAt || Date.now() >= request.deadline) return;
            this.reply(event, request, response);
        } catch (error) {
            this.reply(event, request, undefined, error instanceof Error ? error.message : 'Connection failed.');
        }
    };

    dispose(): void { this.revoke(); this.bridge.onAttention = () => {}; this.bridge.onLocked = () => {}; removeEventListener('message', this.receive); }
}
