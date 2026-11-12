import { useEffect, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import { AppSettingsModel } from 'models/app-settings-model';
import { Events } from 'framework/events';
import { getSessionAccess } from 'comp/app/session-access';
import { waitForSync } from 'comp/app/vault-files';
import { beginPendingOperation, waitForPendingOperations } from './pending-operations';
import { savePendingDrafts } from './pending-drafts';
import { t } from './i18n';
import './general-preferences.css';

const INTERVALS: [number, string][] = [
    [0, 'Off'], [-1, 'On every change'], [1, '1 minute'], [5, '5 minutes'],
    [15, '15 minutes'], [30, '30 minutes'], [60, '1 hour']
];

/** Browser preferences use the same persisted settings and writers as Classic. */
export function GeneralPreferences({ model }: { model: AppModel }) {
    const [, render] = useState(0);
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState('');
    const [failed, setFailed] = useState(false);
    const operation = useRef<AbortController | null>(null);
    const mounted = useRef(true);
    const access = getSessionAccess(model);
    useEffect(() => {
        mounted.current = true;
        const refresh = () => render((value) => value + 1);
        AppSettingsModel.on('change', refresh);
        const unsubscribe = access.subscribeInvalidation(() => {
            operation.current?.abort();
            setMessage('');
            setFailed(false);
        });
        return () => {
            mounted.current = false;
            operation.current?.abort();
            unsubscribe();
            AppSettingsModel.off('change', refresh);
        };
    }, [model]);
    const change = (action: () => void) => {
        if (access.state !== 'open' || operation.current) return;
        action();
    };
    const save = async () => {
        if (operation.current || access.state !== 'open') return;
        const controller = new AbortController();
        operation.current = controller;
        const epoch = access.epoch;
        const targets = model.files.filter((file) => file.active && !file.demo).map((file) => ({ file, db: file.db }));
        const current = () => mounted.current && !controller.signal.aborted && access.state === 'open' && access.epoch === epoch;
        const check = (checkDatabase = true) => {
            access.assertOpen(epoch);
            if (!current() || targets.some(({ file, db }) => !file.active || model.files.get(file.id) !== file ||
                (checkDatabase && file.db !== db))) throw new Error('The open vaults changed. Review them before saving again.');
        };
        setBusy(true); setMessage(''); setFailed(false);
        let finish: (() => void) | undefined;
        try {
            // Drain existing attachment/credential operations before registering our own.
            await waitForPendingOperations(model, controller.signal);
            await Promise.all(targets.map(({ file }) => waitForSync(file, controller.signal)));
            check();
            try { savePendingDrafts(); }
            catch { throw new Error('Apply or discard invalid or credential edits before saving.'); }
            check();
            finish = beginPendingOperation(model);
            const results: string[] = [];
            let needsRetry = false;
            for (const { file, db } of targets) {
                check(false);
                if (file.db !== db) throw new Error('The open vaults changed. Review them before saving again.');
                if ((file as unknown as { readOnly?: boolean }).readOnly) {
                    results.push(t('{}: read-only; skipped.', file.name));
                    continue;
                }
                try {
                    await new Promise<void>((resolve, reject) => model.syncFile(file, undefined,
                        (error) => error ? reject(error) : resolve()));
                    check(false);
                    if (file.modified || file.dirty) {
                        needsRetry = true;
                        results.push(t('{}: changes remain to be saved. Retry when ready.', file.name));
                    } else {
                        results.push(file.storage ? t('{}: synchronized.', file.name) :
                            t('{}: saved in this browser. Download a copy to keep an external backup.', file.name));
                    }
                } catch {
                    check(false);
                    needsRetry = true;
                    results.push(t('{}: could not synchronize. Your changes remain open; retry when ready.', file.name));
                }
            }
            if (current()) {
                setFailed(needsRetry);
                setMessage(results.join('\n') || t('No writable vaults are open.'));
            }
        } catch (error) {
            if (current()) {
                setFailed(true);
                setMessage(error instanceof Error ? t(error.message) : t('Could not save. Retry when ready.'));
            }
        } finally {
            finish?.();
            if (operation.current === controller) operation.current = null;
            if (mounted.current) setBusy(false);
        }
    };
    const remember = AppSettingsModel.rememberKeyFiles;
    return <section class="general-preferences" aria-label={t('Saving and content')}>
        <h2 class="group-title">{t('Saving and content')}</h2>
        <div class="cardlist">
            <label class="cardlist__row" for="setting-auto-save">
                <span>{t('Auto-save and sync')}</span>
                <select id="setting-auto-save" class="plain-select" value={String(AppSettingsModel.autoSaveInterval)} disabled={busy}
                    onChange={(event) => change(() => {
                        AppSettingsModel.autoSaveInterval = Number(event.currentTarget.value);
                        if (AppSettingsModel.autoSaveInterval === -1) model.syncScheduler.retryAll();
                    })}>
                    {INTERVALS.map(([value, label]) => <option value={value}>{t(label)}</option>)}
                </select>
            </label>
            <p class="general-preferences__help">{t('Timed sync also checks for changes from other devices. Off stops automatic sync; locking still saves open changes.')}</p>
            <div class="cardlist__row">
                <span>{t('Save all open vaults')}</span>
                <button type="button" class="pill" disabled={busy || !model.files.some((file) => file.active && !file.demo)} onClick={save}>
                    {busy ? t('Saving…') : failed ? t('Retry save') : t('Save now')}
                </button>
            </div>
            {message && <p class="general-preferences__help" role="status">{message}</p>}
            <label class="cardlist__row" for="setting-remember-key-files">
                <span>{t('Remember key files')}</span>
                <select id="setting-remember-key-files" class="plain-select" value={remember === 'data' ? 'data' : remember === 'path' ? 'path' : 'none'} disabled={busy}
                    onChange={(event) => change(() => {
                        AppSettingsModel.set({ rememberKeyFiles: event.currentTarget.value === 'data' ? 'data' : false });
                        model.clearStoredKeyFiles();
                    })}>
                    {remember === 'path' && <option value="path" disabled>{t('Path (unavailable)')}</option>}
                    <option value="none">{t('Do not remember')}</option>
                    <option value="data">{t('Remember data')}</option>
                </select>
            </label>
            <p class="general-preferences__help">{t('Changing this clears remembered key files for all recent vaults. Remember data stores key material in this browser so you do not need to select the key file again.')}
                {remember === 'path' && <> {t('Your existing path preference is unchanged. Browsers cannot reopen key files by path; choose an option above.')}</>}</p>
            <label class="cardlist__row" for="setting-markdown">
                <span>{t('Render Markdown in notes')}</span>
                <input id="setting-markdown" type="checkbox" checked={AppSettingsModel.useMarkdown} disabled={busy}
                    onChange={(event) => change(() => {
                        AppSettingsModel.useMarkdown = event.currentTarget.checked;
                        Events.emit('refresh');
                    })} />
            </label>
        </div>
    </section>;
}
