import { FunctionComponent } from 'preact';

const USERSCRIPT_GUIDE =
    'https://github.com/gynet/keewebx/tree/master/modules/extension/userscript#readme';
const USERSCRIPT_DOWNLOAD =
    'https://keewebx.app/connect-port/keewebx-connect.user.js';

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
                {' '}<a href={USERSCRIPT_DOWNLOAD} target="_blank" rel="noopener noreferrer">
                    Open the Connect installer
                </a>.
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
                    In the KeeWebX tab you want to use, unlock a database, open KeeWebX
                    Connect, choose Authorize Connect and select Allow for account
                    listing once. All login websites then use this tab.
                </li>
                <li>
                    On a login website, focus a login field, tap the key and select an
                    account. It fills the form without submitting it. Use the same KeeWebX
                    authorization on every website.
                </li>
                <li>
                    For a self-hosted app, first save its HTTPS address in the script&apos;s
                    Connection tab on a website. If the local connection stalls, choose
                    Reconnect to existing tab to try a temporary connection page.
                </li>
            </ol>
            <p>
                Keep the authorized KeeWebX tab open. If it stops replying, visit that
                tab, unlock if needed and retry from the website. Native iOS long
                suspension and standalone Home Screen PWAs remain unverified. The
                script cannot force iOS to resume a suspended tab.
            </p>
        </details>
    </section>
);

export { SetupInstructions };
