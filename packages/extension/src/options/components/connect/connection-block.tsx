import { FunctionComponent } from 'preact';
import { res } from 'options/utils';
import { ConnectionWeb } from './connection-web';
import { ConnectState } from './connect-state';

// KeeWebX is web-only. Upstream KeeWeb Connect had a desktop/web mode
// selector (ConnectMode) that toggled between the Electron native-
// messaging bridge and the window.postMessage web transport. We stripped
// the native messaging side with Electron, but the original conditional
// `{model.useWebApp ? <ConnectionWeb /> : null}` was left in — and because
// `model.useWebApp` was NEVER DEFINED on the settings model, the
// transpileOnly TS build silently let this compile as `undefined ? ...`,
// so the URL-configuration panel never rendered and users had no way to
// point the extension at a custom KeeWeb URL. Fix: always render
// ConnectionWeb. Found in 2026-04-09 warroom. Same disease class as the
// settings-store stub and the webpack runtime-info regex — "silent
// fork/migration rot" caught only by actually exercising the UI.
const ConnectionBlock: FunctionComponent = () => {
    return (
        <>
            <h2 id="connection">{res('optionsConnection')}</h2>
            <ConnectionWeb />
            <ConnectState />
        </>
    );
};

export { ConnectionBlock };
