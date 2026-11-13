/** Settings: interface choice and security. Classic keeps its own full settings. */
import { useEffect, useRef, useState } from 'preact/hooks';
import { AppSettingsModel } from 'models/app-settings-model';
import { Icon } from 'ui-kit/mark';
import { t } from './i18n';
import { ThemeToggle, ThemeSelect } from './theme';
import { ClipboardLockSetting } from './clipboard-lock-setting';
import type { FileModel } from 'models/file-model';
import type { AppModel } from 'models/app-model';
import { ImportVault } from './import-vault';
import { DatabaseSettingsEditor } from './database-settings';
import { ExtensionSessions, type ExtensionSessionsApi } from './extension-sessions';
import { discardPendingDrafts } from './pending-drafts';
import { GeneralPreferences } from './general-preferences';
import { ClassicSwitch } from './classic-switch';
import { StoragePreferences } from './storage-preferences';
import { IdlePreference, AppearancePreferences, SaveVerificationPreference, AuditPreferences, PreferencesHelp } from './app-preferences';
import { ProviderPreferences } from './provider-preferences';

const settings = AppSettingsModel as unknown as Record<string, unknown>;

const CLEAR_CLIPBOARD: [number, string][] = [
    [0, 'Never'],
    [10, '10 seconds'],
    [30, '30 seconds'],
    [60, '1 minute']
];

const SECTIONS = [
    ['appearance', 'Appearance'], ['security', 'Security'], ['saving', 'Saving and content'],
    ['database', 'Database'], ['extensions', 'Browser extension']
] as const;
export type SettingsSection = typeof SECTIONS[number][0];

