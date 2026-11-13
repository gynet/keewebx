import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import { getSessionAccess } from 'comp/app/session-access';
import { saveVault, waitForSync } from 'comp/app/vault-files';
import { VaultApi } from 'comp/app/vault-api';
import { IdleTracker } from 'comp/browser/idle-tracker';
import { beginPendingOperation, waitForPendingOperations } from './pending-operations';
import { savePendingDrafts } from './pending-drafts';
import { commandKey, editingText, keyboardAvailable } from './keyboard';
import { PasswordGeneratorPanel } from './password-generator';
import { PromptDialog } from './extension-prompts';
import { t } from './i18n';
import { shortcutKeys } from './keyboard-shortcuts';

export function useVaultCommands(model: AppModel, surface: { current: HTMLElement | null }, actions: {
    open: () => void; settings: () => void; lock: () => void;
}) {
    const saving = useRef(false);
    const [message, setMessage] = useState('');
    const [generator, setGenerator] = useState(false);
    const [copyMessage, setCopyMessage] = useState('');
    const access = getSessionAccess(model);
    useEffect(() => access.subscribeInvalidation(() => {
        setMessage(''); setGenerator(false); setCopyMessage('');
    }), [model]);
    const save = async () => {
        if (saving.current || access.state !== 'open') return;
        saving.current = true;
        const epoch = access.epoch;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15_000);
        let finish: (() => void) | undefined;
        setMessage(t('Saving…'));
        try {
            await waitForPendingOperations(model, controller.signal);
            await Promise.all(model.files.map(file => waitForSync(file, controller.signal)));
            access.assertOpen(epoch);
            if (controller.signal.aborted) throw new Error('Save timed out');
            savePendingDrafts();
            finish = beginPendingOperation(model);
            for (const file of [...model.files]) {
                access.assertOpen(epoch);
                if (file.active && !file.demo && !(file as typeof file & { readOnly?: boolean }).readOnly) await saveVault(model, file);
            }
            access.assertOpen(epoch);
            setMessage(t('Saved. Check each vault’s sync status for remote changes.'));
        } catch {
            if (access.state === 'open' && access.isCurrent(epoch)) setMessage(t('Could not save. Resolve invalid fields or storage errors, then try again. Your changes remain open.'));
        } finally { clearTimeout(timeout); finish?.(); saving.current = false; }
    };
    useLayoutEffect(() => {
        const keydown = (event: KeyboardEvent) => {
            // The locked start screen has its own visible file picker, without a
            // vault surface. Never resolve this route through retained recovery UI.
            if (!model.files.hasOpenFiles() && access.state === 'open' && !event.defaultPrevented
                && !event.isComposing && event.keyCode !== 229 && !event.repeat && commandKey(event)
                && !event.altKey && !event.shiftKey && event.key.toLowerCase() === shortcutKeys.open && !editingText(event.target)
                && !document.querySelector('dialog[open]') && model.settings.canOpen !== false) {
                const input = document.querySelector<HTMLInputElement>('#open-file-input');
                const start = input?.closest<HTMLElement>('.start');
                if (input && !input.disabled && start?.getClientRects().length && !start.closest('[hidden], [inert]')) {
                    event.preventDefault(); IdleTracker.regUserAction(); input.click();
                }
                return;
            }
            if (!keyboardAvailable(model, surface.current, event) || !commandKey(event) || event.altKey || event.shiftKey) return;
            const key = event.key.toLowerCase();
            if (![shortcutKeys.save, shortcutKeys.lock, shortcutKeys.open, shortcutKeys.generator, shortcutKeys.settings].includes(key as never)) return;
            if (key === shortcutKeys.generator && !model.settings.canOpenGenerator) return;
            if (key === shortcutKeys.settings && !model.settings.canOpenSettings) return;
            // Saving and securing intentionally apply pending drafts. Navigation
            // shortcuts leave a focused editor and its native keys alone.
            if (![shortcutKeys.save, shortcutKeys.lock].includes(key as never) && (editingText(event.target) || hasEditor())) return;
            event.preventDefault();
            IdleTracker.regUserAction();
            if (key === shortcutKeys.save) void save();
            else if (key === shortcutKeys.lock) actions.lock();
            else if (key === shortcutKeys.open) actions.open();
            else if (key === shortcutKeys.settings) actions.settings();
            else { setCopyMessage(''); setGenerator(true); }
        };
        const hasEditor = () => !!surface.current?.querySelector('.entry-editor, .notes__edit');
        window.addEventListener('keydown', keydown);
        return () => window.removeEventListener('keydown', keydown);
    });
    const copy = async (password: string) => {
        const epoch = access.epoch;
        try {
            access.assertOpen(epoch);
            if (!model.settings.canOpenGenerator) return;
            await navigator.clipboard.writeText(password);
            VaultApi.copied({ text: password, password: false, sessionEpoch: epoch });
            access.assertOpen(epoch);
            setCopyMessage(t('Copied'));
        } catch { if (access.state === 'open') setCopyMessage(t('Could not copy. Reveal the password and copy it manually.')); }
    };
    return {
        save: () => void save(), generator: () => { if (model.settings.canOpenGenerator) { setCopyMessage(''); setGenerator(true); } },
        content: <>
            {message && <div class="command-status" role="status">{message} <button type="button" class="link" onClick={() => setMessage('')}>{t('Dismiss')}</button></div>}
            {generator && model.settings.canOpenGenerator && <PromptDialog title={t('Generate password')} icon="key" cancel={() => setGenerator(false)}>
                <PasswordGeneratorPanel actionLabel={t('Copy password')} onUse={password => void copy(password)} onClose={() => setGenerator(false)} />
                {copyMessage && <p role="status">{copyMessage}</p>}
            </PromptDialog>}
        </>
    };
}
