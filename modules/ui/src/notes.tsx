import { useMemo, useRef, useState } from 'preact/hooks';
import { MdToHtml } from '@keewebx/ui-kit/md-to-html';
import { Events } from 'framework/events';
import { AppSettingsModel } from 'models/app-settings-model';
import type { EntryModel } from 'models/entry-model';
import type { FileModel } from 'models/file-model';
import type { AppModel } from 'models/app-model';
import { getSessionAccess } from 'comp/app/session-access';
import { t } from './i18n';
import { ProtectedValue } from 'kdbxweb';
import { confirmDiscardDrafts, usePendingDraft } from './pending-drafts';

export function Notes({ model, entry }: { model: AppModel; entry: EntryModel }) {
    const [draft, setDraft] = useState<string | null>(null);
    const baseline = useRef('');
    const target = useRef({ file: entry.file as FileModel, db: (entry.file as FileModel).db, raw: entry.entry });
    const access = getSessionAccess(model), openEpoch = useRef(access.epoch);
    if (access.state === 'open') openEpoch.current = access.epoch;
    const available = () => {
        const { db, raw } = target.current;
        const file = draft === null ? entry.file as FileModel : target.current.file;
        return (access.state === 'open' || (access.state === 'securing' && access.epoch === openEpoch.current + 1)) &&
            file.active && model.files.get(file.id) === file && entry.file === file &&
            (draft === null || (file.db === db && entry.entry === raw)) &&
            file.getEntry(entry.id) === entry && !(file as FileModel & { readOnly?: boolean }).readOnly;
    };
    const [error, setError] = useState('');
    const value = entry.notes || '';
    const converted = useMemo(
        () => (AppSettingsModel.useMarkdown ? MdToHtml.convert(value) : { text: value }),
        [value, AppSettingsModel.useMarkdown]
    );

    const save = (retain = false) => {
        if (draft !== null && ((entry.file as FileModel).getEntry(entry.id) !== entry || value !== baseline.current)) {
            setError(t('This entry changed while you were editing. Copy your notes, then cancel and reopen the editor.'));
            return false;
        }
        if (!available()) {
            setError(t('This database is read-only or the entry is no longer available. Copy your notes before canceling.'));
            return false;
        }
        if (draft !== null && draft !== value) {
            const original = entry.entry.fields.get('Notes');
            entry.setField('Notes', original instanceof ProtectedValue ? ProtectedValue.fromString(draft) : draft);
            Events.emit('entry-updated', { entry });
        }
        if (retain) baseline.current = draft ?? value;
        else setDraft(null);
    };
    usePendingDraft(draft !== null && draft !== value, save, () => setDraft(null), undefined, (entry.file as FileModel).id);

    return (
        <section class="entry-notes" aria-label={t('Notes')}>
            <div class="notes__head">
                <h2 class="section-title">{t('Notes')}</h2>
                {draft === null && (
                    <button class="link" disabled={!available()} onClick={() => {
                        if (!available() || access.state !== 'open') return;
                        target.current = { file: entry.file as FileModel, db: (entry.file as FileModel).db, raw: entry.entry };
                        baseline.current = value; setError(''); setDraft(value);
                    }}>{t('Edit notes')}</button>
                )}
            </div>
            {draft !== null ? (
                <div class="notes__edit">
                    {error && <p class="error" role="alert">{error}</p>}
                    <textarea
                        onKeyDown={(event) => {
                            if (event.isComposing || event.keyCode === 229) return;
                            if (event.key === 'Escape') {
                                event.preventDefault(); event.stopPropagation();
                                if (confirmDiscardDrafts()) setDraft(null);
                            } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                                event.preventDefault(); event.stopPropagation(); save();
                            }
                        }}
                        class="input notes__editor"
                        aria-label={t('Notes')}
                        value={draft}
                        onInput={(e) => setDraft(e.currentTarget.value)}
                        autoFocus
                    />
                    <div class="notes__actions">
                        <button class="pill" onClick={() => setDraft(null)}>{t('Cancel')}</button>
                        <button class="pill pill--primary" onClick={() => save()}>{t('Save')}</button>
                    </div>
                </div>
            ) : typeof converted !== 'string' && converted.html ? (
                <div class="notes" dangerouslySetInnerHTML={{ __html: converted.html }} />
            ) : (
                <p class={value ? 'notes' : 'notes muted'}>{value || t('No notes')}</p>
            )}
        </section>
    );
}
