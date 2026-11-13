import { useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import type { EntryModel } from 'models/entry-model';
import type { FileModel } from 'models/file-model';
import { Events } from 'framework/events';
import { lifecycleSnapshot, writable } from './lifecycle-guard';
import { PromptDialog } from './extension-prompts';
import { t } from './i18n';

export function TemplateDelete({ model, entry, onDeleted }: { model: AppModel; entry: EntryModel; onDeleted(): void }) {
    const file = entry.file as FileModel;
    const [confirmation, setConfirmation] = useState<{ check(): string; raw: EntryModel['entry']; groupId: string; trash: boolean } | null>(null);
    const [error, setError] = useState('');
    const consumed = useRef(false);
    const reason = writable(model, file);
    const invalid = () => {
        if (!confirmation) return reason;
        return confirmation.check() || (file.getEntry(entry.id) !== entry || entry.entry !== confirmation.raw
            || file.getEntryTemplatesGroup()?.id !== confirmation.groupId || entry.group !== file.getEntryTemplatesGroup()
            ? t('This template changed. Cancel and open Delete template again.') : '');
    };
    return <>
        <button type="button" class="pill pill--danger" disabled={!!reason} onClick={() => {
            if (writable(model, file) || entry.group !== file.getEntryTemplatesGroup()) return;
            consumed.current = false; setError('');
            setConfirmation({ check: lifecycleSnapshot(model, [file]), raw: entry.entry,
                groupId: file.getEntryTemplatesGroup()!.id, trash: !!file.db.meta.recycleBinEnabled });
        }}>{t('Delete template…')}</button>
        {confirmation && <PromptDialog title={t('Delete template')} icon="trash" cancel={() => setConfirmation(null)}
            confirmLabel={t(confirmation.trash ? 'Move template to Trash' : 'Delete template permanently')} disabled={!!invalid() || consumed.current}
            confirm={() => {
                const changed = invalid(); if (changed || consumed.current) { setError(changed); return; }
                try {
                    consumed.current = true; entry.moveToTrash(); model.updateTags(); Events.emit('refresh');
                    setConfirmation(null); onDeleted();
                } catch { setError(t('The template could not be deleted. Cancel and check the database.')); }
            }}>
            <p>{t('Template: {}', entry.title || t('Untitled'))}</p><p>{t('Database: {}', file.name)}</p>
            <p>{t(confirmation.trash ? 'Move this template to Trash? Entries already created from it will be kept. You can restore it from Trash.'
                : 'Trash is disabled. This permanently deletes the template, its history and attachments. Entries already created from it will be kept.')}</p>
            {(invalid() || error) && <p role="alert">{invalid() || error}</p>}
        </PromptDialog>}
    </>;
}
