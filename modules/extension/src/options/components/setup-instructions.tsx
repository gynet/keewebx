import { FunctionComponent } from 'preact';

const USERSCRIPT_GUIDE =
    'https://github.com/gynet/keewebx/tree/master/modules/extension/userscript#readme';

/** Keep setup help available before a connection has been established. */
const SetupInstructions: FunctionComponent = () => (
    <section aria-labelledby="setup-instructions">
        <h2 id="setup-instructions">Setup and troubleshooting</h2>
        <details>
            <summary>Connect to a KeeWebX browser tab</summary>
            <ol>
                <li>
                    Set the app address above to <code>https://keewebx.app/app</code>, or to
                    your own KeeWebX installation. Save the address and grant site access if
                    requested.
                </li>
                <li>
                    Open that address in this browser and unlock your database. Approve
                    browser extension access in KeeWebX when prompted.
                </li>
                <li>
                    Return to a login website, open the extension and select an account.
                    Manage or revoke access in KeeWebX&apos;s browser extension settings.
                </li>
            </ol>
            <p>
                Cannot connect? Check that the saved address matches the open app, the
                database is unlocked, and the extension has permission to access that
                site. Save pending database changes before reloading the app. The current
                app address is <code>/app</code>; update old <code>/preview/</code> settings.
            </p>
        </details>
        <details>
            <summary>iOS Safari: experimental Userscripts setup</summary>
            <p>
                iOS Safari uses the separate KeeWebX Connect userscript with the
                Userscripts app. These desktop extension settings do not configure it.
            </p>
            <ol>
                <li>
                    Follow the{' '}
                    <a href={USERSCRIPT_GUIDE} target="_blank" rel="noopener noreferrer">
                        installation guide
                    </a>{' '}
                    to install one Connect script, disable the old diagnostic probes and
                    allow Userscripts on KeeWebX and your login website.
                </li>
                <li>
                    On the login website, tap the key icon. The connection page finds
                    existing KeeWebX tabs. In the app tab you want to use, choose Connect
                    this tab and approve access. If no app responds, open and unlock the
                    database in the new app and choose Authorize Connect.
                </li>
                <li>
                    Choose Back to site. Focus a login field, tap the key and select an
                    account. The script fills the form without submitting it.
                </li>
            </ol>
            <p>
                Keep the selected KeeWebX tab and connection page open. Standalone Home
                Screen PWAs remain unverified. iOS may suspend a background tab; the
                script cannot guarantee that it will remain available.
            </p>
        </details>
    </section>
);

export { SetupInstructions };
