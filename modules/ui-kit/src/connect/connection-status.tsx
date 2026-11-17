/** @jsxImportSource preact */
import type { ConnectViewState } from './types';

export interface ConnectionStatusProps {
    state: Pick<ConnectViewState, 'status' | 'message'>;
    idPrefix?: string;
}

export function ConnectionStatus({ state, idPrefix = 'kwx-connect' }: ConnectionStatusProps) {
    return (
        <p class="kwx-connect__status" id={`${idPrefix}-status`} role="status" aria-live="polite" aria-atomic="true">
            <span class="kwx-connect__indicator" data-state={state.status} aria-hidden="true" />
            <span>{state.message}</span>
        </p>
    );
}
