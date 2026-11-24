const MARK = 'keewebx-connect-observer-v1';
const ATTRIBUTE = 'data-kwx-connect-local-log';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EVENTS = new Set(['main-discovery', 'main-handoff', 'main-enabled', 'main-visible', 'main-hidden', 'main-page-show', 'main-page-hide']);
const field = (value: object, key: string): unknown => {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && 'value' in descriptor ? descriptor.value : undefined;
    } catch { return undefined; }
};
export function appLogRecording(enabled: boolean): void {
    if (enabled) document.documentElement?.setAttribute(ATTRIBUTE, 'true');
    else document.documentElement?.removeAttribute(ATTRIBUTE);
}
export function mainReceiverLines(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 100) return [];
    const lines: string[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const at = field(item, 'at'), event = field(item, 'event'), visible = field(item, 'visible');
        if (typeof at !== 'number' || !Number.isFinite(at) || at < 0 || at > 8.64e15 ||
            typeof event !== 'string' || !EVENTS.has(event) || typeof visible !== 'boolean') continue;
        const safe: Record<string, string | number | boolean> = { event, visible };
        for (const key of ['traceId', 'portId']) {
            const id = field(item, key); if (typeof id === 'string' && UUID.test(id)) safe[key] = id;
        }
        const read = field(item, 'dataReadMs'), persisted = field(item, 'persisted');
        if (typeof read === 'number' && Number.isFinite(read) && read >= 0 && read <= 3_600_000) safe.dataReadMs = read;
        if (typeof persisted === 'boolean') safe.persisted = persisted;
        lines.push(`${new Date(at).toISOString().slice(11, 23)}Z ${JSON.stringify(safe)}`);
    }
    return lines;
}
/** Explicit local-log export only. The App observer never receives keys or RPC payloads. */
export function readMainReceiverLog(): Promise<string[]> {
    if (document.documentElement?.getAttribute(ATTRIBUTE) !== 'true') return Promise.resolve([]);
    const nonce = crypto.randomUUID();
    return new Promise(resolve => {
        const finish = (lines: string[]) => { clearTimeout(timer); window.removeEventListener('message', receive); resolve(lines); };
        const receive = (event: MessageEvent) => {
            if (!event.isTrusted || event.source !== window || event.origin !== location.origin || event.ports.length) return;
            const data = event.data;
            if (!data || data.marker !== MARK || data.kind !== 'snapshot-reply' || data.nonce !== nonce) return;
            finish(mainReceiverLines(data.records));
        };
        const timer = setTimeout(() => finish([]), 300);
        window.addEventListener('message', receive);
        try { window.postMessage({ marker: MARK, kind: 'snapshot', nonce }, location.origin); }
        catch { finish([]); }
    });
}
