/** @jsxImportSource preact */
import type { ConnectAction, ConnectPanelProps } from './types';
import { DiagnosticsSettings } from './diagnostics-settings';

export type ConnectionSettingsProps = Pick<
    ConnectPanelProps,
    'state' | 'onAction' | 'onAddressInput' | 'onAutoFillSingleChange' | 'onDiagnosticsChange'
> & { idPrefix?: string };

export function ConnectionSettings({
    state,
    idPrefix = 'kwx-connect',
    onAction,
    onAddressInput,
    onAutoFillSingleChange,
    onDiagnosticsChange,
}: ConnectionSettingsProps) {
    const actionButton = (name: ConnectAction) => {
        const action = state.actions[name];
        return (
            <button
                key={name}
                type="button"
                class={`kwx-connect__button kwx-connect__button--${action.variant ?? 'secondary'}`}
                data-action={name}
                hidden={action.hidden}
                disabled={action.disabled || (name === 'probe' && state.preferencePending)}
                onClick={(event) => onAction(name, event)}
            >
                {action.label}
            </button>
        );
    };

    return (
        <div class="kwx-connect__settings">
            <div
                class="kwx-connect__pairing"
                hidden={state.pairingOrigin === undefined}
                role="group"
                aria-labelledby={`${idPrefix}-pairing-title`}
                aria-describedby={`${idPrefix}-pairing-origin`}
            >
                <h3 class="kwx-connect__pairing-title" id={`${idPrefix}-pairing-title`}>
                    Website connection request
                </h3>
                <p class="kwx-connect__note">Connect this KeeWebX tab to:</p>
                <p class="kwx-connect__pairing-origin" id={`${idPrefix}-pairing-origin`} dir="ltr">
                    {state.pairingOrigin}
                </p>
                <div class="kwx-connect__actions">{(['pair', 'decline'] as const).map(actionButton)}</div>
            </div>
            <label class="kwx-connect__label" for={`${idPrefix}-address`}>KeeWebX address</label>
            <input
                id={`${idPrefix}-address`}
                class="kwx-connect__input"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellcheck={false}
                readOnly={state.mode === 'app' || state.addressReadOnly}
                value={state.address}
                onInput={(event) => onAddressInput(event.currentTarget.value, event)}
            />
            <div class="kwx-connect__actions">
                {(['save', 'open', 'authorize', 'return', 'revoke', 'probe'] as const).map(actionButton)}
            </div>
            <div class="kwx-connect__preference" hidden={state.mode !== 'website'} aria-busy={state.preferencePending}>
                <label class="kwx-connect__check-label" for={`${idPrefix}-auto-fill-single`}>
                    <input
                        id={`${idPrefix}-auto-fill-single`}
                        class="kwx-connect__checkbox"
                        type="checkbox"
                        data-action="auto-fill-single"
                        checked={state.autoFillSingle}
                        disabled={state.preferencePending}
                        aria-describedby={`${idPrefix}-auto-fill-hint${state.preferenceError ? ` ${idPrefix}-preference-error` : ''}`}
                        onChange={(event) => onAutoFillSingleChange(event.currentTarget.checked, event)}
                    />
                    <span>Fill a single matching account automatically</span>
                </label>
                <p class="kwx-connect__note kwx-connect__preference-hint" id={`${idPrefix}-auto-fill-hint`}>
                    Only fills when exactly one account matches. The login form will not be submitted automatically.
                </p>
                {state.preferenceError && (
                    <p class="kwx-connect__error" id={`${idPrefix}-preference-error`} role="alert">
                        {state.preferenceError}
                    </p>
                )}
            </div>
            {state.remoteDiagnostics && state.mode !== 'relay' && <DiagnosticsSettings
                state={state.remoteDiagnostics} idPrefix={idPrefix} onChange={onDiagnosticsChange} />}
            {state.note && <p class="kwx-connect__note">{state.note}</p>}
        </div>
    );
}
