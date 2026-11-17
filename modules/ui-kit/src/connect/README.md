# Connect components

Controlled Preact and TypeScript components for a Connect account picker and
connection settings. They work in a normal document, a browser-extension page,
or a Shadow DOM host. Bun bundles them into the standalone Userscript.

```tsx
import { render } from 'preact';
import { ConnectPanel, connectStyles, type ConnectPanelProps } from 'ui-kit/connect';

export function renderConnect(root: HTMLElement | ShadowRoot, props: ConnectPanelProps) {
    render(<><style>{connectStyles}</style><ConnectPanel {...props}
        panelStyle={{ position: 'static', width: '100%', maxHeight: '100vh' }} /></>, root);
    return () => render(null, root);
}
```

`ui-kit/connect` follows the extension's existing workspace alias. The package also
exports `@keewebx/ui-kit/connect`. `ConnectPanelProps` and `ConnectViewState` are
the public contract; individual `AccountList`, `ConnectionSettings` and
`ConnectionStatus` components can be embedded separately. Supply a distinct
`idPrefix` when mounting multiple panels in the same document.

| Layer | Responsibility |
|---|---|
| `ui-kit/connect` | Controlled views, scoped styles, accessibility and account summaries |
| `extension/src/common/connect-preferences.ts` | Preference types and host-independent storage contract |
| `extension/userscript/src/connect-ui.ts` | Closed shadow root, trusted events and field positioning |
| `extension/userscript/src/preferences.ts` | GM implementation of the preference store |
| `extension/userscript/src/login-fields.ts` | Website login-form discovery and its lifecycle |

Components receive state and callbacks. They do not query login forms, call GM,
import browser-extension APIs, open windows or send protocol requests. Passwords
and signing keys are never view props. Labels and account summaries render as JSX
text. A host owns permission checks, trusted-user intent, cancellation and storage;
the Userscript renders its summaries inside a closed shadow root.

`busy` disables account selection, and `preferencePending` disables the preference
and lookup actions. Input values stay controlled without replacing the input on
each update. Styles are scoped to `.kwx-connect`, with system light/dark colors,
44-pixel touch targets and viewport constraints. Hosts can supply `panelStyle`
and `panelRef` for their own positioning, or omit them for the default panel.

Run the portable component suite independently of the Userscript:

```sh
node modules/ui-kit/tests/connect.mjs chromium webkit
```

It compiles the actual components with Bun and verifies normal and Shadow DOM
embedding, hostile page styles, text escaping, busy states, accessibility and
mobile sizes. It also verifies that diagnostics controls and log panels are absent,
that no fetch calls occur, and that no network requests are attempted. Browser
requests are blocked locally. It uses no GM or extension transport fixture.
