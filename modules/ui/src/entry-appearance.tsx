import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import type { EntryModel } from 'models/entry-model';
import type { FileModel } from 'models/file-model';
import { ENTRY_ICONS } from 'const/icon-registry';
import { Colors, type ColorName } from 'const/colors';
import { Events } from 'framework/events';
import { getSessionAccess } from 'comp/app/session-access';
import { EntryIcon } from 'ui-kit/icons';
import { confirmDiscardDrafts } from './pending-drafts';
import { t } from './i18n';
import './entry-appearance.css';

const names = (name: string) => name.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase());
const flagColors: Record<string, string> = { yellow: '#a27c00', green: '#288456', red: '#c64a4a', orange: '#c47724', blue: '#357bc2', violet: '#9462b4' };
export function EntryFlag({ color }: { color: string | null }) {
    return color && flagColors[color] ? <span class="entry-flag" style={{ backgroundColor: flagColors[color] }}
        role="img" aria-label={t('{} flag', names(color))} title={t('{} flag', names(color))} /> : null;
}
export function EntryColorFilter({ value, onChange }: { value?: string; onChange(value: string): void }) {
    return <label class="entry-color-filter"><span>{t('Color')}</span><select class="plain-select" aria-label={t('Filter by color')}
        value={value ?? ''} onChange={event => onChange(event.currentTarget.value)}>
        <option value="">{t('All colors')}</option><option value="any">{t('Any flag')}</option>
        {Colors.AllColors.map(color => <option key={color} value={color}>{t(names(color))}</option>)}
    </select></label>;
}

