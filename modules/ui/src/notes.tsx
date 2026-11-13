import { useMemo, useRef, useState } from 'preact/hooks';
import { MdToHtml } from '@keewebx/ui-kit/md-to-html';
import { Events } from 'framework/events';
import { AppSettingsModel } from 'models/app-settings-model';
import type { EntryModel } from 'models/entry-model';
import type { FileModel } from 'models/file-model';
import { t } from './i18n';
import { ProtectedValue } from 'kdbxweb';
import { confirmDiscardDrafts, usePendingDraft } from './pending-drafts';

export function Notes({ entry }: { entry: EntryModel }) {
    const [draft, setDraft] = useState<string | null>(null);
    const baseline = useRef('');
    const [error, setError] = useState('');
    const value = entry.notes || '';
    const converted = useMemo(
        () => (AppSettingsModel.useMarkdown ? MdToHtml.convert(value) : { text: value }),
        [value, AppSettingsModel.useMarkdown]
    );

    const save = () => {
        if (draft !== null && ((entry.file as FileModel).getEntry(entry.id) !== entry || value !== baseline.current)) {
            setError(t('This entry changed while you were editing. Copy your notes, then cancel and reopen the editor.'));
            return false;
        }
        if (draft !== null && draft !== value) {
            const original = entry.entry.fields.get('Notes');
            entry.setField('Notes', original instanceof ProtectedValue ? ProtectedValue.fromString(draft) : draft);
            Events.emit('entry-updated', { entry });
        }
        setDraft(null);
    };
    usePendingDraft(draft !== null && draft !== value, save, () => setDraft(null));

    return (
        <section class="entry-notes" aria-label={t('Notes')}>
            <div class="notes__head">
                <h2 class="section-title">{t('Notes')}</h2>
                {draft === null && (
                    <button class="link" onClick={() => { baseline.current = value; setError(''); setDraft(value); }}>{t('Edit notes')}</button>
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
                        <button class="pill pill--primary" onClick={save}>{t('Save')}</button>
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
