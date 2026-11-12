import { Alerts } from 'comp/ui/alerts';
import { Locale } from 'util/locale';
import { ExtensionConnectView } from 'views/extension/extension-connect-view';
import { ExtensionCreateGroupView } from 'views/extension/extension-create-group-view';
import { ExtensionSaveEntryView } from 'views/extension/extension-save-entry-view';
import { SelectEntryView } from 'views/select/select-entry-view';
import { SelectEntryFieldView } from 'views/select/select-entry-field-view';
import type { EntryModel } from 'models/entry-model';
import type { ProtocolUi, ConnectDecision } from '../../../../../vault/src/comp/extension/protocol-ui';

function confirm<T>(config: Parameters<typeof Alerts.alert>[0], result: () => T,
    signal: AbortSignal): Promise<T | null> {
    if (signal.aborted) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
        let settled = false;
        let alert: ReturnType<typeof Alerts.alert>;
        const finish = (approved: boolean) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', cancel);
            try { resolve(approved ? result() : null); }
            catch (error) { reject(error); }
        };
        const cancel = () => {
            alert?.closeWithResult('');
            finish(false);
        };
        signal.addEventListener('abort', cancel, { once: true });
        try {
            alert = Alerts.alert({
                ...config,
                buttons: [Alerts.buttons.allow, Alerts.buttons.deny],
                enter: 'yes',
                esc: '',
                success: () => finish(true),
                cancel: () => finish(false)
            });
            if (!alert) finish(false);
            else if (signal.aborted) cancel();
        } catch (error) {
            signal.removeEventListener('abort', cancel);
            reject(error);
        }
    });
}

async function pick<T>(view: {
    showAndGetResult(): Promise<T | null | undefined>;
    emit(event: string, ...args: unknown[]): unknown;
    remove(): unknown;
}, signal: AbortSignal): Promise<T | null> {
    if (signal.aborted) { view.remove(); return null; }
    const cancel = () => { view.emit('result', undefined); };
    try {
        const result = view.showAndGetResult();
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        return (await result) ?? null;
    } finally {
        signal.removeEventListener('abort', cancel);
    }
}

export function createClassicProtocolUi(): ProtocolUi {
    return {
        isBusy: () => Alerts.alertDisplayed,
        connect(input, signal) {
            if (signal.aborted) return Promise.resolve(null);
            const view = new ExtensionConnectView(input);
            return confirm({
                header: Locale.extensionConnectHeader,
                icon: 'exchange-alt', view, wide: true, opaque: true
            }, () => view.config as ConnectDecision, signal);
        },
        async selectEntry(input, signal) {
            if (signal.aborted) return null;
            const result = await pick<{ entry: EntryModel }>(new SelectEntryView(input), signal);
            return result?.entry ?? null;
        },
        selectField(input, signal) {
            if (signal.aborted) return Promise.resolve(null);
            return pick<string>(new SelectEntryFieldView(input), signal);
        },
        saveEntry(input, signal) {
            if (signal.aborted) return Promise.resolve(null);
            const view = new ExtensionSaveEntryView({ ...input });
            return confirm({ header: Locale.extensionSaveEntryHeader, icon: 'plus', view },
                () => ({ ...view.config }), signal);
        },
        createGroup(input, signal) {
            if (signal.aborted) return Promise.resolve(null);
            const view = new ExtensionCreateGroupView({ ...input });
            return confirm({ header: Locale.extensionNewGroupHeader, icon: 'folder-plus', view },
                () => view.selectedFile, signal);
        },
        showTouch(input, onCancel, signal) {
            if (signal.aborted) { onCancel(); return { dispose() {} }; }
            const view = new SelectEntryFieldView({ needsTouch: true, ...input });
            let disposed = false;
            const dispose = () => {
                if (disposed) return;
                disposed = true;
                signal.removeEventListener('abort', cancel);
                view.off('result', cancel);
                view.remove();
            };
            const cancel = () => {
                if (disposed) return;
                dispose();
                onCancel();
            };
            view.once('result', cancel);
            signal.addEventListener('abort', cancel, { once: true });
            try { view.render(); }
            catch (error) { dispose(); throw error; }
            if (signal.aborted) cancel();
            return { dispose };
        }
    };
}
