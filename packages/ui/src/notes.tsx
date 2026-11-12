import { useMemo, useState } from 'preact/hooks';
import { MdToHtml } from '@keewebx/ui-kit/md-to-html';
import { Events } from 'framework/events';
import { AppSettingsModel } from 'models/app-settings-model';
import type { EntryModel } from 'models/entry-model';
import { t } from './i18n';

export function Notes({ entry }: { entry: EntryModel }) {
    const [draft, setDraft] = useState<string | null>(null);
    const value = entry.notes || '';
    const converted = useMemo(
        () => (AppSettingsModel.useMarkdown ? MdToHtml.convert(value) : { text: value }),
        [value, AppSettingsModel.useMarkdown]
    );

    const save = () => {
        if (draft !== null && draft !== value) {
            entry.setField('Notes', draft);
            Events.emit('entry-updated', { entry });
        }
        setDraft(null);
    };

    return (
        <section class="entry-notes" aria-label={t('Notes')}>
            <div class="notes__head">
                <h2 class="section-title">{t('Notes')}</h2>
                {draft === null && (
                    <button class="link" onClick={() => setDraft(value)}>{t('Edit notes')}</button>
                )}
            </div>
            {draft !== null ? (
                <div class="notes__edit">
                    <textarea
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
