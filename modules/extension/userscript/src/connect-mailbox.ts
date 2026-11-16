import { watchManagerStorage } from './manager-events';

declare const GM: { getValue(key: string): Promise<any>; setValue(key: string, value: any): Promise<void>; deleteValue(key: string): Promise<void>; listValues?(): Promise<string[]> };
const ROOT = 'keewebx-connect-mailbox-v1:';
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
function batch(names: string[], after: string, limit: number): string[] {
    names.sort();
    const found = names.findIndex(name => name > after), start = found < 0 ? 0 : found;
    return [...names.slice(start), ...names.slice(0, start)].slice(0, limit);
}

/** A window-independent fallback. Only signed, encrypted Connect envelopes enter it. */
export class ConnectMailbox {
    private live = false;
    private busy = false;
    private generation = 0;
    private requestCursor = '';
    private cleanupCursor = '';
    private timer?: ReturnType<typeof setTimeout>;
    private unwatch?: () => void;
    constructor(private host: string, private deliver: (value: any, reply: (value: any) => Promise<void>) => Promise<void>, private failed: (error: Error) => void) {}
    get available(): boolean { return typeof GM.listValues === 'function'; }
    start(): void {
        if (this.live || !this.available) return;
        this.live = true; this.generation++;
        this.unwatch = watchManagerStorage([`${ROOT}request:${this.host}:`], this.wake, true);
        addEventListener('focus', this.wake); addEventListener('pageshow', this.wake); addEventListener('visibilitychange', this.wake);
        this.wake();
    }
    stop(): void {
        this.live = false; this.generation++; this.busy = false; clearTimeout(this.timer); this.unwatch?.(); this.unwatch = undefined;
        removeEventListener('focus', this.wake); removeEventListener('pageshow', this.wake); removeEventListener('visibilitychange', this.wake);
    }
    private wake = () => { if (this.live && !this.busy) { clearTimeout(this.timer); void this.read(); } };
    private async read(): Promise<void> {
        this.busy = true;
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
                discard(name);
                // Admission, signatures, replay and session checks stay in NativeHost.
                void this.deliver(value, reply => write(key('reply', this.host, p.id), reply, current)).catch(error => {
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
        } catch (error) { if (current()) this.failed(error instanceof Error ? error : new Error('Userscripts storage is unavailable.')); }
        finally { if (current()) { this.busy = false; this.timer = setTimeout(this.wake, 150); } }
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
        if (active) void read(); else discard(requestKey);
    }, error => { if (active) failed(error instanceof Error ? error : new Error('Could not send the Connect request.')); });
    return () => { active = false; clearTimeout(timer); unwatch(); discard(requestKey); discard(replyKey); };
}
export function mailboxRelease(value: any): void {
    const name = key('request', value.packet.host, value.packet.id);
    void write(name, value).then(() => { setTimeout(() => discard(name), Math.max(0, value.packet.deadline - Date.now())); }, () => {});
}
