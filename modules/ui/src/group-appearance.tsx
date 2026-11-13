import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import type { GroupModel } from 'models/group-model';
import { AppSettingsModel } from 'models/app-settings-model';
import { Events } from 'framework/events';
import { getSessionAccess } from 'comp/app/session-access';
import { ENTRY_ICONS } from 'const/icon-registry';
import { EntryIcon } from 'ui-kit/icons';
import { groupChain, inTrash, lifecycleSnapshot, writable } from './lifecycle-guard';
import { confirmDiscardDrafts } from './pending-drafts';
import { IconChoices } from './icon-choices';
import { normalizeIcon } from './icon-image';
import { t } from './i18n';
import './entry-appearance.css';

export function GroupIcon({ group }: { group: { iconId?: number | null; customIcon?: string | null } }) {
    const [failed, setFailed] = useState('');
    return <span class="group-icon" aria-hidden="true" style={{ display: 'inline-flex', flexShrink: 0, width: 18, height: 18 }}>
        {group.customIcon && failed !== group.customIcon
            ? <img src={group.customIcon} alt="" width="18" height="18" style={{ objectFit: 'contain', filter: AppSettingsModel.colorfulIcons ? undefined : 'grayscale(1)' }} onError={() => setFailed(group.customIcon!)} />
            : <EntryIcon name={ENTRY_ICONS[group.iconId ?? 48] ?? ENTRY_ICONS[48]} size={18} />}
    </span>;
}
function unavailable(model: AppModel, file: FileModel, group: GroupModel): string {
    return writable(model, file) || (!groupChain(file, group) || inTrash(file, group) ? t('Select a group outside Trash.') : '');
}
export function GroupAppearance({ model, file, group, disabled = false }: { model: AppModel; file: FileModel; group: GroupModel; disabled?: boolean }) {
    const [check, setCheck] = useState<(() => string) | null>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const reason = unavailable(model, file, group);
    return <>
        <button ref={trigger} type="button" class="pill pill--tinted" disabled={disabled || !!reason} title={reason || undefined} onClick={() => {
            if (disabled || unavailable(model, file, group) || !confirmDiscardDrafts() || unavailable(model, file, group)) return;
            const snapshot = lifecycleSnapshot(model, [file]); setCheck(() => snapshot);
        }}>{t('Group icon…')}</button>
        {check && <GroupIconDialog model={model} file={file} group={group} check={check} close={() => setCheck(null)} trigger={trigger} />}
    </>;
}
function GroupIconDialog({ model, file, group, check, close, trigger }: {
    model: AppModel; file: FileModel; group: GroupModel; check(): string; close(): void; trigger: { current: HTMLButtonElement | null };
}) {
    const [icon, setIcon] = useState(group.customIconId ? `custom:${group.customIconId}` : `builtin:${group.iconId ?? 48}`);
    const [upload, setUpload] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const dialog = useRef<HTMLDialogElement>(null), reading = useRef(0), applied = useRef(false);
    const reason = check() || unavailable(model, file, group);
    useLayoutEffect(() => {
        const element = dialog.current!; element.showModal();
        return () => { ++reading.current; element.close(); requestAnimationFrame(() => {
            if (getSessionAccess(model).state === 'open' && trigger.current?.isConnected && !trigger.current.closest('[hidden], [inert]')) trigger.current.focus();
        }); };
    }, []);
    const read = async (fileInput: File) => {
        const version = ++reading.current; setBusy(true); setError('');
        try {
            const data = await normalizeIcon(fileInput);
            if (version !== reading.current) return;
            const changed = check() || unavailable(model, file, group); if (changed) throw new Error(changed);
            setUpload(data); setIcon('upload');
        } catch (failure) { if (version === reading.current) setError(t(failure instanceof Error ? failure.message : 'Could not read the image.')); }
        finally { if (version === reading.current) setBusy(false); }
    };
    const apply = () => {
        const changed = check() || unavailable(model, file, group);
        if (busy || applied.current || changed) { if (changed) setError(changed); return; }
        const [kind, value] = icon.split(':');
        if ((kind === 'custom' && !file.db.meta.customIcons.has(value)) || (kind === 'builtin' && !ENTRY_ICONS[Number(value)]) || (kind === 'upload' && !upload)) {
            setError(t('Choose an available icon.')); return;
        }
        applied.current = true;
        if (kind === 'upload') group.setCustomIcon(file.addCustomIcon(upload));
        else if (kind === 'custom' && group.customIconId !== value) group.setCustomIcon(value);
        else if (kind === 'builtin' && (group.customIconId || group.iconId !== Number(value))) group.setIcon(Number(value));
        Events.emit('refresh'); close();
    };
    return <dialog ref={dialog} class="entry-appearance" aria-label={t('Group icon')} onCancel={event => { event.preventDefault(); close(); }}>
        <h2>{t('Group icon')}</h2><p style={{ overflowWrap: 'anywhere' }}>{t('Group: {}', group.title)}</p>
        <div class="entry-appearance__scroll">
            <IconChoices value={icon} customIcons={file.getCustomIcons()} disabled={busy || !!reason} onChange={setIcon} onUpload={image => void read(image)} />
            <p>{t('Choose a built-in icon to remove this group’s custom icon. Existing entries and other groups keep their icons.')}</p>
            {icon === 'upload' && upload && <img class="entry-appearance__preview" src={`data:image/png;base64,${upload}`} alt={t('New icon preview')} />}
            {(reason || error) && <p role="alert">{reason || error}</p>}{busy && <p role="status">{t('Reading image…')}</p>}
        </div>
        <div class="entry-appearance__actions"><button type="button" class="pill" onClick={close}>{t('Cancel')}</button>
            <button type="button" class="pill pill--primary" disabled={busy || !!reason} onClick={apply}>{t('Apply group icon')}</button></div>
    </dialog>;
}
