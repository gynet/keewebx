import { useState } from 'preact/hooks';
import { Links } from 'const/links';
import { PreferenceCheck } from './app-preferences';
import { t } from './i18n';

type Family = 'chrome' | 'edge' | 'firefox' | 'other';
export function extensionBrowser(userAgent: string): Family {
    return /Edg\//.test(userAgent) ? 'edge' : /Firefox\//.test(userAgent) ? 'firefox'
        : /Chrome\//.test(userAgent) ? 'chrome' : 'other';
}

export function ExtensionPreferences({ enabled }: { enabled: boolean }) {
    const [family, setFamily] = useState<Family>(() => extensionBrowser(navigator.userAgent));
    const mobile = /Android|iPhone|iPad|iPod/.test(navigator.userAgent);
    return <section class="app-preferences" aria-label={t('Browser extension setup')}>
        <h2 class="group-title">{t('Browser extension setup')}</h2>
        <details class="preference-help">
            <summary>{t('Install and connect KeeWebX Connect')}</summary>
            <p>{t('Download the extension package for your browser from KeeWebX releases. Store listings are not available yet.')}</p>
            <p><a href={Links.Releases} target="_blank" rel="noopener noreferrer">{t('Extension downloads')}</a> · <a href={`${Links.Repo}/tree/master/modules/extension#installation`} target="_blank" rel="noopener noreferrer">{t('Extension installation guide')}</a></p>
            <label class="vault-form__field">{t('Browser')}<select class="input" value={family} onChange={event => setFamily(event.currentTarget.value as Family)}>
                <option value="chrome">Chrome / Chromium</option><option value="edge">Microsoft Edge</option>
                <option value="firefox">Firefox</option><option value="other">{t('Other browser')}</option>
            </select></label>
            {mobile ? <p>{t('These installation steps are for desktop browsers. Mobile extension support depends on your browser; use the web app when extensions are unavailable.')}</p> : null}
            {family === 'firefox' ? <p>{t('Firefox: install a signed release package when available. For a temporary development install, open about:debugging, choose This Firefox, then Load Temporary Add-on and select manifest.json. Temporary installs end when Firefox closes.')}</p>
                : family === 'chrome' || family === 'edge' ? <p>{t('Extract the matching release package. Open {}, enable Developer mode, choose Load unpacked, and select the extracted extension folder.', family === 'edge' ? 'edge://extensions' : 'chrome://extensions')}</p>
                : <p>{t('Use a supported Chrome, Chromium, Edge, or Firefox desktop browser. For iOS Safari, see the Userscripts setup below.')}</p>}
            <ol>
                <li>{t('In the extension settings, choose Connect to a KeeWebX tab and set the address to this app’s URL.')}</li>
                <li>{t('Keep this app tab open, unlock a vault, then request a login from the extension.')}</li>
                <li>{t('Review the requested vault permissions and approve only the databases you want to share. Manage or revoke access below.')}</li>
            </ol>
            {!enabled && <p role="status">{t('Browser extension connections are not enabled in this build.')}</p>}
        </details>
        <details class="preference-help">
            <summary>{t('iOS Safari with Userscripts (experimental)')}</summary>
            <p>{t('Install the Userscripts app, open the Connect userscript link below in Safari, then choose Tap to Install in the Userscripts extension menu. Keep the filename keewebx-connect.user.js and only one enabled Connect script. Disable old connection probes and allow Userscripts on KeeWebX and your login websites.')}</p>
            <p><a href="https://keewebx.app/connect-port/keewebx-connect.user.js?v=0.6.12" target="_blank" rel="noopener noreferrer">{t('Download Connect userscript')}</a> · <a href={`${Links.Repo}/tree/master/modules/extension/userscript#readme`} target="_blank" rel="noopener noreferrer">{t('Userscripts setup guide')}</a></p>
            <ol>
                <li>{t('In the KeeWebX tab you want to use, unlock a database, open KeeWebX Connect, choose Authorize Connect and select Allow for account listing once. All login websites then use this tab.')}</li>
                <li>{t('On a login website, focus a login field and tap the key. The first connection on each page opens a temporary page that closes after connecting the website to your existing app. The website then verifies the app before showing accounts. Further requests on the same page reuse the connection; other websites reuse the authorization. Select an account to fill; forms are not submitted automatically.')}</li>
                <li>{t('For a self-hosted app, save its HTTPS address in the script’s Connection tab first. Keep the authorized app open and visit it if needed, then return to the website and retry.')}</li>
            </ol>
            <p>{t('Keep the authorized KeeWebX tab open. If it stops replying, visit that tab, unlock if needed and retry from the website. Native iOS long suspension and standalone Home Screen PWAs remain unverified. The script cannot force iOS to resume a suspended tab.')}</p>
        </details>
        <div class="cardlist">
            <PreferenceCheck name="extensionFocusIfLocked" label="Ask to unlock when an extension requests a login" />
            <PreferenceCheck name="extensionFocusIfEmpty" label="Show the entry chooser when no website matches" />
        </div>
        <p class="general-preferences__help">{t('Turning these off rejects locked-vault or unmatched requests without opening a prompt. Existing vault permissions still apply.')}</p>
    </section>;
}
