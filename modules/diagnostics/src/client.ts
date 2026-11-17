import type {
    DiagnosticClientOptions, DiagnosticCode, DiagnosticData, DiagnosticError, DiagnosticEvent,
    DiagnosticResult, DiagnosticSession, DiagnosticState
} from './types';
import { BATCH_SIZE, POLL_MS, SESSION_MS, TIMEOUT_MS, readCommand, readExchange, readSession, sanitizeData, sanitizeEvent } from './schema';

class Failure {
    constructor(readonly code: DiagnosticError | 'aborted') {}
}

interface StoredConsent {
    value: unknown;
    fence?: string;
    changed: boolean;
}

/** Opt-in diagnostics only. Persistence, HTTP and application inspection belong to adapters. */
export class DiagnosticClient {
    private readonly client = globalThis.crypto.randomUUID();
    private readonly options: DiagnosticClientOptions;
    private readonly now: () => number;
    private current: DiagnosticState = { enabled: false, status: 'off' };
    private session?: DiagnosticSession;
    private sessionDeadline = 0;
    private events: DiagnosticEvent[] = [];
    private results: DiagnosticResult[] = [];
    private readonly seen = new Set<string>();
    private readonly deadlines = new Map<string, number>();
    private seq = 0;
    private revision = 0;
    private generation = 0;
    private disposed = false;
    private online = true;
    private poll?: ReturnType<typeof setTimeout>;
    private expiry?: ReturnType<typeof setTimeout>;
    private readonly requests = new Set<AbortController>();
    private creation?: AbortController;
    private exchange?: Promise<void>;
    private enabling?: Promise<void>;
    private storeTail: Promise<unknown> = Promise.resolve();

