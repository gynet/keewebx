const ATTRIBUTE = 'data-kwx-connect-local-log';
const MARKER = 'keewebx-connect-observer-v1';
const PORT_MARKER = 'keewebx-connect-port-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuid = (value: unknown): value is string => typeof value === 'string' && value.length === 36 && UUID.test(value);

export interface ConnectReceiverRecord {
    at: number;
    event: 'main-discovery' | 'main-handoff' | 'main-enabled' | 'main-visible' | 'main-hidden' | 'main-page-show' | 'main-page-hide';
    visible: boolean;
    traceId?: string;
    portId?: string;
    dataReadMs?: number;
    sentAt?: number;
    persisted?: boolean;
}

function object(value: unknown): value is object {
    if (!value || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}
// Read only public own data properties, never payloads or accessor properties.
function field(value: object, key: string): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/** Passive main-world observation. This code must never touch a service-worker event's ports. */
export function startConnectReceiverObserver(): () => void {
    const root = document.documentElement;
    const origin = window.location.origin;
    if (!root || !/^https?:$/.test(window.location.protocol)) return () => {};
    const workerURL = new URL('connect-port/worker.js', document.baseURI);
    if (workerURL.origin !== origin) return () => {};
    const container = navigator.serviceWorker;
    const records: ConnectReceiverRecord[] = [];
    let enabled = false;
    const record = (value: ConnectReceiverRecord) => {
        records.push(value);
        if (records.length > 100) records.shift();
    };
    const refresh = () => {
        const next = root.getAttribute(ATTRIBUTE) === 'true';
        if (!next) records.length = 0;
        if (next && !enabled) record({ at: Date.now(), event: 'main-enabled', visible: !document.hidden });
        enabled = next;
        return enabled;
    };
    const observer = new MutationObserver(changes => {
        // A disable/re-enable in one mutation batch must also discard old records.
        if (enabled && changes.some(change => change.oldValue !== 'true')) {
            records.length = 0; enabled = false;
        }
        refresh();
    });
    observer.observe(root, { attributes: true, attributeFilter: [ATTRIBUTE], attributeOldValue: true });
    const receive = (event: MessageEvent) => {
        const at = Date.now(); // Capture callback entry before any event.data access.
        if (!refresh() || !event.isTrusted) return;
        try {
            if ((event.source as ServiceWorker | null)?.scriptURL !== workerURL.href) return;
            const started = performance.now();
            const data: unknown = event.data;
            const dataReadMs = performance.now() - started;
            if (!object(data) || field(data, 'marker') !== PORT_MARKER) return;
            const kind = field(data, 'kind');
            if (kind !== 'find-app' && kind !== 'attach-port') return;
            const traceId = field(data, 'traceId'), portId = field(data, 'connectionId');
            if ((traceId !== undefined && !uuid(traceId)) || (portId !== undefined && !uuid(portId)) ||
                (kind === 'find-app' ? !uuid(traceId) : !uuid(portId))) return;
            if (!Number.isFinite(dataReadMs) || dataReadMs < 0 || !refresh()) return;
            const sentAt = field(data, 'sentAt');
            const timing = typeof sentAt === 'number' && Number.isInteger(sentAt) && sentAt >= 0 && sentAt <= 8.64e15
                ? { sentAt } : {};
            record({ at, ...timing, event: kind === 'find-app' ? 'main-discovery' : 'main-handoff', visible: !document.hidden,
                dataReadMs, ...(uuid(traceId) ? { traceId } : {}), ...(uuid(portId) ? { portId } : {}) });
        } catch { /* Optional observation cannot interrupt the receiver. */ }
    };
    const snapshot = (event: MessageEvent) => {
        if (!refresh() || !event.isTrusted || event.source !== window || event.origin !== origin) return;
        try {
            if (event.ports.length !== 0) return;
            const data: unknown = event.data;
            if (!object(data)) return;
            const keys = Reflect.ownKeys(data);
            if (keys.length !== 3 || !keys.every(key => key === 'marker' || key === 'kind' || key === 'nonce') ||
                field(data, 'marker') !== MARKER || field(data, 'kind') !== 'snapshot') return;
            const nonce = field(data, 'nonce');
            if (!uuid(nonce) || !refresh()) return;
            window.postMessage({ marker: MARKER, kind: 'snapshot-reply', nonce, records: records.map(value => ({ ...value })) }, origin);
        } catch { /* No reply for malformed requests. */ }
    };
    const lifecycle = (event: Event) => {
        if (!refresh() || !event.isTrusted) return;
        const name = event.type === 'visibilitychange' ? document.hidden ? 'main-hidden' : 'main-visible'
            : event.type === 'pageshow' ? 'main-page-show' : 'main-page-hide';
        record({ at: Date.now(), event: name, visible: !document.hidden,
            ...(event.type === 'pageshow' || event.type === 'pagehide' ? { persisted: (event as PageTransitionEvent).persisted === true } : {}) });
    };
    container?.addEventListener('message', receive);
    window.addEventListener('message', snapshot);
    document.addEventListener('visibilitychange', lifecycle);
    window.addEventListener('pageshow', lifecycle);
    window.addEventListener('pagehide', lifecycle);
    refresh();
    return () => {
        observer.disconnect(); records.length = 0; enabled = false;
        container?.removeEventListener('message', receive);
        window.removeEventListener('message', snapshot);
        document.removeEventListener('visibilitychange', lifecycle);
        window.removeEventListener('pageshow', lifecycle);
        window.removeEventListener('pagehide', lifecycle);
    };
}
