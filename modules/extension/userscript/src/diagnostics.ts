import { DiagnosticClient, type DiagnosticData, type DiagnosticCommandKind, type DiagnosticSession } from '../../../diagnostics/src';
import { managerCall } from './native-connect';
import { watchManagerStorage } from './manager-events';
import { CONNECT_VERSION } from './version';
import type { ConnectUI } from './connect-ui';
import { watchTransport } from './transport-events';

const ORIGIN = 'https://keewebx.app';
const KEY = 'keewebx-connect-diagnostics-session-v1';
const REVOCATION_KEY = KEY + ':revocation';
const MARK = 'keewebx-connect-diagnostics-v1';
interface ManagerReply { status: number; responseText?: string; response?: unknown; finalUrl?: string; responseURL?: string }
interface ManagerRequest {
    method: string; url: string; headers: Record<string, string>; data: string; timeout: number;
    anonymous: boolean; responseType: 'text'; onload(value: ManagerReply): void; onerror(): void; ontimeout(): void; onabort(): void;
}
declare const GM: {
    getValue(key: string): Promise<unknown>; setValue(key: string, value: unknown): Promise<void>;
    deleteValue(key: string): Promise<void>;
    xmlHttpRequest?(request: ManagerRequest): { abort?(): void } | Promise<ManagerReply>;
};

/** Privileged HTTP is isolated here; the shared client never knows about GM. */
export function diagnosticRequest(path: string, body: unknown, token: string | undefined, signal: AbortSignal): Promise<unknown> {
    if (!/^\/api\/connect-diagnostics\/(?:session|[a-f0-9-]{36}\/exchange)$/.test(path)) return Promise.reject(new Error('Unsupported diagnostic path'));
    return new Promise((resolve, reject) => {
        let done = false;
        let handle: { abort?(): void } | undefined;
        const finish = (error?: Error, value?: unknown) => {
            if (done) return;
            done = true; signal.removeEventListener('abort', abort);
            if (error) reject(error); else resolve(value);
        };
        const abort = () => {
            if (done) return;
            finish(new Error('Diagnostics stopped'));
            try { handle?.abort?.(); } catch {}
        };
        if (signal.aborted) { abort(); return; }
        if (!GM.xmlHttpRequest) { finish(new Error('Diagnostic transport unavailable')); return; }
        const loaded = (reply: ManagerReply) => {
            if (done) return;
            if (!reply || reply.status < 200 || reply.status >= 300) { finish(new Error('Diagnostic request failed')); return; }
            try {
                const finalURL = reply.responseURL ?? reply.finalUrl;
                if (finalURL && new URL(finalURL).href !== ORIGIN + path) throw new Error('Redirected diagnostic request');
                const text = reply.responseText;
                if (text !== undefined && text.length > 65536) throw new Error('Oversized diagnostic response');
                finish(undefined, text !== undefined ? JSON.parse(text) : reply.response);
            } catch { finish(new Error('Invalid diagnostic response')); }
        };
        signal.addEventListener('abort', abort, { once: true });
        try {
            const request = GM.xmlHttpRequest({ method: 'POST', url: ORIGIN + path,
                headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
                data: JSON.stringify(body), timeout: 8000, anonymous: true, responseType: 'text',
                onload: loaded, onerror: () => finish(new Error('Diagnostic transport unavailable')),
                ontimeout: () => finish(new Error('Diagnostic transport timed out')), onabort: abort });
            // Userscripts returns an abortable Promise; Tampermonkey-style
            // adapters can instead return an object with abort(). Keep either.
            if (request && typeof (request as { abort?: unknown }).abort === 'function') handle = request as { abort(): void };
            if (request && 'then' in request) void request.then(loaded, () => finish(new Error('Diagnostic transport unavailable')));
        } catch { finish(new Error('Diagnostic transport unavailable')); }
    });
}