    constructor(options: DiagnosticClientOptions) {
        if (!options || !['app', 'website'].includes(options.source)
            || typeof options.version !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,63}$/.test(options.version)) {
            throw new TypeError('invalid-options');
        }
        this.options = { ...options };
        this.now = options.now ?? Date.now;
    }

    get state(): DiagnosticState {
        this.checkExpiry();
        return { ...this.current };
    }

    /** Read the shared opt-in; a persisted live session authorizes this document. */
    async refresh(): Promise<void> {
        if (this.disposed) return;
        const revision = ++this.revision;
        this.creation?.abort();
        let consent: StoredConsent;
        try { consent = await this.storeTask(() => this.readConsent()); }
        catch {
            if (this.isRevision(revision)) this.stop('storage');
            return;
        }
        if (!this.isRevision(revision)) return;
        if (consent.changed) { this.stop(); return; }
        const stored = consent.value;
        const session = readSession(stored, this.now());
        if (!session) {
            this.stop(stored === undefined ? undefined : 'expired');
            return;
        }
        this.adopt(session);
        if (this.online) await this.send();
    }

    enable(): Promise<void> {
        if (this.disposed) return Promise.resolve();
        if (this.enabling) return this.enabling;
        const work = this.start();
        this.enabling = work;
        void work.finally(() => { if (this.enabling === work) this.enabling = undefined; });
        return work;
    }

    async disable(): Promise<void> {
        if (this.disposed) return;
        const revision = ++this.revision;
        if (this.session) this.deadlines.set(this.session.id, this.now());
        this.enabling = undefined;
        this.stop();
        try { await this.storeTask(() => this.options.store.save(undefined)); }
        catch { if (this.isRevision(revision)) this.emit({ enabled: false, status: 'off', error: 'storage' }); }
    }

    record(code: DiagnosticCode, data?: DiagnosticData): void {
        if (!this.checkExpiry() || !this.session) return;
        const event = sanitizeEvent(code, data);
        if (!event) return;
        this.events.push({ seq: ++this.seq, at: this.now(), ...event });
        if (this.events.length > BATCH_SIZE) this.events.shift();
    }

    /** Recheck shared consent and perform one exchange, including empty polling exchanges. */
    async flush(): Promise<void> {
        if (!this.checkExpiry() || !this.session) return;
        await this.refresh();
    }

    /** Explicit connectivity avoids navigator/window dependencies. Reconnection retries immediately. */
    setOnline(online: boolean): void {
        if (this.disposed || typeof online !== 'boolean') return;
        this.online = online;
        this.clearPoll();
        if (!online) {
            for (const request of this.requests) request.abort();
            if (this.checkExpiry() && this.session) this.emitSession('offline');
        } else if (this.checkExpiry() && this.session) {
            // Wait for an aborted exchange to settle before reusing its slot.
            void (this.exchange ?? Promise.resolve()).then(() => this.flush());
        }
    }

    /** Local teardown; the shared opt-in remains available to other documents. */
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        ++this.revision;
        this.stop();
    }

    private async start(): Promise<void> {
        const revision = ++this.revision;
        const startedAt = this.now();
        this.creation?.abort();
        if (!this.session) this.emit({ enabled: false, status: 'starting' });
        let consent: StoredConsent;
        try { consent = await this.storeTask(() => this.readConsent()); }
        catch { if (this.isRevision(revision)) this.stop('storage'); return; }
        if (!this.isRevision(revision)) return;
        if (consent.changed) { this.stop(); return; }
        const stored = consent.value;
        const existing = readSession(stored, this.now());
        if (existing && (this.deadlines.get(existing.id) ?? Infinity) > this.now()) {
            this.adopt(existing);
            if (this.online) await this.send();
            return;
        }
        this.stop(undefined, false);
        if (!this.online) { this.emit({ enabled: false, status: 'offline', error: 'network' }); return; }
        this.emit({ enabled: false, status: 'starting' });
        if (!this.isRevision(revision)) return;
        const controller = new AbortController();
        this.creation = controller;
        try {
            const response = await this.run(() => this.options.transport(
                '/api/connect-diagnostics/session', {}, undefined, controller.signal
            ), controller, TIMEOUT_MS);
            if (!this.isRevision(revision)) return;
            const session = readSession(response, this.now(), this.now() + SESSION_MS + 60_000);
            if (!session
                || (this.deadlines.get(session.id) ?? Infinity) <= this.now()) throw new Failure('invalid-response');
            session.expiresAt = Math.min(session.expiresAt, startedAt + SESSION_MS);
            let published: StoredConsent | undefined;
            try {
                await this.storeTask(async () => {
                    if (!this.isRevision(revision)) return;
                    if (await this.readFence() !== consent.fence) return;
                    if (!this.isRevision(revision)) return;
                    await this.options.store.save({ ...session }, consent.fence);
                    published = await this.readConsent();
                });
            } catch { throw new Failure('storage'); }
            if (!this.isRevision(revision)) return;
            const persisted = published && !published.changed && published.fence === consent.fence
                ? readSession(published.value, this.now()) : undefined;
            if (!persisted || persisted.id !== session.id || persisted.token !== session.token) {
                this.stop();
                return;
            }
            session.expiresAt = Math.min(session.expiresAt, persisted.expiresAt);
            if (session.expiresAt <= this.now()) { this.stop('expired'); return; }
            this.adopt(session);
            if (this.online) await this.send();
        } catch (error) {
            if (this.isRevision(revision)) {
                const code = this.errorCode(error);
                if (code) { this.stop(); this.emit({ enabled: false, status: 'offline', error: code }); }
                else if (!this.online) this.emit({ enabled: false, status: 'offline', error: 'network' });
            }
        } finally {
            if (this.creation === controller) this.creation = undefined;
        }
    }

    private adopt(session: DiagnosticSession): void {
        const deadline = Math.min(session.expiresAt, this.deadlines.get(session.id) ?? this.now() + SESSION_MS);
        if (deadline <= this.now() || (!this.deadlines.has(session.id) && this.deadlines.size >= 4096)) {
            this.stop('expired');
            return;
        }
        this.deadlines.set(session.id, deadline);
        session = { ...session, expiresAt: deadline };
        const previous = this.session;
        if (previous?.id === session.id && previous.token === session.token) {
            // Neither server responses nor stale store values can extend this document's opt-in.
            previous.expiresAt = Math.min(previous.expiresAt, session.expiresAt, this.sessionDeadline);
            this.armExpiry();
            return;
        }
        this.stop(undefined, false);
        if (this.disposed) return;
        this.session = { ...session };
        this.sessionDeadline = Math.min(session.expiresAt, this.now() + SESSION_MS);
        this.armExpiry();
        this.record('session.started');
        this.emitSession(this.online ? 'connected' : 'offline');
    }

    private send(): Promise<void> {
        if (this.exchange) return this.exchange;
        if (!this.checkExpiry() || !this.session || !this.online) return Promise.resolve();
        const work = this.performExchange(this.session, this.generation);
        this.exchange = work;
        void work.finally(() => {
            if (this.exchange !== work) return;
            this.exchange = undefined;
            this.schedule();
        });
        return work;
    }

    private async performExchange(session: DiagnosticSession, generation: number): Promise<void> {
        this.clearPoll();
        const results = this.results.splice(0, BATCH_SIZE);
        const events = this.events.splice(0, BATCH_SIZE - results.length);
        const controller = new AbortController();
        this.emitSession('sending');
        if (!this.live(session, generation) || !this.online) return;
        let acknowledged = false;
        try {
            const raw = await this.run(() => this.options.transport(
                `/api/connect-diagnostics/${session.id}/exchange`,
                { client: this.client, source: this.options.source, version: this.options.version, events, results },
                session.token, controller.signal
            ), controller, TIMEOUT_MS);
            if (!this.live(session, generation) || !this.online) return;
            const response = readExchange(raw);
            if (!response) throw new Failure('invalid-response');
            acknowledged = true;
            session.expiresAt = Math.min(session.expiresAt, response.expiresAt, this.sessionDeadline);
            if (!this.checkExpiry()) return;
            this.armExpiry();
            this.emitSession('connected');
            for (const value of response.commands) {
                if (!this.live(session, generation) || !this.online) return;
                const command = readCommand(value, this.client, this.now());
                const key = command && `${session.id}:${command.id}`;
                // Never evict IDs: duplicates must remain inert throughout the session.
                if (!command || !key || this.seen.has(key) || this.seen.size >= 4096 || this.results.length >= BATCH_SIZE) continue;
                this.seen.add(key);
                const callback = new AbortController();
                let result: DiagnosticResult;
                try {
                    const data = await this.run(() => {
                        if (!this.live(session, generation) || !this.online) throw new Failure('aborted');
                        if (command.expiresAt <= this.now()) throw new Failure('timeout');
                        return this.options.snapshot(command.kind);
                    }, callback,
                        Math.min(TIMEOUT_MS, command.expiresAt - this.now(), session.expiresAt - this.now()));
                    result = { id: command.id, kind: command.kind, status: 'ok', data: sanitizeData(data) };
                } catch (error) {
                    result = { id: command.id, kind: command.kind, status: 'failed',
                        data: { reason: error instanceof Failure && error.code === 'timeout' ? 'timeout' : 'other' } };
                }
                if (!this.live(session, generation) || !this.online) return;
                if (this.results.length < BATCH_SIZE) this.results.push(result);
            }
        } catch (error) {
            if (!this.live(session, generation)) return;
            const code = this.errorCode(error);
            if (code) this.emitSession('offline', code);
        } finally {
            if (!acknowledged && this.live(session, generation)) {
                this.events = [...events, ...this.events].slice(-BATCH_SIZE);
                this.results = [...results, ...this.results].slice(-BATCH_SIZE);
            }
        }
    }

    /** Races both abort and deadline even if an adapter/callback ignores cancellation. */
    private run<T>(task: () => T | Promise<T>, controller: AbortController, timeout: number): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            let settled = false;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const finish = (error: unknown, value?: T) => {
                if (settled) return;
                settled = true;
                if (timer !== undefined) clearTimeout(timer);
                controller.signal.removeEventListener('abort', aborted);
                this.requests.delete(controller);
                if (error !== undefined) reject(error); else resolve(value as T);
            };
            const aborted = () => finish(new Failure('aborted'));
            if (controller.signal.aborted || this.disposed) { aborted(); return; }
            this.requests.add(controller);
            controller.signal.addEventListener('abort', aborted, { once: true });
            timer = setTimeout(() => {
                finish(new Failure('timeout'));
                controller.abort();
            }, Math.max(0, timeout));
            Promise.resolve().then(() => {
                if (controller.signal.aborted || this.disposed) throw new Failure('aborted');
                return task();
            }).then(value => finish(undefined, value), error => finish(error ?? new Failure('network')));
        });
    }

    private storeTask<T>(task: () => Promise<T>): Promise<T> {
        const work = this.storeTail.then(task);
        this.storeTail = work.catch(() => undefined);
        return work;
    }

    private async readFence(): Promise<string | undefined> {
        if (!this.options.store.revision) return undefined;
        const fence = await this.options.store.revision();
        if (typeof fence !== 'string' || fence.length > 256) throw new Failure('storage');
        return fence;
    }

    private async readConsent(): Promise<StoredConsent> {
        const before = await this.readFence();
        const value = await this.options.store.load();
        const fence = await this.readFence();
        return { value, fence, changed: before !== fence };
    }

    private isRevision(revision: number): boolean { return !this.disposed && this.revision === revision; }

    private live(session: DiagnosticSession, generation: number): boolean {
        return this.checkExpiry() && this.session === session && this.generation === generation;
    }

    private checkExpiry(): boolean {
        if (this.disposed) return false;
        if (this.session && this.now() >= this.session.expiresAt) this.stop('expired');
        return !!this.session;
    }

    private armExpiry(): void {
        if (this.expiry !== undefined) clearTimeout(this.expiry);
        if (!this.session) return;
        this.deadlines.set(this.session.id, this.session.expiresAt);
        this.expiry = setTimeout(() => {
            if (this.checkExpiry()) this.armExpiry();
        }, Math.max(0, this.session.expiresAt - this.now()));
    }

    private schedule(): void {
        this.clearPoll();
        if (!this.checkExpiry() || !this.online || this.current.status !== 'connected') return;
        this.poll = setTimeout(() => { this.poll = undefined; void this.refresh(); }, POLL_MS);
    }

    private clearPoll(): void {
        if (this.poll !== undefined) clearTimeout(this.poll);
        this.poll = undefined;
    }

    private stop(error?: DiagnosticError, notify = true): void {
        ++this.generation;
        this.session = undefined;
        this.sessionDeadline = 0;
        this.clearPoll();
        if (this.expiry !== undefined) clearTimeout(this.expiry);
        this.expiry = undefined;
        for (const request of this.requests) request.abort();
        this.creation = undefined;
        this.events = [];
        this.results = [];
        // Old work has been aborted; its generation guards prevent late results being reused.
        this.exchange = undefined;
        const state: DiagnosticState = { enabled: false, status: 'off', ...(error ? { error } : {}) };
        if (notify) this.emit(state); else this.current = state;
    }

    private emitSession(status: DiagnosticState['status'], error?: DiagnosticError): void {
        if (!this.session || !this.checkExpiry()) return;
        this.emit({ enabled: true, id: this.session.id, expiresAt: this.session.expiresAt, status, ...(error ? { error } : {}) });
    }

    private emit(state: DiagnosticState): void {
        this.current = state;
        if (this.disposed) return;
        try { this.options.onChange({ ...state }); } catch { /* Observer failures cannot affect consent. */ }
    }

    private errorCode(error: unknown): DiagnosticError | undefined {
        if (error instanceof Failure) return error.code === 'aborted' ? undefined : error.code;
        return 'network';
    }
}
