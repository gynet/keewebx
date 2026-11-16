import { watchManagerStorage } from './manager-events';

declare const GM: { getValue(key: string): Promise<any>; setValue(key: string, value: any): Promise<void>; deleteValue(key: string): Promise<void>; listValues?(): Promise<string[]> };
const ROOT = 'keewebx-connect-mailbox-v1:';
const key = (kind: string, host: string, id: string) => `${ROOT}${kind}:${host}:${id}`;
const discard = (name: string) => { void Promise.resolve().then(() => GM.deleteValue(name)).catch(() => {}); };
const bounded = <T>(operation: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Userscripts storage did not respond.')), 5000);
    Promise.resolve().then(operation).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

/** A window-independent fallback. Only signed, encrypted Connect envelopes enter it. */
export class ConnectMailbox {
    private live = false;
    private busy = false;
    private timer?: ReturnType<typeof setTimeout>;
    private unwatch?: () => void;
    constructor(private host: string, private deliver: (value: any, reply: (value: any) => Promise<void>) => Promise<void>, private failed: (error: Error) => void) {}
    get available(): boolean { return typeof GM.listValues === 'function'; }
    start(): void {
        if (this.live || !this.available) return;
        this.live = true;
        this.unwatch = watchManagerStorage([`${ROOT}request:${this.host}:`], this.wake, true);
        addEventListener('focus', this.wake); addEventListener('pageshow', this.wake); addEventListener('visibilitychange', this.wake);
        this.wake();
    }
    stop(): void {
        this.live = false; clearTimeout(this.timer); this.unwatch?.(); this.unwatch = undefined;
        removeEventListener('focus', this.wake); removeEventListener('pageshow', this.wake); removeEventListener('visibilitychange', this.wake);
    }
    private wake = () => { if (this.live && !this.busy) { clearTimeout(this.timer); void this.read(); } };
    private async read(): Promise<void> {
        this.busy = true;
        try {
            const names = await bounded(() => GM.listValues!());
            for (const name of names.filter(name => name.startsWith(`${ROOT}request:${this.host}:`) || name.startsWith(`${ROOT}reply:${this.host}:`)).slice(0, 128)) {
                if (!this.live) break;
                const value = await bounded(() => GM.getValue(name)), p = value?.packet;
                if (!p || !Number.isFinite(p.deadline) || p.deadline <= Date.now() || p.deadline > Date.now() + 66000) { discard(name); continue; }
                if (name !== key('request', this.host, p.id) || p.host !== this.host) continue;
                await bounded(() => GM.deleteValue(name));
                if (!this.live) break;
                // Admission, signatures, replay and session checks stay in NativeHost.
                void this.deliver(value, reply => bounded(() => GM.setValue(key('reply', this.host, p.id), reply))).catch(error => {
                    if (this.live) this.failed(error instanceof Error ? error : new Error('Connect request failed.'));
                });
            }
        } catch (error) { if (this.live) this.failed(error instanceof Error ? error : new Error('Userscripts storage is unavailable.')); }
        finally { this.busy = false; if (this.live) this.timer = setTimeout(this.wake, 150); }
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
    void bounded(() => GM.setValue(requestKey, value)).then(() => {
        if (active) void read(); else discard(requestKey);
    }, error => { if (active) failed(error instanceof Error ? error : new Error('Could not send the Connect request.')); });
    return () => { active = false; clearTimeout(timer); unwatch(); discard(requestKey); discard(replyKey); };
}
export function mailboxRelease(value: any): void {
    const name = key('request', value.packet.host, value.packet.id);
    void bounded(() => GM.setValue(name, value)).then(() => { setTimeout(() => discard(name), 3500); }, () => {});
}
