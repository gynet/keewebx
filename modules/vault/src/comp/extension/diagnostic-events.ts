/** Safe, opt-in observations for the privileged Connect diagnostics adapter. */
const MARK = 'keewebx-connect-diagnostics-v1';
type Snapshot = { live: boolean; locked: boolean; hasPort: boolean; pending: number; authorization: number };
let snapshot: (() => Snapshot) | undefined;
let enabledUntil = 0;
let started = false;

export function recordConnectDiagnostic(code: 'app.receiver' | 'app.locked' | 'app.unlocked', data: Partial<Snapshot> = {}): void {
    if (!enabledUntil || enabledUntil <= Date.now()) return;
    // Only primitive lifecycle fields cross the page boundary. No request or
    // protocol response objects, logger arguments or model values are inspected.
    const safe: Partial<Snapshot> = {};
    for (const key of ['live', 'locked', 'hasPort'] as const) if (typeof data[key] === 'boolean') safe[key] = data[key];
    for (const key of ['pending', 'authorization'] as const) {
        const value = data[key];
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) safe[key] = Math.min(value, 1000000);
    }
    try { window.postMessage({ kwDiagnostics: MARK, kind: 'event', code, data: safe }, location.origin); } catch {}
}

/** Controls observe state only; they cannot invoke the vault protocol. */
export function startConnectDiagnostics(read: () => Snapshot): void {
    snapshot = read;
    if (started || typeof window === 'undefined') return;
    started = true;
    window.addEventListener('message', event => {
        if (!event.isTrusted || event.source !== window || event.origin !== location.origin ||
            event.data?.kwDiagnostics !== MARK || event.data.kind !== 'control') return;
        const data = event.data;
        if (data.action === 'disable') { enabledUntil = 0; return; }
        if (data.action === 'enable' && Number.isFinite(data.expiresAt) && data.expiresAt > Date.now() && data.expiresAt <= Date.now() + 3600000) {
            enabledUntil = data.expiresAt;
            try { if (snapshot) recordConnectDiagnostic('app.receiver', snapshot()); } catch {}
        } else if (data.action === 'snapshot' && enabledUntil > Date.now() &&
            typeof data.id === 'string' && /^[a-f0-9-]{36}$/i.test(data.id)) {
            try {
                const state = snapshot?.();
                if (state) window.postMessage({ kwDiagnostics: MARK, kind: 'snapshot', id: data.id,
                    data: { live: !!state.live, locked: !!state.locked, hasPort: !!state.hasPort,
                        pending: Math.min(Math.max(0, state.pending | 0), 1000000),
                        authorization: Math.min(Math.max(0, state.authorization | 0), 1000000) } }, location.origin);
            } catch {}
        }
    });
}
