import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import type { EntryModel } from 'models/entry-model';
import type { FileModel } from 'models/file-model';
import { AppSettingsModel } from 'models/app-settings-model';
import { getSessionAccess } from 'comp/app/session-access';
import { Events } from 'framework/events';
import { confirmDiscardDrafts } from './pending-drafts';
import { PromptDialog } from './extension-prompts';
import { faviconCap, faviconUrl, fetchFavicon } from './favicon-image';
import { usePreferences } from './app-preferences';
import { t } from './i18n';

export function FaviconQuality() {
    const settings = usePreferences();
    return <div class="cardlist app-preferences"><label class="cardlist__row" for="setting-faviconSize">
        <span>{t('Downloaded website icon size')}</span><select id="setting-faviconSize" class="plain-select" value={faviconCap(settings.faviconSize)}
            onChange={event => { settings.faviconSize = faviconCap(Number(event.currentTarget.value)); }}>
            {[32, 64, 128].map(value => <option key={value} value={value}>{t('{} pixels', String(value))}</option>)}
        </select></label><p class="general-preferences__help">{t('Applies to website icons downloaded into a vault. Existing icons and remote icon display are unchanged.')}</p></div>;
}
interface Selection { file: FileModel; db: FileModel['db']; raw: EntryModel['entry']; epoch: number; editSeq: number; url: string; cap: number }
function available(model: AppModel, entry: EntryModel, selection?: Selection): boolean {
    const file = entry.file as FileModel;
    const access = getSessionAccess(model);
    if (access.state !== 'open' || !file.active || model.files.get(file.id) !== file || file.getEntry(entry.id) !== entry || file.syncing ||
        (file as FileModel & { readOnly?: boolean }).readOnly || (entry as EntryModel & { readOnly?: boolean }).readOnly) return false;
    if (selection && (!access.isCurrent(selection.epoch) || selection.file !== file || selection.db !== file.db || selection.raw !== entry.entry || selection.editSeq !== file.editSeq)) return false;
    for (let group = entry.entry.parentGroup; group; group = group.parentGroup) if (file.db.meta.recycleBinUuid?.equals(group.uuid)) return false;
    return true;
}
export function FaviconImport({ model, entry }: { model: AppModel; entry: EntryModel }) {
    const [selection, setSelection] = useState<Selection | null>(null);
    let url = ''; try { url = faviconUrl(entry.url); } catch { /* Invalid websites cannot be fetched. */ }
    return <>
        <button type="button" class="pill pill--tinted" disabled={!url || !available(model, entry)} onClick={() => {
            if (!url || !available(model, entry) || !confirmDiscardDrafts() || !available(model, entry)) return;
            const file = entry.file as FileModel;
            setSelection({ file, db: file.db, raw: entry.entry, editSeq: file.editSeq, epoch: getSessionAccess(model).epoch, url, cap: faviconCap(AppSettingsModel.faviconSize) });
        }}>{t('Download website icon…')}</button>
        {selection && <FaviconDialog key={entry.id} model={model} entry={entry} selection={selection} close={() => setSelection(null)} />}
    </>;
}
function FaviconDialog({ model, entry, selection, close }: { model: AppModel; entry: EntryModel; selection: Selection; close(): void }) {
    const [image, setImage] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const alive = useRef(true);
    const controller = useRef<AbortController>();
    const consumed = useRef(false);
    useLayoutEffect(() => {
        const unsubscribe = getSessionAccess(model).subscribeInvalidation(() => { controller.current?.abort(); close(); });
        return () => { alive.current = false; controller.current?.abort(); unsubscribe(); };
    }, []);
    const download = async () => {
        if (busy || !available(model, entry, selection)) return;
        setBusy(true); setError(''); setImage('');
        const abort = new AbortController(); controller.current = abort;
        const timeout = setTimeout(() => abort.abort(), 15_000);
        try {
            const result = await fetchFavicon(selection.url, selection.cap, abort.signal);
            if (!alive.current || abort.signal.aborted) return;
            if (!available(model, entry, selection)) throw new Error('This entry changed. Cancel and reopen the icon download.');
            setImage(result);
        } catch (failure) {
            if (alive.current) setError(abort.signal.aborted ? t('Icon download canceled or timed out.') : t(failure instanceof Error && !failure.message.startsWith('Network') && !failure.message.includes('fetch') ? failure.message : 'The website icon could not be downloaded. The server must allow cross-origin requests.'));
        } finally { clearTimeout(timeout); if (alive.current) setBusy(false); }
    };
    return <PromptDialog title={t('Download website icon')} icon="globe" cancel={close} confirmLabel={t('Use website icon')}
        disabled={!image || busy || !available(model, entry, selection)} confirm={() => {
            if (consumed.current || !image || busy || !available(model, entry, selection)) return;
            consumed.current = true;
            entry.setCustomIcon(selection.file.addCustomIcon(image));
            Events.emit('entry-updated', { entry }); Events.emit('refresh'); close();
        }}>
        <p>{t('This sends a request to the entry’s website. Only continue if you want to contact this server.')}</p>
        <p style={{ overflowWrap: 'anywhere' }}>{selection.url}</p>
        <p>{t('The image will be stored in this encrypted vault as PNG, up to {} pixels.', String(selection.cap))}</p>
        <button type="button" class="pill" disabled={busy || !available(model, entry, selection)} onClick={() => void download()}>{t(busy ? 'Downloading…' : 'Download icon')}</button>
        {image && <p><img width="64" height="64" style={{ objectFit: 'contain' }} src={`data:image/png;base64,${image}`} alt={t('Website icon preview')} /></p>}
        {error && <p role="alert">{error}</p>}
        {!available(model, entry, selection) && <p role="alert">{t('This entry changed. Cancel and reopen the icon download.')}</p>}
    </PromptDialog>;
}
