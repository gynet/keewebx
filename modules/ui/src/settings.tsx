/** Settings: interface choice and security. Classic keeps its own full settings. */
import { useState } from 'preact/hooks';
import { AppSettingsModel } from 'models/app-settings-model';
import { Icon } from 'ui-kit/mark';
import { t } from './i18n';
import { ThemeToggle, ThemeSelect } from './theme';
import type { AppModel } from 'models/app-model';
import { DatabaseSettingsEditor } from './database-settings';
import { confirmDiscardDrafts, discardPendingDrafts } from './pending-drafts';

const settings = AppSettingsModel as unknown as Record<string, unknown>;

const AUTO_LOCK: [number, string][] = [
    [5, '5 minutes'],
    [15, '15 minutes'],
    [30, '30 minutes'],
    [60, '1 hour'],
    [0, 'Never']
];
const CLEAR_CLIPBOARD: [number, string][] = [
    [0, 'Never'],
    [10, '10 seconds'],
    [30, '30 seconds'],
    [60, '1 minute']
];

/** Switches to the Classic interface; it opens the same vaults. */
export function switchToClassic(): void {
    if (!confirmDiscardDrafts()) return;
    settings.ui = 'classic';
    location.href = 'index.html';
}

export function Settings({ onBack, model }: { onBack: () => void; model: AppModel }) {
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
            <main class="settings">
                <div class="settings__inner">
                    <div class="settings__titlebar">
                        <button class="round settings__phone-back" aria-label={t('Back to vault')} onClick={onBack}>
                            <Icon name="back" />
                        </button>
                        <h1 class="settings__title">{t('Settings')}</h1>
                        <ThemeToggle />
                    </div>

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
                                <button role="radio" aria-checked="false" id="use-classic" onClick={switchToClassic}>
                                    {t('Classic')}
                                </button>
                            </div>
                        </div>
                        <div class="cardlist__row">
                            <span>{t('Theme')}</span>
                            <ThemeSelect />
                        </div>
                    </section>

                    <h2 class="group-title">{t('Security')}</h2>
                    <section class="cardlist">
                        <label class="cardlist__row">
                            <span title={t('Locks after this long without use')}>{t('Auto-lock')}</span>
                            <select
                                class="plain-select"
                                id="setting-auto-lock"
                                value={String(settings.idleMinutes)}
                                onChange={(e) => set('idleMinutes', Number(e.currentTarget.value))}
                            >
                                {AUTO_LOCK.map(([v, label]) => (
                                    <option value={v}>{t(label)}</option>
                                ))}
                            </select>
                        </label>
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
                    </section>
                    <h2 class="group-title">{t('Database settings')}</h2>
                    {model.files.map((file) => <DatabaseSettingsEditor key={file.id} model={model} file={file}
                        onCancel={() => { discardPendingDrafts('database'); onBack(); }} />)}
                </div>
            </main>
        </div>
    );
}
