import { useEffect, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import { backupProviders, readBackup, storeBackup, validateBackup, type BackupSettings } from 'comp/app/vault-backup';
import { exportVault, waitForSync } from 'comp/app/vault-files';
import { getSessionAccess } from 'comp/app/session-access';
import { beginPendingOperation, waitForPendingOperations } from './pending-operations';
import { hasPendingDrafts, usePendingDraft } from './pending-drafts';
import { t } from './i18n';

const configuration = (value: BackupSettings) => JSON.stringify([value.enabled, value.storage, value.path, value.schedule, value.opts]);
export function DatabaseBackup({ model, file, disabled = false }: { model: AppModel; file: FileModel; disabled?: boolean }) {
    const initial = (): BackupSettings => ({ enabled: false, storage: backupProviders()[0]?.[0] ?? '',
        path: `Backups/${file.name.replace(/[\\/:*?"<>|]/g, '_')}.{date}.kdbx`, schedule: '', ...readBackup(file) });
    const [draft, setDraft] = useState(initial), [baseline, setBaseline] = useState(() => configuration(readBackup(file)));
    const [dirty, setDirty] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
    const [, refresh] = useState(0);
    const operation = useRef<AbortController>(), mounted = useRef(true);
    const access = getSessionAccess(model);
    const available = () => mounted.current && file.active && !file.demo && model.files.get(file.id) === file
        && access.state === 'open' && model.settings.canSaveTo && !(file as FileModel & { readOnly?: boolean }).readOnly;
    useEffect(() => {
        const changed = () => refresh(value => value + 1);
        file.on('change:backup', changed);
        const off = access.subscribeInvalidation(() => operation.current?.abort());
        return () => { mounted.current = false; operation.current?.abort(); file.off('change:backup', changed); off(); };
    }, []);
    const reset = () => { setDraft(initial()); setBaseline(configuration(readBackup(file))); setDirty(false); setMessage(''); };
    const change = (values: Partial<BackupSettings>) => { setDraft({ ...draft, ...values }); setDirty(true); setMessage(''); };
    const apply = () => {
        try {
            if (disabled || busy || !available()) throw new Error('The vault is unavailable for backup changes.');
            if (configuration(readBackup(file)) !== baseline) throw new Error('Backup settings changed. Cancel to reload them.');
            validateBackup(draft);
            const destinationChanged = readBackup(file).storage !== draft.storage || readBackup(file).path !== draft.path;
            const next = { ...readBackup(file), ...draft };
            if (destinationChanged) { delete next.lastTime; delete next.lastError; next.pending = false; }
            storeBackup(model, file.id, next);
            setDraft({ ...readBackup(file) }); setBaseline(configuration(readBackup(file))); setDirty(false);
            setMessage(t('Backup settings saved on this device.'));
            return true;
        } catch (error) { setMessage(t((error as Error).message)); return false; }
    };
    usePendingDraft(dirty, apply, reset, 'database-backup', file.id);
    const run = async () => {
        if (operation.current || disabled || !available()) return;
        if (dirty || hasPendingDrafts(file.id)) { setMessage(t('Apply or discard unsaved edits before backing up.')); return; }
        try { validateBackup(readBackup(file)); } catch (error) { setMessage(t((error as Error).message)); return; }
        if (!readBackup(file).enabled) return;
        if (!window.confirm(t('Write an encrypted backup to the configured destination? An existing file at that path may be replaced.'))) return;
        const controller = new AbortController(); operation.current = controller;
        const epoch = access.epoch, db = file.db, config = configuration(readBackup(file));
        const current = () => available() && access.isCurrent(epoch) && file.db === db && !controller.signal.aborted
            && config === configuration(readBackup(file)) && !hasPendingDrafts(file.id);
        const timeout = setTimeout(() => controller.abort(), 30_000);
        let finish: (() => void) | undefined;
        setBusy(true); setMessage('');
        try {
            await waitForPendingOperations(model, controller.signal, file.id); await waitForSync(file, controller.signal);
            if (!current() || hasPendingDrafts(file.id)) throw new Error('The vault changed. Apply or discard edits and retry.');
            finish = beginPendingOperation(model, file.id);
            const data = await exportVault(file);
            if (!current() || hasPendingDrafts(file.id)) throw new Error('The vault changed during export. Retry backing up.');
            await new Promise<void>((resolve, reject) => model.backupFile(file, data, error => error ? reject(error) : resolve(),
                { signal: controller.signal, canPublish: current }));
            if (current()) setMessage(t('Encrypted backup completed. The primary vault save is unchanged.'));
        } catch (error) {
            if (mounted.current) setMessage(controller.signal.aborted
                ? t('Backup canceled or timed out. A remote copy may exist; check the destination before retrying.')
                : t(error instanceof Error ? error.message : 'Backup failed. The primary vault save is unchanged. Check the destination before retrying.'));
        } finally { clearTimeout(timeout); finish?.(); operation.current = undefined; if (mounted.current) setBusy(false); }
    };
    const providers = backupProviders(), configured = readBackup(file);
    const supported = providers.some(([name]) => name === draft.storage);
    return <section class="cardlist database-backup" aria-label={t('Encrypted backups: {}', file.name)}>
        <h3 style={{ overflowWrap: 'anywhere' }}>{t('Encrypted backups: {}', file.name)}</h3>
        <p>{t('Backups copy encrypted KDBX bytes to a supported provider. They do not change the primary save destination. Settings are stored on this device.')}</p>
        {!providers.length && <p>{t('No enabled provider supports backups in this installation. Download KDBX remains available when export is allowed.')}</p>}
        {configured.storage && !providers.some(([name]) => name === configured.storage) && <p>{t('Configured backup provider unavailable: {}. The configuration is retained.', configured.storage)}</p>}
        <fieldset disabled={disabled || busy || !available()} style={{ minWidth: 0 }}>
            <label><input type="checkbox" checked={!!draft.enabled} disabled={!providers.length && !draft.enabled}
                onChange={event => change({ enabled: event.currentTarget.checked })} />{t('Enable backups')}</label>
            <label class="field-label">{t('Backup provider')}
                <select class="input" aria-label={t('Backup provider')} value={draft.storage} disabled={!providers.length} onChange={event => change({ storage: event.currentTarget.value, opts: undefined })}>
                    {!supported && <option value={draft.storage}>{draft.storage || t('Unavailable')}</option>}
                    {providers.map(([name]) => <option value={name}>{name}</option>)}
                </select>
            </label>
            <label class="field-label">{t('Backup path')}<input class="input" value={draft.path} disabled={!supported} onInput={event => change({ path: event.currentTarget.value })} /></label>
            <p>{t('Use {date} for a timestamped name. A fixed path may replace the previous backup.')}</p>
            <label class="field-label">{t('Backup schedule')}<select class="input" aria-label={t('Backup schedule')} value={draft.schedule ?? ''} disabled={!supported} onChange={event => change({ schedule: event.currentTarget.value })}>
                <option value="">{t('Manual only')}</option><option value="0">{t('Every successful save')}</option>
                <option value="1d">{t('Daily')}</option><option value="1w">{t('Weekly')}</option><option value="1m">{t('Monthly')}</option>
                {draft.schedule && !['0', '1d', '1w', '1m'].includes(draft.schedule) && <option value={draft.schedule}>{t('Unsupported schedule: {}', draft.schedule)}</option>}
            </select></label>
            <p>{t('Scheduled backups run after a successful save, or when reopening a vault with pending backup changes. The app must be open; this is not an unattended background timer.')}</p>
            <div class="database-settings__actions">
                <button type="button" class="pill" disabled={!dirty} onClick={apply}>{t('Save backup settings')}</button>
                <button type="button" class="pill" disabled={!dirty} onClick={reset}>{t('Cancel backup changes')}</button>
                <button type="button" class="pill" disabled={dirty || !configured.enabled || !providers.some(([name]) => name === configured.storage)} onClick={() => void run()}>{t('Back up now')}</button>
            </div>
        </fieldset>
        {busy && <button type="button" class="pill" onClick={() => operation.current?.abort()}>{t('Cancel backup')}</button>}
        <p>{configured.lastTime ? t('Last completed backup: {}', new Date(configured.lastTime).toLocaleString()) : t('No completed backup recorded.')}</p>
        {configured.pending && <p>{t('Changes are waiting for backup.')}</p>}
        {configured.lastError && <p role="alert">{t(configured.lastError)}</p>}
        {message && <p role="status">{message}</p>}
    </section>;
}
