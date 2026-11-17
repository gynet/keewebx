import { watchManagerStorage } from './manager-events';
import { transportEvent } from './transport-events';

declare const GM: { getValue(key: string): Promise<any>; setValue(key: string, value: any): Promise<void>; deleteValue(key: string): Promise<void>; listValues?(): Promise<string[]> };
const ROOT = 'keewebx-connect-mailbox-v1:';
const WAKE_KEY = 'keewebx-connect-mailbox-wake-v1';
const WAKE_CHECK_MS = 1500;
const key = (kind: string, host: string, id: string) => `${ROOT}${kind}:${host}:${id}`;
const discard = (name: string) => { void Promise.resolve().then(() => GM.deleteValue(name)).catch(() => {}); };
const bounded = <T>(operation: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Userscripts storage did not respond.')), 5000);
    Promise.resolve().then(operation).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
// A timeout does not cancel the underlying manager operation. Cleanup must run
// when that operation actually settles, even after its caller has canceled.
const write = (name: string, value: any, current: () => boolean = () => true) => bounded(async () => {
    if (!current() || value.packet.deadline <= Date.now()) return;
    await GM.setValue(name, value);
    if (!current() || value.packet.deadline <= Date.now()) discard(name);
});

function signal(value: any): void {
    const { host, id, deadline } = value.packet;
    if (deadline <= Date.now()) return;
    // A single local hint lets the App recover a missed storage notification.
    // The signed mailbox request still controls every operation.
    void bounded(() => GM.setValue(WAKE_KEY, { host, id, deadline })).then(
        () => transportEvent({ event: 'mailbox-signal', traceId: id }),
        () => transportEvent({ event: 'mailbox-signal', traceId: id, reason: 'unavailable' })
    );
}
function batch(names: string[], after: string, limit: number): string[] {
    names.sort();
    const found = names.findIndex(name => name > after), start = found < 0 ? 0 : found;
    return [...names.slice(start), ...names.slice(0, start)].slice(0, limit);
}

/** A window-independent fallback. Only signed, encrypted Connect envelopes enter it. */
export class ConnectMailbox {
    private live = false;
    private busy = false;
    private wakePending = false;
    private generation = 0;
    private requestCursor = '';
    private cleanupCursor = '';
    private pollIdle = true;
    private timer?: ReturnType<typeof setTimeout>;
    private wakeTimer?: ReturnType<typeof setTimeout>;
    private lastSignal?: string;
    private unwatch?: () => void;
    constructor(private host: string, private deliver: (value: any, reply: (value: any) => Promise<void>) => Promise<void>, private failed: (error: Error) => void) {}
    get available(): boolean { return typeof GM.listValues === 'function'; }
    start(pollIdle = true, checkMissedEvents = false): void {
        if (this.live || !this.available) return;
        this.pollIdle = pollIdle;
        this.live = true; this.generation++;
        this.unwatch = watchManagerStorage([`${ROOT}request:${this.host}:`], () => {
            transportEvent({ event: 'mailbox-notified' });
            this.wake();
        }, true);
        addEventListener('focus', this.wake); addEventListener('pageshow', this.wake); addEventListener('visibilitychange', this.wake);
        this.wake();
        if (checkMissedEvents) this.scheduleWakeCheck(this.generation);
    }
    stop(): void {
        this.live = false; this.generation++; this.busy = false; this.wakePending = false;
        clearTimeout(this.timer); clearTimeout(this.wakeTimer); this.lastSignal = undefined;
        this.unwatch?.(); this.unwatch = undefined;
        removeEventListener('focus', this.wake); removeEventListener('pageshow', this.wake); removeEventListener('visibilitychange', this.wake);
    }
    private scheduleWakeCheck(generation: number): void {
        this.wakeTimer = setTimeout(async () => {
            const current = () => this.live && generation === this.generation;
            try {
                const hint = await bounded(() => GM.getValue(WAKE_KEY));
                if (current() && hint?.host === this.host && typeof hint.id === 'string' && hint.id !== this.lastSignal &&
                    Number.isFinite(hint.deadline) && hint.deadline > Date.now()) {
                    this.lastSignal = hint.id;
                    transportEvent({ event: 'mailbox-signal-read', traceId: hint.id });
                    this.wake();
                }
            } catch { if (current()) transportEvent({ event: 'mailbox-read-failed', reason: 'unavailable' }); }
            finally { if (current()) this.scheduleWakeCheck(generation); }
        }, WAKE_CHECK_MS);
    }
    private wake = () => {
        if (!this.live) return;
        if (this.busy) { this.wakePending = true; return; }
        clearTimeout(this.timer); void this.read();
    };
    private async read(): Promise<void> {
        this.busy = true;
        this.wakePending = false;
        let pendingRequests = false;
        const generation = this.generation, current = () => this.live && generation === this.generation;
        try {
            const names = await bounded(() => GM.listValues!());
            if (!current()) return;
            const requestPrefix = `${ROOT}request:${this.host}:`;
            // Replies and undeletable records must not starve newer requests.
            for (const name of batch(names.filter(name => name.startsWith(requestPrefix)), this.requestCursor, 128)) {
                if (!current()) return;
                this.requestCursor = name;
                const value = await bounded(() => GM.getValue(name)), p = value?.packet;
                if (!current()) return;
                if (!p || !Number.isFinite(p.deadline) || p.deadline <= Date.now() || p.deadline > Date.now() + 66000) { discard(name); continue; }
                if (name !== key('request', this.host, p.id) || p.host !== this.host) continue;
                pendingRequests = true;
                discard(name);
                // Admission, signatures, replay and session checks stay in NativeHost.
                transportEvent({ event: 'mailbox-request', traceId: p.id });
                void this.deliver(value, async reply => {
                    await write(key('reply', this.host, p.id), reply, current);
                    if (current()) transportEvent({ event: 'mailbox-reply', traceId: p.id });
                }).catch(error => {
                    if (current()) this.failed(error instanceof Error ? error : new Error('Connect request failed.'));
                });
            }
            // Also expire abandoned records from previous app documents. Never
            // remove identity, settings or an unexpired request for another host.
            for (const name of batch(names.filter(name => name.startsWith(ROOT) && !name.startsWith(requestPrefix)), this.cleanupCursor, 32)) {
                if (!current()) return;
                this.cleanupCursor = name;
                const value = await bounded(() => GM.getValue(name)), deadline = value?.packet?.deadline;
                if (!current()) return;
                if (!Number.isFinite(deadline) || deadline <= Date.now() || deadline > Date.now() + 66000) discard(name);
            }
        } catch (error) { if (current()) {
            transportEvent({ event: 'mailbox-read-failed', reason: 'unavailable' });
            this.failed(error instanceof Error ? error : new Error('Userscripts storage is unavailable.'));
        } }
        finally {
            if (current()) {
                this.busy = false;
                // A storage notification can arrive after the current scan
                // took its snapshot. Drain it before returning to idle.
                if (this.wakePending) this.timer = setTimeout(this.wake, 0);
                else if (this.pollIdle || pendingRequests) this.timer = setTimeout(this.wake, 150);
            }
        }
    }
}

/** Completion and cancellation always stop the reader, even if cleanup fails. */
export function mailboxRequest(value: any, reply: (value: any) => void, failed: (error: Error) => void): () => void {
    const p = value.packet, requestKey = key('request', p.host, p.id), replyKey = key('reply', p.host, p.id);
    let active = true, reading = false, timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
        if (!active || reading) return;
        reading = true;
        try { const result = await bounded(() => GM.getValue(replyKey)); if (active && result) reply(result); }
        catch (error) { if (active) failed(error instanceof Error ? error : new Error('Userscripts storage is unavailable.')); }
        finally { reading = false; if (active) timer = setTimeout(read, 100); }
    };
    const unwatch = watchManagerStorage([replyKey], () => { clearTimeout(timer); void read(); });
    void write(requestKey, value, () => active).then(() => {
        if (active) { signal(value); void read(); } else discard(requestKey);
    }, error => { if (active) failed(error instanceof Error ? error : new Error('Could not send the Connect request.')); });
    return () => { active = false; clearTimeout(timer); unwatch(); discard(requestKey); discard(replyKey); };
}
export function mailboxRelease(value: any): void {
    const name = key('request', value.packet.host, value.packet.id);
    void write(name, value).then(() => {
        signal(value);
        setTimeout(() => discard(name), Math.max(0, value.packet.deadline - Date.now()));
    }, () => {});
}
