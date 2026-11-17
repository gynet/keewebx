export const APP_INSTANCE_MARK = 'keewebx-app-instance-v1';
export type AppInstanceState = 'checking' | 'primary' | 'secondary' | 'error';

export function appInstanceLock(base: string, namespace: string): string {
    return `${APP_INSTANCE_MARK}:${new URL('.', base).pathname}:${namespace}`;
}

/** Browser-owned lifetime exclusivity. Silence and elapsed time never transfer ownership. */
export class AppInstance {
    private attempt = 0;
    private controller?: AbortController;
    private release?: () => void;
    private lifetime?: Promise<void>;
    private current: AppInstanceState = 'checking';

    constructor(readonly name: string, private locks: Pick<LockManager, 'request'>,
        private changed: (state: AppInstanceState) => void) {}

    get state(): AppInstanceState { return this.current; }
    get primary(): boolean { return this.current === 'primary' && !!this.controller && !this.controller.signal.aborted && !!this.release; }

    start(): void {
        if (this.controller) return;
        const attempt = ++this.attempt;
        const controller = this.controller = new AbortController();
        this.change('checking');
        const current = () => attempt === this.attempt && !controller.signal.aborted;
        const hold = async () => {
            if (!current()) return;
            const lifetime = this.lifetime = new Promise<void>(resolve => { this.release = resolve; });
            this.change('primary');
            await lifetime;
        };
        const failed = () => {
            if (!current()) return;
            this.controller = undefined;
            this.release = undefined;
            this.change('error');
        };
        // Web Locks forbids combining ifAvailable with an AbortSignal. The
        // immediate attempt is fenced by its epoch; only the queued wait aborts.
        void this.locks.request(this.name, { mode: 'exclusive', ifAvailable: true }, async lock => {
            if (!current()) return;
            if (lock) { await hold(); return; }
            this.change('secondary');
            // A queued exclusive request takes over only when the browser
            // releases the owner. It does not probe or time out the owner.
            void this.locks.request(this.name, { mode: 'exclusive', signal: controller.signal }, async granted => {
                if (granted) await hold();
            }).catch(failed);
        }).catch(failed);
    }

    pageHide(persisted: boolean): void {
        // A cached primary retains its lock. Hidden/paused documents must not
        // be mistaken for closed Apps. Secondary cached pages own no model.
        if (persisted && this.current === 'primary') return;
        this.stop();
    }

    visibility(visible: boolean): void {
        // Background duplicates should not take over while the original tab
        // reloads. A primary keeps ownership regardless of visibility.
        if (this.current === 'primary') return;
        if (visible) this.start(); else this.stop();
    }

    attachClient(clientId: string): void {
        if (!/^[a-zA-Z0-9{}-]{1,128}$/.test(clientId) || this.current !== 'primary' || !this.lifetime || !this.controller) return;
        const attempt = this.attempt, lifetime = this.lifetime;
        // LockInfo.clientId and WindowClient.id are different browser IDs.
        // An auxiliary lifetime lock binds the real WindowClient ID to the
        // same browser context as the primary lock, without a stored owner map.
        void this.locks.request(`${this.name}:client:${encodeURIComponent(clientId)}`, { mode: 'exclusive', ifAvailable: true }, async lock => {
            if (lock && attempt === this.attempt && this.controller && this.current === 'primary') await lifetime;
        }).catch(() => {});
    }

    stop(): void {
        ++this.attempt;
        this.controller?.abort(); this.controller = undefined;
        this.release?.(); this.release = undefined;
        this.lifetime = undefined;
    }

    private change(state: AppInstanceState): void {
        this.current = state;
        this.changed(state);
    }
}