/** Website and App adapters share only a temporary, upload-only support grant. */
export function attachDiagnostics(ui: ConnectUI, read: () => DiagnosticData = () => ({})): {
    client: DiagnosticClient;
    snapshot(read: () => DiagnosticData): void;
} {
    let snapshot = read;
    let pending = false, pageAlive = true, preferenceRevision = 0;
    let appEnabledUntil = 0;
    const environment = (): DiagnosticData => ({ visible: !document.hidden, online: navigator.onLine });
    const notifyApp = (action: string, extra: Record<string, unknown> = {}) => {
        if (ui.mode === 'app') try { window.postMessage({ kwDiagnostics: MARK, kind: 'control', action, ...extra }, location.origin); } catch {}
    };
    const notifyWorker = (enabled: boolean, expiresAt?: number) => {
        if (ui.mode !== 'app' || !navigator.serviceWorker) return;
        void navigator.serviceWorker.getRegistration(new URL('/connect-port/', location.origin).href).then(registration => {
            registration?.active?.postMessage({ kwDiagnostics: MARK, kind: 'control', action: enabled ? 'enable' : 'disable', expiresAt });
        }).catch(() => {});
    };
    const readApp = (): Promise<DiagnosticData> => new Promise(resolve => {
        const id = crypto.randomUUID();
        const receive = (event: MessageEvent) => {
            if (event.isTrusted && event.source === window && event.origin === location.origin &&
                event.data?.kwDiagnostics === MARK && event.data.kind === 'snapshot' && event.data.id === id) {
                clearTimeout(timer); removeEventListener('message', receive); resolve(event.data.data);
            }
        };
        const timer = setTimeout(() => { removeEventListener('message', receive); resolve({ direct: false }); }, 1500);
        addEventListener('message', receive);
        notifyApp('snapshot', { id });
    });
    const revision = async (): Promise<string> => {
        const value = await managerCall(() => GM.getValue(REVOCATION_KEY), 'Diagnostics settings', 1500);
        if (value === undefined || value === null) return 'initial';
        if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value)) throw new Error('Invalid diagnostics settings');
        return value;
    };
    const client = new DiagnosticClient({
        source: ui.mode === 'app' ? 'app' : 'website', version: CONNECT_VERSION,
        store: {
            revision,
            async load() {
                const before = await revision();
                const value = await managerCall(() => GM.getValue(KEY), 'Diagnostics settings', 1500) as (DiagnosticSession & { consentFence?: string }) | undefined;
                const after = await revision();
                if (!value || before !== after || value.consentFence !== after) return;
                return { id: value.id, token: value.token, expiresAt: value.expiresAt };
            },
            async save(session, expectedRevision) {
                if (!session) {
                    // Keep a permanent tombstone. Deleting the grant alone has an
                    // ABA race with another document's pending session creation.
                    await managerCall(() => GM.setValue(REVOCATION_KEY, crypto.randomUUID()), 'Diagnostics settings', 1500);
                    await managerCall(() => GM.deleteValue(KEY), 'Diagnostics settings', 1500);
                    return;
                }
                if (expectedRevision === undefined || await revision() !== expectedRevision) throw new Error('Diagnostics stopped');
                await managerCall(() => GM.setValue(KEY, { ...session, consentFence: expectedRevision }), 'Diagnostics settings', 1500);
                if (await revision() !== expectedRevision) throw new Error('Diagnostics stopped');
            }
        }, transport: diagnosticRequest,
        snapshot: async (kind: DiagnosticCommandKind) => {
            const local: DiagnosticData = { ...environment(), ...snapshot(), layer: ui.mode === 'app' ? 'userscript' : 'website' };
            if (kind === 'receiver-check' && ui.mode === 'app') {
                const main = await readApp();
                client.record('app.receiver', { ...main, layer: 'app' });
            }
            return local;
        },
        onChange: state => {
            ui.remoteDiagnostics({ ...state, pending });
            notifyWorker(state.enabled, state.expiresAt);
            if (state.enabled && state.expiresAt && state.expiresAt !== appEnabledUntil) {
                appEnabledUntil = state.expiresAt;
                notifyApp('enable', { expiresAt: state.expiresAt });
            } else if (!state.enabled && appEnabledUntil) { appEnabledUntil = 0; notifyApp('disable'); }
        }
    });
    ui.onDiagnostic = (code, data) => client.record(code as Parameters<DiagnosticClient['record']>[0], {
        ...data, layer: ui.mode === 'app' ? 'userscript' : 'website'
    });
    const unwatchTransport = watchTransport(data => client.record('transport.event', {
        ...data, layer: ui.mode === 'app' ? 'userscript' : 'website'
    }));
    ui.onDiagnosticsChange = enabled => {
        if (pending && enabled) return;
        const epoch = ++preferenceRevision;
        pending = true; ui.remoteDiagnostics({ ...client.state, pending });
        void (enabled ? client.enable() : client.disable()).catch(() => {
            if (epoch === preferenceRevision) ui.remoteDiagnostics({ ...client.state, status: 'offline', error: 'unavailable' });
        }).finally(() => {
            if (epoch !== preferenceRevision) return;
            pending = false; ui.remoteDiagnostics({ ...client.state, pending });
        });
    };
    const refresh = () => { if (pageAlive && !pending) void client.refresh().catch(() => {}); };
    const unwatch = watchManagerStorage([KEY, REVOCATION_KEY], refresh);
    addEventListener('message', event => {
        if (ui.mode !== 'app' || !client.state.enabled || !event.isTrusted || event.source !== window ||
            event.origin !== location.origin || event.data?.kwDiagnostics !== MARK || event.data.kind !== 'event') return;
        if (['app.receiver', 'app.locked', 'app.unlocked'].includes(event.data.code)) {
            client.record(event.data.code, { ...event.data.data, layer: 'app' });
        }
    });
    if (ui.mode === 'app' && navigator.serviceWorker) navigator.serviceWorker.addEventListener('message', event => {
        if (!client.state.enabled || !event.isTrusted || event.ports.length ||
            (event.source as ServiceWorker | null)?.scriptURL !== new URL('/connect-port/worker.js', location.origin).href ||
            event.data?.kwDiagnostics !== MARK || event.data.kind !== 'event' || event.data.code !== 'transport.event') return;
        client.record('transport.event', { ...event.data.data, layer: 'worker' });
    });
    addEventListener('focus', refresh);
    addEventListener('online', () => client.setOnline(true));
    addEventListener('offline', () => client.setOnline(false));
    addEventListener('visibilitychange', () => {
        client.record(document.hidden ? 'page.hidden' : 'page.visible', environment());
        if (!document.hidden) refresh();
    });
    addEventListener('pagehide', event => {
        client.record('page.hide', { persisted: event.persisted });
        appEnabledUntil = 0; notifyApp('disable'); notifyWorker(false);
        pageAlive = false;
        if (!event.persisted) { client.dispose(); unwatch(); unwatchTransport(); }
    });
    // A restored document is allowed to opt back into the still-live stored grant.
    // No vault state or Connect authorization is changed by diagnostics.
    addEventListener('pageshow', event => {
        if (event.persisted) { pageAlive = true; refresh(); client.record('page.show', { persisted: true }); }
    });
    refresh();
    return { client, snapshot: read => { snapshot = read; } };
}
