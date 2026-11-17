/** @jsxImportSource preact */
import { AccountList } from './account-list';
import { ConnectionSettings } from './connection-settings';
import { ConnectionStatus } from './connection-status';
import type { ConnectPanelProps } from './types';

function KeyIcon() {
    return (
        <svg
            class="kwx-connect__key"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            aria-hidden="true"
            focusable="false"
        >
            <path d="M15 3a6 6 0 0 0-5.5 8.4L3 18v3h3l1.5-1.5V17H10l2.6-2.6A6 6 0 1 0 15 3Z M16.5 6.5h.01" />
        </svg>
    );
}

export function ConnectPanel({
    state,
    idPrefix = 'kwx-connect',
    panelStyle,
    panelRef,
    ...callbacks
}: ConnectPanelProps) {
    const accountsActive = state.mode === 'website' && state.tab === 'accounts';
    const relay = state.mode === 'relay';

    return (
        <div class="kwx-connect" data-mode={state.mode} onKeyDown={callbacks.onPanelKeyDown}>
            <section
                class="kwx-connect__panel"
                id={`${idPrefix}-panel`}
                role="dialog"
                aria-labelledby={`${idPrefix}-title`}
                aria-describedby={`${idPrefix}-status`}
                hidden={!state.open}
                style={panelStyle}
                ref={panelRef}
            >
                <header class="kwx-connect__header">
                    <h2 class="kwx-connect__title" id={`${idPrefix}-title`}>
                        <KeyIcon />
                        <span>KeeWebX Connect</span>
                    </h2>
                    <button
                        type="button"
                        class="kwx-connect__button kwx-connect__close"
                        data-action="close"
                        hidden={relay}
                        aria-label="Close"
                        onClick={callbacks.onClose}
                    >
                        <span aria-hidden="true">×</span>
                    </button>
                </header>
                <div class="kwx-connect__tabs" role="tablist" aria-label="KeeWebX Connect" hidden={relay}>
                    <button
                        type="button"
                        class="kwx-connect__button kwx-connect__tab"
                        id={`${idPrefix}-accounts-tab`}
                        data-action="accounts-tab"
                        role="tab"
                        aria-controls={`${idPrefix}-accounts`}
                        aria-selected={accountsActive}
                        hidden={state.mode !== 'website'}
                        onClick={(event) => callbacks.onTab('accounts', event)}
                    >
                        Accounts
                    </button>
                    <button
                        type="button"
                        class="kwx-connect__button kwx-connect__tab"
                        id={`${idPrefix}-config-tab`}
                        data-action="config-tab"
                        role="tab"
                        aria-controls={`${idPrefix}-config`}
                        aria-selected={!accountsActive}
                        onClick={(event) => callbacks.onTab('config', event)}
                    >
                        Connection
                    </button>
                </div>
                <ConnectionStatus state={state} idPrefix={idPrefix} />
                <section
                    class="kwx-connect__tab-panel"
                    id={`${idPrefix}-accounts`}
                    role="tabpanel"
                    aria-labelledby={`${idPrefix}-accounts-tab`}
                    hidden={!accountsActive}
                >
                    <AccountList
                        state={state}
                        onAction={callbacks.onAction}
                        onSelectAccount={callbacks.onSelectAccount}
                    />
                </section>
                <section
                    class="kwx-connect__tab-panel"
                    id={`${idPrefix}-config`}
                    role={relay ? undefined : 'tabpanel'}
                    aria-labelledby={relay ? `${idPrefix}-title` : `${idPrefix}-config-tab`}
                    hidden={accountsActive}
                >
                    <ConnectionSettings
                        state={state}
                        idPrefix={idPrefix}
                        onAction={callbacks.onAction}
                        onAddressInput={callbacks.onAddressInput}
                        onAutoFillSingleChange={callbacks.onAutoFillSingleChange}
                        onDiagnosticsChange={callbacks.onDiagnosticsChange}
                    />
                </section>
                <details class="kwx-connect__diagnostics" data-role="connection-diagnostics" hidden={state.diagnostics.length === 0}>
                    <summary class="kwx-connect__diagnostics-summary">Connection diagnostics</summary>
                    <ul class="kwx-connect__diagnostics-list">
                        {state.diagnostics.map((detail, index) => <li key={index}>{detail}</li>)}
                    </ul>
                </details>
                <footer class="kwx-connect__version" data-role="version">{state.version}</footer>
            </section>
            <button
                type="button"
                class="kwx-connect__button kwx-connect__toggle"
                data-action="toggle"
                hidden={relay || !state.launcherVisible}
                aria-label="KeeWebX Connect"
                aria-controls={`${idPrefix}-panel`}
                aria-expanded={state.open}
                aria-haspopup="dialog"
                onClick={callbacks.onToggle}
            >
                <KeyIcon />
            </button>
        </div>
    );
}
