import type { AppModel } from 'models/app-model';
import type { EntryModel } from 'models/entry-model';
import { getSessionAccess } from 'comp/app/session-access';
import type {
    ProtocolUi, ConnectPrompt, ConnectDecision, SavePrompt, SaveDecision, CreateGroupPrompt
} from 'comp/extension/protocol-ui';

type PromptContent =
    | { kind: 'connect'; input: ConnectPrompt; complete(value: ConnectDecision | null): void }
    | { kind: 'entry'; input: Parameters<ProtocolUi['selectEntry']>[0]; complete(value: EntryModel | null): void }
    | { kind: 'field'; input: { entry: EntryModel }; complete(value: string | null): void }
    | { kind: 'save'; input: SavePrompt; complete(value: SaveDecision | null): void }
    | { kind: 'group'; input: CreateGroupPrompt; complete(value: string | null): void }
    | { kind: 'touch'; input: { deviceShortName: string }; cancel(): void };

export type ExtensionPrompt = PromptContent & { id: number };

export interface NewProtocolUi extends ProtocolUi {
    readonly prompt: ExtensionPrompt | null;
    subscribe(listener: () => void): () => void;
    mount(): () => void;
    cancel(): void;
}

/** A local decision port. Mounting a host does not start an extension transport. */
export function createNewProtocolUi(model: AppModel, blocked: () => boolean): NewProtocolUi {
    const access = getSessionAccess(model);
    const listeners = new Set<() => void>();
    let prompt: ExtensionPrompt | null = null;
    let mounted = false;
    let sequence = 0;
    let cancel: (() => void) | undefined;
    const notify = () => { for (const listener of listeners) listener(); };
    const accessible = (epoch?: number) => {
        try { access.assertOpen(epoch); return model.files.hasOpenFiles(); }
        catch { return false; }
    };
    const busy = () => !mounted || !!prompt || !accessible() || blocked();

    function ask<T>(makePrompt: (complete: (value: T | null) => void) => PromptContent,
        signal: AbortSignal): Promise<T | null> {
        if (signal.aborted || busy()) return Promise.resolve(null);
        const epoch = access.epoch;
        return new Promise((resolve) => {
            let settled = false;
            const finish = (value: T | null) => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', abort);
                prompt = null;
                cancel = undefined;
                const accepted = !signal.aborted && accessible(epoch) ? value : null;
                notify();
                resolve(accepted);
            };
            const abort = () => finish(null);
            prompt = { ...makePrompt(finish), id: ++sequence };
            cancel = abort;
            signal.addEventListener('abort', abort, { once: true });
            notify();
            if (signal.aborted) abort();
        });
    }

    return {
        get prompt() { return prompt; },
        isBusy: busy,
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        mount() {
            if (mounted) throw new Error('Extension UI already mounted');
            mounted = true;
            const unsubscribe = access.subscribeInvalidation(() => cancel?.());
            return () => { mounted = false; unsubscribe(); cancel?.(); };
        },
        cancel() { cancel?.(); },
        connect: (input, signal) => ask<ConnectDecision>((complete) => ({ kind: 'connect', input, complete }), signal),
        selectEntry: (input, signal) => ask<EntryModel>((complete) => ({ kind: 'entry', input, complete }), signal),
        selectField: (input, signal) => ask<string>((complete) => ({ kind: 'field', input, complete }), signal),
        saveEntry: (input, signal) => ask<SaveDecision>((complete) => ({ kind: 'save', input, complete }), signal),
        createGroup: (input, signal) => ask<string>((complete) => ({ kind: 'group', input, complete }), signal),
        showTouch(input, onCancel, signal) {
            if (signal.aborted || busy()) { onCancel(); return { dispose() {} }; }
            let disposed = false;
            const finish = (canceled: boolean) => {
                if (disposed) return;
                disposed = true;
                signal.removeEventListener('abort', abort);
                prompt = null;
                cancel = undefined;
                notify();
                if (canceled) onCancel();
            };
            const abort = () => finish(true);
            prompt = { kind: 'touch', input, cancel: abort, id: ++sequence };
            cancel = abort;
            signal.addEventListener('abort', abort, { once: true });
            notify();
            if (signal.aborted) abort();
            return { dispose: () => finish(false) };
        }
    };
}
