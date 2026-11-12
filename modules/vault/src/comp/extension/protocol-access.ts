import { Events } from 'framework/events';
import type { AppModel } from 'models/app-model';
import { getSessionAccess, type SessionAccess } from 'comp/app/session-access';

export interface ProtocolAccess {
    snapshot(): { open: boolean; epoch: number };
    assertOpen(epoch?: number): void;
    subscribeInvalidation(listener: () => void): () => void;
}

function createAccess(model: AppModel, session?: SessionAccess): ProtocolAccess {
    let epoch = 0;
    const listeners = new Set<() => void>();
    let unsubscribeSession: (() => void) | undefined;
    const events = ['file-opened', 'one-file-closed', 'all-files-closed', 'lock-workspace'];
    const invalidate = () => {
        ++epoch;
        for (const listener of [...listeners]) {
            try { listener(); } catch { console.error('Extension access observer failed'); }
        }
    };
    const snapshot = () => ({ open: (!session || session.state === 'open') && model.files.hasOpenFiles(), epoch });
    return {
        snapshot,
        assertOpen(expected) {
            if (session) session.assertOpen();
            if (!snapshot().open || (expected !== undefined && expected !== epoch)) throw new Error('Extension access suspended');
        },
        subscribeInvalidation(listener) {
            if (!listeners.size) {
                events.forEach((event) => Events.on(event, invalidate));
                unsubscribeSession = session?.subscribeInvalidation(invalidate);
            }
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
                if (!listeners.size) {
                    events.forEach((event) => Events.off(event, invalidate));
                    unsubscribeSession?.(); unsubscribeSession = undefined;
                }
            };
        }
    };
}

/** Classic explicitly retains its physical-open-file access policy. */
export function createClassicProtocolAccess(model: AppModel): ProtocolAccess {
    return createAccess(model);
}

/** New must also deny access to retained models during securing/recovery. */
export function createSessionProtocolAccess(model: AppModel): ProtocolAccess {
    return createAccess(model, getSessionAccess(model));
}
