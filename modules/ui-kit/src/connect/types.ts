import type { JSX } from 'preact';

export type ConnectMode = 'website' | 'app' | 'relay';
export type ConnectTab = 'accounts' | 'config';
export type ConnectAction = 'save' | 'open' | 'authorize' | 'return' | 'revoke' | 'lookup' | 'probe' | 'pair' | 'decline';
export type ConnectionState = 'Initializing' | 'ReadyToConnect' | 'Connecting' | 'Connected' | 'Error';

export interface ActionState {
    label: string;
    hidden?: boolean;
    disabled?: boolean;
    variant?: 'primary' | 'secondary' | 'danger';
}

/** Presentation data only: no passwords, transport or storage implementation. */
export interface ConnectAccount {
    id: string;
    title: string;
    username: string;
}

export interface ConnectViewState {
    mode: ConnectMode;
    open: boolean;
    launcherVisible: boolean;
    tab: ConnectTab;
    busy: boolean;
    status: ConnectionState;
    message: string;
    address: string;
    addressReadOnly: boolean;
    actions: Readonly<Record<ConnectAction, ActionState>>;
    accounts: readonly ConnectAccount[];
    emptyMessage?: string;
    note: string;
    version: string;
    pairingOrigin?: string;
    autoFillSingle: boolean;
    preferencePending: boolean;
    preferenceError?: string;
}

/** Hosts supply native events and commands; components never access GM or extension APIs. */
export interface ConnectPanelProps {
    state: ConnectViewState;
    idPrefix?: string;
    panelStyle?: JSX.CSSProperties;
    onAction(action: ConnectAction, event: MouseEvent): void;
    onTab(tab: ConnectTab, event: MouseEvent): void;
    onToggle(event: MouseEvent): void;
    onClose(event: Event): void;
    onAddressInput(value: string, event: Event): void;
    onAutoFillSingleChange(value: boolean, event: Event): void;
    onSelectAccount(id: string, event: MouseEvent): void;
    onPanelKeyDown(event: KeyboardEvent): void;
    panelRef?(element: HTMLElement | null): void;
}
