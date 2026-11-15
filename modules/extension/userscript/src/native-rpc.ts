export const APP_ORIGIN = 'https://keewebx.app';
export const MARK = 'keewebx-userscript-connect-v1';
export const RPC_TIMEOUT = 65000;
export const SESSION_TTL = 120000;
export const uuid = () => crypto.randomUUID();
export const object = (value: unknown): value is Record<string, any> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
export const isId = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);

export interface Envelope {
    marker: typeof MARK;
    direction: 'request' | 'response' | 'notice';
    id: string;
    document: string;
    operation: 'cancel' | 'hello' | 'wire' | 'probe' | 'release';
    scope?: string;
    sentAt: number;
    deadline: number;
    body?: any;
    error?: string;
}

export function validEnvelope(data: unknown): data is Envelope {
    return object(data) && data.marker === MARK && isId(data.id) && isId(data.document) &&
        ['cancel', 'hello', 'wire', 'probe', 'release'].includes(data.operation) &&
        Number.isFinite(data.sentAt) && Number.isFinite(data.deadline) &&
        data.deadline > data.sentAt && data.deadline - data.sentAt <= RPC_TIMEOUT &&
        data.sentAt <= Date.now() + 1000;
}

/** One document's native Window.postMessage client. No polling, globals or page RPC. */
export class NativeRpc {
    readonly document = uuid();
    readonly href = location.href;
    scope?: string;
    appBoot?: string;
    expiresAt = 0;
    private live = true;
    private pending = new Map<string, { request: Envelope; resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; retry?: ReturnType<typeof setInterval> }>();

    constructor(private original: Window, private notice: (message: string, locked?: boolean) => void = () => {}, private appOrigin = APP_ORIGIN) {
        addEventListener('message', this.receive);
    }

    assertCurrent(): void {
        if (!this.live || location.href !== this.href || this.original.closed) {
            throw new Error('The page or window connection changed. Select the login field and connect again.');
        }
        if (this.scope && Date.now() >= this.expiresAt) throw new Error('The account list expired. Find accounts again.');
    }

    private receive = (event: MessageEvent) => {
        if (!this.live || !event.isTrusted || event.source !== this.original || event.origin !== this.appOrigin || !validEnvelope(event.data)) return;
        const data = event.data;
        if (data.document !== this.document) return;
        if (data.direction === 'notice') {
            if (this.scope && data.scope === this.scope && Date.now() < data.deadline && location.href === this.href) {
                const locked = data.body?.kind === 'locked';
                if (locked) this.dispose('KeeWebX is locked.');
                this.notice(locked ? 'KeeWebX is locked. The account list has been cleared.' : 'Approve the connection or unlock the database in KeeWebX.', locked);
            }
            return;
        }
        if (data.direction !== 'response') return;
        const pending = this.pending.get(data.id);
        if (!pending || data.operation !== pending.request.operation || data.deadline !== pending.request.deadline ||
            data.sentAt !== pending.request.sentAt || data.scope !== pending.request.scope) return;
        this.pending.delete(data.id);
        clearTimeout(pending.timer);
        if (pending.retry) clearInterval(pending.retry);
        try {
            this.assertCurrent();
            if (Date.now() >= pending.request.deadline) throw new Error('The connection request timed out. Try again.');
            if (data.error) throw new Error(String(data.error));
            pending.resolve(data.body);
        } catch (error) { pending.reject(error as Error); }
    };

    call(operation: Envelope['operation'], body?: any, timeout = RPC_TIMEOUT): Promise<any> {
        this.assertCurrent();
        const sentAt = Date.now();
        const deadline = Math.min(sentAt + timeout, this.scope ? this.expiresAt : Infinity);
        if (deadline <= sentAt) return Promise.reject(new Error('The connection expired. Find accounts again.'));
        const request: Envelope = { marker: MARK, direction: 'request', id: uuid(), document: this.document,
            operation, scope: this.scope, sentAt, deadline, body };
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const pending = this.pending.get(request.id);
                if (pending?.retry) clearInterval(pending.retry);
                this.pending.delete(request.id);
                reject(new Error('KeeWebX did not reply in time. No tab switch was requested.'));
                this.dispose();
            }, deadline - sentAt);
            const pending = { request, resolve, reject, timer } as { request: Envelope; resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout>; retry?: ReturnType<typeof setInterval> };
            this.pending.set(request.id, pending);
            this.original.postMessage(request, this.appOrigin);
            // Only initial page readiness is retried; no idle/background heartbeat.
            // The app treats duplicate hello IDs idempotently.
            if (operation === 'hello' || operation === 'cancel') pending.retry = setInterval(() => {
                if (this.pending.get(request.id) === pending && Date.now() < deadline && location.href === this.href) {
                    this.original.postMessage(request, this.appOrigin);
                }
            }, 400);
        });
    }

    async connect(): Promise<void> {
        await this.call('cancel', undefined, 8000);
        const result = await this.call('hello', undefined, 8000);
        if (!object(result) || !isId(result.scope) || !isId(result.appBoot) ||
            !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now() ||
            result.expiresAt > Date.now() + SESSION_TTL + 1000) throw new Error('KeeWebX returned an invalid connection response.');
        this.scope = result.scope;
        this.appBoot = result.appBoot;
        this.expiresAt = result.expiresAt;
    }

    dispose(reason = 'The connection has ended.'): void {
        if (!this.live) return;
        this.live = false;
        removeEventListener('message', this.receive);
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            if (pending.retry) clearInterval(pending.retry);
            pending.reject(new Error(reason));
        }
        this.pending.clear();
        if (this.scope && !this.original.closed) {
            const sentAt = Date.now();
            this.original.postMessage({ marker: MARK, direction: 'request', id: uuid(), document: this.document,
                operation: 'release', scope: this.scope, sentAt, deadline: sentAt + 2000 } satisfies Envelope, this.appOrigin);
        }
    }
}
