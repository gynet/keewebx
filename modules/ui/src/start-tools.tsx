import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { AppModel } from 'models/app-model';
import { getSessionAccess } from 'comp/app/session-access';
import { VaultApi } from 'comp/app/vault-api';
import { PasswordGeneratorPanel } from './password-generator';
import { PromptDialog } from './extension-prompts';
import { t } from './i18n';
import { commandKey, editingText } from './keyboard';
import { shortcutKeys } from './keyboard-shortcuts';

export function StartTools({ model, beforeOpen, disabled, onSettings }: { model: AppModel; beforeOpen: () => void; disabled: boolean; onSettings?: () => void }) {
    const root = useRef<HTMLDivElement>(null);
    const [tool, setTool] = useState<'generator'>();
    const [message, setMessage] = useState('');
    const access = getSessionAccess(model);
    const open = (next: 'generator') => {
        if (disabled || access.state !== 'open' || model.files.hasOpenFiles()
            || !model.settings.canOpenGenerator) return;
        beforeOpen(); setMessage(''); setTool(next);
    };
    useLayoutEffect(() => {
        const keydown = (event: KeyboardEvent) => {
            if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat || disabled
                || !commandKey(event) || event.shiftKey || event.altKey || editingText(event.target)
                || access.state !== 'open' || model.files.hasOpenFiles() || document.querySelector('dialog[open]')
                || !root.current?.closest('.start')?.getClientRects().length || root.current.closest('[hidden], [inert]')) return;
            if (event.key.toLowerCase() === shortcutKeys.generator && model.settings.canOpenGenerator) {
                event.preventDefault(); open('generator');
            } else if (event.key === shortcutKeys.settings && onSettings && model.settings.canOpenSettings) {
                event.preventDefault(); beforeOpen(); onSettings();
            }
        };
        window.addEventListener('keydown', keydown);
        return () => window.removeEventListener('keydown', keydown);
    });
    const copy = async (password: string) => {
        const epoch = access.epoch;
        try {
            access.assertOpen(epoch);
            if (!model.settings.canOpenGenerator || model.files.hasOpenFiles()) return;
            await navigator.clipboard.writeText(password);
            VaultApi.copied({ text: password, password: false, sessionEpoch: epoch });
            access.assertOpen(epoch); setMessage(t('Copied'));
        } catch { setMessage(t('Could not copy. Reveal the password and copy it manually.')); }
    };
    return <div ref={root} class="start-flow-tools">
        {model.settings.canOpenGenerator && <button type="button" class="link" disabled={disabled} onClick={() => open('generator')}>{t('Password generator')}</button>}
        {tool === 'generator' && model.settings.canOpenGenerator && <PromptDialog title={t('Generate password')} icon="key" cancel={() => setTool(undefined)}>
            <PasswordGeneratorPanel actionLabel={t('Copy password')} onUse={password => void copy(password)} onClose={() => setTool(undefined)} />
            {message && <p role="status">{message}</p>}
        </PromptDialog>}
    </div>;
}