interface Selection { file: FileModel; db: FileModel['db']; raw: EntryModel['entry']; epoch: number; editSeq: number; }
function unavailable(model: AppModel, entry: EntryModel, selection?: Selection): string {
    const file = entry.file as FileModel;
    const access = getSessionAccess(model);
    if (access.state !== 'open' || (selection && !access.isCurrent(selection.epoch))) return t('Unlock and reopen appearance settings.');
    if (!file.active || model.files.get(file.id) !== file || file.getEntry(entry.id) !== entry ||
        (selection && (selection.file !== file || selection.db !== file.db || selection.raw !== entry.entry || selection.editSeq !== file.editSeq)))
        return t('This entry changed. Cancel and reopen appearance settings.');
    if ((file as FileModel & { readOnly?: boolean }).readOnly || (entry as EntryModel & { readOnly?: boolean }).readOnly) return t('This database is read-only.');
    if (file.syncing) return t('A save is in progress. Wait for it to finish.');
    return '';
}
export function EntryAppearance({ model, entry }: { model: AppModel; entry: EntryModel }) {
    const [selection, setSelection] = useState<Selection | null>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const reason = unavailable(model, entry);
    return <>
        <button ref={trigger} class="pill pill--tinted" type="button" disabled={!!reason} title={reason || undefined} onClick={() => {
            if (unavailable(model, entry) || !confirmDiscardDrafts() || unavailable(model, entry)) return;
            const file = entry.file as FileModel;
            setSelection({ file, db: file.db, raw: entry.entry, epoch: getSessionAccess(model).epoch, editSeq: file.editSeq });
        }}>{t('Appearance…')}</button>
        {selection && <AppearanceDialog model={model} entry={entry} selection={selection} close={() => setSelection(null)} trigger={trigger} />}
    </>;
}
function AppearanceDialog({ model, entry, selection, close, trigger }: {
    model: AppModel; entry: EntryModel; selection: Selection; close(): void; trigger: { current: HTMLButtonElement | null };
}) {
    const { file } = selection;
    const [icon, setIcon] = useState(entry.entry.customIcon ? `custom:${entry.entry.customIcon.id}` : `builtin:${entry.iconId}`);
    const [color, setColor] = useState(entry.color ?? '');
    const [upload, setUpload] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const dialog = useRef<HTMLDialogElement>(null);
    const reading = useRef(0);
    const applied = useRef(false);
    const customIcons = file.getCustomIcons();
    const reason = unavailable(model, entry, selection);
    useLayoutEffect(() => {
        const element = dialog.current!;
        element.showModal();
        return () => {
            ++reading.current; element.close();
            requestAnimationFrame(() => {
                if (getSessionAccess(model).state === 'open' && trigger.current?.isConnected && !trigger.current.closest('[hidden], [inert]')) trigger.current.focus();
            });
        };
    }, []);
    const readImage = async (image: File) => {
        const version = ++reading.current;
        setLoading(true); setError('');
        let bitmap: ImageBitmap | undefined;
        try {
            if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.type) || image.size > 1024 * 1024)
                throw new Error('Choose a PNG, JPEG, or WebP image up to 1 MB.');
            bitmap = await createImageBitmap(image);
            if (!bitmap.width || !bitmap.height || bitmap.width > 8192 || bitmap.height > 8192)
                throw new Error('This image is too large or invalid.');
            const canvas = document.createElement('canvas');
            const scale = Math.min(1, 128 / Math.max(bitmap.width, bitmap.height));
            canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Image processing is unavailable.');
            context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            const data = canvas.toDataURL('image/png').split(',')[1];
            if (version !== reading.current) return;
            const changed = unavailable(model, entry, selection);
            if (changed) throw new Error(changed);
            setUpload(data); setIcon('upload');
        } catch (error) { if (version === reading.current) setError(error instanceof Error ? t(error.message) : t('Could not read the image.')); }
        finally { bitmap?.close(); if (version === reading.current) setLoading(false); }
    };
    const apply = () => {
        if (loading || applied.current) return;
        const reason = unavailable(model, entry, selection);
        if (reason) { setError(reason); return; }
        const [kind, value] = icon.split(':');
        if ((kind === 'custom' && !file.db.meta.customIcons.has(value)) || (kind === 'builtin' && !ENTRY_ICONS[Number(value)]) || (kind === 'upload' && !upload)) {
            setError(t('Choose an available icon.')); return;
        }
        applied.current = true;
        if (kind === 'upload') entry.setCustomIcon(file.addCustomIcon(upload));
        else if (kind === 'custom' && entry.entry.customIcon?.id !== value) entry.setCustomIcon(value);
        else if (kind === 'builtin' && (entry.entry.customIcon || entry.iconId !== Number(value))) entry.setIcon(Number(value));
        if (file.supportsColors && color !== (entry.color ?? '')) {
            entry.setColor((color || null) as ColorName | null);
            // Imported foreground colors also act as flags. Record history before clearing them.
            if (!color && entry.entry.fgColor) { entry.entry.fgColor = undefined; entry.setColor(null); }
        }
        Events.emit('entry-updated', { entry }); Events.emit('refresh'); close();
    };
    return <dialog ref={dialog} class="entry-appearance" aria-label={t('Entry appearance')} onCancel={event => { event.preventDefault(); close(); }}>
        <h2>{t('Entry appearance')}</h2>
        <div class="entry-appearance__scroll">
            {file.supportsColors && <label class="vault-form__field">{t('Color flag')}<select class="input" value={color} disabled={loading || !!reason} onChange={event => setColor(event.currentTarget.value)}>
                <option value="">{t('None')}</option>{Colors.AllColors.map(color => <option key={color} value={color}>{t(names(color))}</option>)}
            </select></label>}
            <fieldset disabled={loading || !!reason}><legend>{t('Built-in icon')}</legend>
                <div class="entry-appearance__icons">{ENTRY_ICONS.map((name, index) => <label key={name} title={names(name)}>
                    <input type="radio" name="entry-icon" aria-label={t('Icon: {}', names(name))} checked={icon === `builtin:${index}`} onChange={() => setIcon(`builtin:${index}`)} />
                    <EntryIcon name={name} size={24} />
                </label>)}</div>
            </fieldset>
            {Object.keys(customIcons).length > 0 && <fieldset disabled={loading || !!reason}><legend>{t('Custom icons in this vault')}</legend>
                <div class="entry-appearance__icons">{Object.entries(customIcons).map(([id, data], index) => <label key={id}>
                    <input type="radio" name="entry-icon" aria-label={t('Custom icon {}', String(index + 1))} checked={icon === `custom:${id}`} onChange={() => setIcon(`custom:${id}`)} />
                    <img src={data} alt="" width="28" height="28" />
                </label>)}</div>
            </fieldset>}
            <label class="vault-form__field">{t('Upload icon')}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={loading || !!reason}
                onChange={event => { const image = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (image) void readImage(image); }} /></label>
            <p class="muted">{t('PNG, JPEG, or WebP up to 1 MB. Stored locally in the vault as PNG, up to 128 pixels. Choose a built-in icon to remove the custom icon from this entry.')}</p>
            {upload && icon === 'upload' && <img class="entry-appearance__preview" src={`data:image/png;base64,${upload}`} alt={t('New icon preview')} />}

            {(reason || error) && <p role="alert">{reason || error}</p>}
            {loading && <p role="status">{t('Reading image…')}</p>}
        </div>
        <div class="entry-appearance__actions"><button type="button" class="pill" onClick={close}>{t('Cancel')}</button>
            <button type="button" class="pill pill--primary" disabled={loading || !!reason} onClick={apply}>{t('Apply appearance')}</button></div>
    </dialog>;
}