export function Settings({ onBack, model, extensionSessions, initialSection = 'appearance', passkeyVaultId, onCloseVault }: {
    onBack: () => void; model: AppModel; extensionSessions?: ExtensionSessionsApi; initialSection?: SettingsSection; passkeyVaultId?: string; onCloseVault?(file: FileModel): void;
}) {
    const [section, setSection] = useState<SettingsSection>(initialSection);
    const content = useRef<HTMLElement>(null);
    const select = (next: SettingsSection, focus = false) => {
        setSection(next);
        content.current?.scrollTo({ top: 0 });
        if (focus) document.getElementById(`settings-tab-${next}`)?.focus();
    };
    const showPasskey = (id: string) => {
        select('database');
        requestAnimationFrame(() => {
            const target = Array.from(content.current?.querySelectorAll<HTMLElement>('.database-passkey') ?? [])
                .find((element) => element.dataset.vaultId === id);
            target?.scrollIntoView({ block: 'start' }); target?.focus({ preventScroll: true });
        });
    };
    useEffect(() => { if (passkeyVaultId) showPasskey(passkeyVaultId); }, [passkeyVaultId]);
    const [, rerender] = useState(0);
    const set = (key: string, value: unknown) => {
        settings[key] = value;
        rerender((n) => n + 1);
    };

    return (
        <div class="vault">
            <nav class="side" aria-label={t('Settings')}>
                <button class="nav-row" id="settings-back" onClick={onBack}>
                    <Icon name="back" size={17} />
                    <span class="nav-row__label">{t('Back to vault')}</span>
                </button>
            </nav>
            <main class="settings" ref={content}>
                <div class="settings__inner">
                    <div class="settings__titlebar">
                        <button class="round settings__phone-back" aria-label={t('Back to vault')} onClick={onBack}>
                            <Icon name="back" />
                        </button>
                        <h1 class="settings__title">{t('Settings')}</h1>
                        <ThemeToggle />
                    </div>

                    <div class="settings__tabs" role="tablist" aria-label={t('Settings categories')}>
                        {SECTIONS.map(([id, label], index) => <button key={id} type="button" role="tab"
                            id={`settings-tab-${id}`} aria-controls={`settings-panel-${id}`}
                            aria-selected={section === id} tabIndex={section === id ? 0 : -1}
                            onClick={() => select(id)} onKeyDown={(event) => {
                                const next = event.key === 'ArrowRight' ? (index + 1) % SECTIONS.length
                                    : event.key === 'ArrowLeft' ? (index + SECTIONS.length - 1) % SECTIONS.length
                                    : event.key === 'Home' ? 0 : event.key === 'End' ? SECTIONS.length - 1 : -1;
                                if (next < 0) return;
                                event.preventDefault(); select(SECTIONS[next][0], true);
                            }}>{t(label)}</button>)}
                    </div>
                    {/* Keep editors mounted across tabs so unsaved drafts and lock guards stay intact. */}
                    <section id="settings-panel-appearance" role="tabpanel" aria-labelledby="settings-tab-appearance" hidden={section !== 'appearance'}>
                    <h2 class="group-title">{t('Appearance')}</h2>
                    <section class="cardlist">
                        <div class="cardlist__row">
                            <span title={t('Classic is the original layout. Your vaults and settings stay the same.')}>
                                {t('Interface')}
                            </span>
                            <div class="segmented" role="radiogroup" aria-label={t('Interface')}>
                                <button class="segmented--on" role="radio" aria-checked="true">
                                    {t('New')}
                                </button>
                                <ClassicSwitch model={model} />
                            </div>
                        </div>
                        <div class="cardlist__row">
                            <span>{t('Theme')}</span>
                            <ThemeSelect />
                        </div>
                    </section>
                    <AppearancePreferences />
                    <PreferencesHelp />
                    </section>
                    <section id="settings-panel-security" role="tabpanel" aria-labelledby="settings-tab-security" hidden={section !== 'security'}>
                    <h2 class="group-title">{t('Security')}</h2>
                    <section class="cardlist">
                        <IdlePreference />
                        <label class="cardlist__row">
                            <span title={t('Empties the clipboard after you copy a field')}>{t('Clear clipboard')}</span>
                            <select
                                class="plain-select"
                                id="setting-clipboard"
                                value={String(settings.clipboardSeconds)}
                                onChange={(e) => set('clipboardSeconds', Number(e.currentTarget.value))}
                            >
                                {CLEAR_CLIPBOARD.map(([v, label]) => (
                                    <option value={v}>{t(label)}</option>
                                ))}
                            </select>
                        </label>
                        <ClipboardLockSetting value={settings.lockOnCopy === true} onChange={value => set('lockOnCopy', value)} />
                    </section>
                    <AuditPreferences />
                    <h2 class="group-title">{t('Local passkey unlock')}</h2>
                    <section class="cardlist">
                        {model.files.map((file) => <button key={file.id} type="button" class="cardlist__row settings__shortcut"
                            onClick={() => showPasskey(file.id)}>
                            <span>{t('Set up or manage passkey unlock')} · {file.name}</span><Icon name="key" size={18} />
                        </button>)}
                    </section>
                    </section>
                    <section id="settings-panel-saving" role="tabpanel" aria-labelledby="settings-tab-saving" hidden={section !== 'saving'}>
                        <GeneralPreferences model={model} />
                        <StoragePreferences model={model} />
                        <SaveVerificationPreference />
                        <ProviderPreferences model={model} />
                    </section>
                    <section id="settings-panel-extensions" role="tabpanel" aria-labelledby="settings-tab-extensions" hidden={section !== 'extensions'}>
                        <ExtensionSessions model={model} api={extensionSessions} onBack={() => select('appearance')} />
                    </section>
                    <section id="settings-panel-database" role="tabpanel" aria-labelledby="settings-tab-database" hidden={section !== 'database'}>
                    <h2 class="group-title">{t('Database settings')}</h2>
                    <ImportVault model={model} />
                    {model.files.map((file) => <DatabaseSettingsEditor key={file.id} model={model} file={file} onClose={() => onCloseVault?.(file)}
                        onCancel={() => { discardPendingDrafts('database', file.id); if (model.files.length === 1) onBack(); }} />)}
                    </section>
                </div>
            </main>
        </div>
    );
}
