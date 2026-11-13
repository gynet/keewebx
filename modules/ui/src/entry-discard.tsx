import { useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import type { EntryModel } from 'models/entry-model';
import type { FileModel } from 'models/file-model';
import { Events } from 'framework/events';
import { lifecycleSnapshot, writable } from './lifecycle-guard';
import { LifecycleDialog } from './lifecycle-dialog';
import { t } from './i18n';

export function EntryDiscard({ model, entry, onChanged, onDeleted }: {
    model: AppModel; entry: EntryModel; onChanged: () => void; onDeleted: () => void;
}) {
    const [request, setRequest] = useState<{ check: () => string; removes: boolean } | null>(null);
    const [error, setError] = useState('');
    const file = entry.file as FileModel;
    if (!entry.canDiscardUnsaved && !request) return null;
    return <div>
        <button type="button" class="pill" disabled={!!writable(model, file)} onClick={() => {
            const snapshot = lifecycleSnapshot(model, [file]), raw = entry.entry;
            const check = () => snapshot() || (file.getEntry(entry.id) !== entry || entry.entry !== raw || !entry.canDiscardUnsaved
                ? t('The entry changed. Cancel and reopen this action.') : '');
            if (check()) return;
            setError(''); setRequest({ check, removes: entry.discardRemovesEntry });
        }}>{t('Discard unsaved entry changes…')}</button>
        {error && <p role="alert">{error}</p>}
        {request && <LifecycleDialog title={t('Discard unsaved entry changes')} confirm={t('Discard entry changes')}
            check={request.check} destructive onClose={() => setRequest(null)} apply={() => {
                try {
                    entry.discardUnsaved(); model.updateTags(); Events.emit('entry-updated', { entry });
                    if (request.removes) onDeleted(); else onChanged();
                } catch (error) { setError(error instanceof Error ? error.message : t('The entry could not be discarded.')); }
            }}>
            <p>{t(request.removes ? 'This entry has never been saved successfully. Discarding removes it.'
                : 'Restore this entry’s content and history to its saved state before the first unsaved edit? Other entries and the current group location stay unchanged.')}</p>
            <p>{t('The database must still be saved to persist this undo.')}</p>
        </LifecycleDialog>}
    </div>;
}
