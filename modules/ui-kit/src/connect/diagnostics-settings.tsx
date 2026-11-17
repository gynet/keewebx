/** @jsxImportSource preact */
import type { ConnectDiagnosticState } from './types';

export function DiagnosticsSettings({ state, idPrefix, onChange }: {
    state: ConnectDiagnosticState;
    idPrefix: string;
    onChange?(enabled: boolean, event: Event): void;
}) {
    const label = {
        off: 'Off. No diagnostic data is sent.',
        starting: 'Starting a support session…',
        sending: 'Sending connection diagnostics…',
        connected: 'Connected to diagnostics support.',
        offline: 'Diagnostics unavailable. Your vault connection is unaffected.'
    }[state.status];
    return <div class="kwx-connect__preference" data-role="remote-diagnostics" aria-busy={state.pending}>
        <label class="kwx-connect__check-label" for={`${idPrefix}-diagnostics-enabled`}>
            <input id={`${idPrefix}-diagnostics-enabled`} class="kwx-connect__checkbox" type="checkbox"
                data-action="diagnostics-enabled" checked={state.enabled || state.status === 'starting'}
                disabled={state.pending && state.status === 'off'}
                aria-describedby={`${idPrefix}-diagnostics-hint`}
                onChange={event => onChange?.(event.currentTarget.checked, event)} />
            <span>Enable remote diagnostics for 1 hour</span>
        </label>
        <p class="kwx-connect__note kwx-connect__preference-hint" id={`${idPrefix}-diagnostics-hint`}>
            Send connection events to keewebx.app and allow read-only support checks from this script and your App tab.
            Vault contents, account values and website addresses are excluded. You can stop at any time.
        </p>
        <p class="kwx-connect__note" data-role="remote-diagnostics-status" role="status">{label}</p>
        {state.enabled && state.id && <p class="kwx-connect__note">
            <span>Support ID: </span><code data-role="diagnostics-id" dir="ltr">{state.id}</code>
            {state.expiresAt && <><br /><span>Stops at {new Date(state.expiresAt).toLocaleTimeString()}</span></>}
        </p>}
        {state.error && <p class="kwx-connect__error" role="alert">Diagnostics could not connect. Try enabling it again.</p>}
    </div>;
}
