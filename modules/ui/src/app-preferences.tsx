import { useEffect, useState } from 'preact/hooks';
import { AppSettingsModel as settings } from 'models/app-settings-model';
import { Events } from 'framework/events';
import { IdleTracker } from 'comp/browser/idle-tracker';
import { Links } from 'const/links';
import { RuntimeInfo } from 'const/runtime-info';
import { t } from './i18n';
import './app-preferences.css';

export function usePreferences() {
    const [, render] = useState(0);
    useEffect(() => {
        const changed = () => render(n => n + 1);
        settings.on('change', changed);
        return () => settings.off('change', changed);
    }, []);
    return settings;
}

export function PreferenceCheck({ name, label, disabled = false }: { name: string; label: string; disabled?: boolean }) {
    const values = usePreferences() as unknown as Record<string, unknown>;
    return <label class="cardlist__row" for={`setting-${name}`}>
        <span>{t(label)}</span><input id={`setting-${name}`} type="checkbox" checked={values[name] === true} disabled={disabled}
            onChange={e => { values[name] = e.currentTarget.checked; Events.emit('refresh'); }} />
    </label>;
}

export function PreferenceSelect({ name, label, options, disabled = false, id }: {
    name: string; label: string; options: readonly (readonly [number | string, string])[]; disabled?: boolean; id?: string;
}) {
    const values = usePreferences() as unknown as Record<string, unknown>;
    const value = values[name];
    return <label class="cardlist__row" for={id ?? `setting-${name}`}><span>{t(label)}</span>
        <select id={id ?? `setting-${name}`} class="plain-select" value={String(value)} disabled={disabled} onChange={e => {
            values[name] = typeof options[0][0] === 'number' ? Number(e.currentTarget.value) : e.currentTarget.value;
            Events.emit('refresh');
        }}>
            {!options.some(([v]) => String(v) === String(value)) && <option value={String(value)}>{t('Current: {}', String(value))}</option>}
            {options.map(([v, text]) => <option key={v} value={v}>{t(text)}</option>)}
        </select></label>;
}

export function IdlePreference() {
    return <PreferenceSelect name="idleMinutes" id="setting-auto-lock" label="Auto-lock" options={[
        [0, 'Never'], [5, '5 minutes'], [10, '10 minutes'], [15, '15 minutes'], [30, '30 minutes'],
        [60, '1 hour'], [180, '3 hours'], [360, '6 hours'], [720, '12 hours'], [1440, '24 hours']]} />;
}

export function AppearancePreferences() {
    return <div class="cardlist app-preferences">
        <PreferenceSelect name="fontSize" label="Text size" options={[[0, 'Normal'], [1, 'Large'], [2, 'Largest']]} />
        <PreferenceCheck name="expandGroups" label="Include entries from subgroups" />
        <PreferenceCheck name="colorfulIcons" label="Colorful custom icons" />
        <PreferenceCheck name="largeListIcons" label="Large list icons" />
        <PreferenceCheck name="showFavicons" label="Show website icons" />
        <p class="general-preferences__help">{t('Website icons send website hostnames to DuckDuckGo. Custom vault icons take priority.')}</p>
        <PreferenceSelect name="tagStyle" label="Tag style" options={[['cloud', 'Pills'], ['dot', 'Dots']]} />
        <PreferenceCheck name="useGroupIconForEntries" label="Use group icon for new entries" />
    </div>;
}

export function SaveVerificationPreference() {
    return <div class="cardlist app-preferences">
        <PreferenceCheck name="saveVerify" label="Verify saves" />
        <p class="general-preferences__help">{t('Recommended: reopen encrypted bytes before reporting a successful save. Turning this off removes that check.')}</p>
    </div>;
}

export function AuditPreferences() {
    const values = usePreferences();
    return <section aria-label={t('Password audit')} class="app-preferences">
        <h2 class="group-title">{t('Password audit')}</h2>
        <div class="cardlist">
            <PreferenceCheck name="auditPasswords" label="Check passwords for issues" />
            <PreferenceCheck name="auditPasswordEntropy" label="Warn about weak passwords" disabled={!values.auditPasswords} />
            <PreferenceCheck name="excludePinsFromAudit" label="Exclude PINs of up to six digits" disabled={!values.auditPasswords} />
            <PreferenceSelect name="auditPasswordAge" label="Warn about password age" disabled={!values.auditPasswords} options={[
                [0, 'Off'], [1, '1 year'], [2, '2 years'], [3, '3 years'], [5, '5 years'], [10, '10 years']]} />
            <PreferenceCheck name="checkPasswordsOnHIBP" label="Check Have I Been Pwned" disabled={!values.auditPasswords} />
            <details class="preference-help"><summary>{t('How online password checks work')}</summary>
                <p>{t('Online checks are off by default. If you opt in, only the first five characters of a password’s SHA-1 hash are sent to the Pwned Passwords service. The password and full hash stay on this device. Your IP address is visible to the service. Checks run when you view an eligible entry.')}</p>
                <a href={Links.HaveIBeenPwnedPrivacy} target="_blank" rel="noopener noreferrer">{t('Have I Been Pwned privacy information')}</a>
            </details>
        </div>
    </section>;
}

/** App-wide preferences stay active while settings and the vault are mounted. */
export function PreferenceEffects() {
    const values = usePreferences();
    useEffect(() => {
        document.documentElement.dataset.textSize = String([0, 1, 2].includes(values.fontSize) ? values.fontSize : 0);
    }, [values.fontSize]);
    useEffect(() => {
        const activity = () => IdleTracker.regUserAction();
        for (const event of ['pointerdown', 'keydown', 'input', 'wheel']) document.addEventListener(event, activity, { passive: true });
        return () => { for (const event of ['pointerdown', 'keydown', 'input', 'wheel']) document.removeEventListener(event, activity); };
    }, []);
    return null;
}

export function PreferencesHelp() {
    return <details class="preference-help app-preferences">
        <summary>{t('Help and about KeeWebX')}</summary>
        <p>{t('Vaults use the encrypted KeePass KDBX format. Keep your master password and key file safe, and download backups regularly.')}</p>
        <p><a href="https://keepass.info/help/base/" target="_blank" rel="noopener noreferrer">{t('KeePass format and help')}</a></p>
        <p>{t('Version')}: {RuntimeInfo.version} · {RuntimeInfo.buildDate}{RuntimeInfo.commit && <> · {RuntimeInfo.commit}</>}</p>
        <p><a href={Links.Releases} target="_blank" rel="noopener noreferrer">{t('Release history')}</a> · <a href={Links.Repo} target="_blank" rel="noopener noreferrer">{t('Source code')}</a> · <a href={Links.License} target="_blank" rel="noopener noreferrer">{t('MIT license')}</a> · <a href={`${Links.Repo}/blob/master/THIRD-PARTY-LICENSES.md`} target="_blank" rel="noopener noreferrer">{t('Third-party licenses')}</a></p>
        <p>{t('Keyboard: Tab and Shift+Tab move between controls. Enter or Space activates buttons. Use Left/Right, Home and End to navigate settings tabs. Escape closes dialogs.')}</p>
    </details>;
}
