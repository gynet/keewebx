/** @jsxImportSource preact */
import type { ConnectPanelProps } from './types';

export type AccountListProps = Pick<ConnectPanelProps, 'state' | 'onAction' | 'onSelectAccount'>;

export function AccountList({ state, onAction, onSelectAccount }: AccountListProps) {
    const action = state.actions.lookup;

    return (
        <div class="kwx-connect__accounts">
            <div class="kwx-connect__actions">
                <button
                    type="button"
                    class={`kwx-connect__button kwx-connect__button--${action.variant ?? 'secondary'}`}
                    data-action="lookup"
                    hidden={action.hidden}
                    disabled={action.disabled || state.preferencePending}
                    onClick={(event) => onAction('lookup', event)}
                >
                    {action.label}
                </button>
            </div>
            <div class="kwx-connect__entries" data-role="entries">
                {state.accounts.map((account) => (
                    <button
                        key={account.id}
                        type="button"
                        class="kwx-connect__button kwx-connect__entry"
                        data-action={`entry-${account.id}`}
                        disabled={state.busy}
                        onClick={(event) => onSelectAccount(account.id, event)}
                    >
                        <strong class="kwx-connect__entry-title">{account.title || 'Untitled account'}</strong>
                        <span class="kwx-connect__entry-username">{account.username || 'No username'}</span>
                    </button>
                ))}
                {state.accounts.length === 0 && state.emptyMessage && (
                    <p class="kwx-connect__empty">{state.emptyMessage}</p>
                )}
            </div>
            <p class="kwx-connect__note">
                Select an account to fill it. The login form will not be submitted automatically.
            </p>
        </div>
    );
}
