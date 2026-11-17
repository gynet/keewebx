import type { DiagnosticData } from '../../../diagnostics/src';

const listeners = new Set<(data: DiagnosticData) => void>();

/** Optional metadata observers cannot change protocol execution or validation. */
export function transportEvent(data: DiagnosticData): void {
    for (const listener of listeners) {
        try { listener(data); } catch { /* Support logging never interrupts Connect. */ }
    }
}

export function watchTransport(listener: (data: DiagnosticData) => void): () => void {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
}
