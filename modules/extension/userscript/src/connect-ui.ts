import { h, render, Fragment, type JSX } from 'preact';
import { ConnectPanel, connectStyles } from 'ui-kit/connect';
import type { ActionState, ConnectAction, ConnectMode, ConnectTab, ConnectViewState } from 'ui-kit/connect';
import type { BackendConnectionState } from '../../src/common/backend-connection-state';
import { CONNECT_VERSION } from './version';
import { ConnectLauncherDrag } from './connect-drag';
import { LocalConnectLog } from './local-connect-log';
import { transportEvent } from './transport-events';
import type { DiagnosticData } from '../../../diagnostics/src';

type ActionHandler = (event: MouseEvent) => void;

function actionStates(mode: ConnectMode): Record<ConnectAction, ActionState> {
    return {
        save: { label: 'Save address', hidden: mode !== 'website' },
        open: { label: mode === 'relay' ? 'Open new KeeWebX' : 'Reconnect to existing tab', hidden: mode === 'app' },
        authorize: { label: 'Authorize Connect', hidden: mode !== 'app', variant: 'primary' },
        return: { label: 'Back to site', hidden: mode !== 'relay', disabled: true, variant: 'primary' },
        revoke: { label: mode === 'relay' ? 'Find app tabs again' : 'Disconnect', hidden: mode === 'website' },
        lookup: { label: 'Find accounts', variant: 'primary' },
        probe: { label: 'Test connection', hidden: mode !== 'website' },
        pair: { label: 'Connect this tab', variant: 'primary' },
        decline: { label: 'Decline' }
    };
}

/** Userscript host adapter: owns the closed root, trusted events and field positioning. */
export class ConnectUI {
    readonly host = document.createElement('div');
    private readonly shadow = this.host.attachShadow({ mode: 'closed' });
    private view: ConnectViewState;
    private panel?: HTMLElement;
    private panelStyle?: JSX.CSSProperties;
    private appDrag?: ConnectLauncherDrag;
    private field?: HTMLInputElement;
    private connectionPending = false;
    private relayLookup?: ActionHandler;
    private actions = new Map<ConnectAction, ActionHandler>();
    private selections = new Map<string, ActionHandler>();
    onClose = () => {};
    onConfig = () => {};
    onOpen = (_event: MouseEvent) => {};
    onAutoFillSingleChange = (_enabled: boolean) => {};
    connectionSnapshot: () => DiagnosticData = () => ({});

    constructor(readonly mode: ConnectMode, endpoint: string) {
        this.host.id = 'keewebx-userscript-connect';
        this.host.style.cssText = mode === 'relay'
            ? 'position:fixed;inset:0;display:grid;place-items:center;padding:16px;z-index:2147483647;'
            : 'position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:2147483647;';
        this.view = {
            mode, open: mode === 'relay', launcherVisible: mode === 'app', tab: mode === 'website' ? 'accounts' : 'config',
            busy: false, status: 'Initializing', message: 'Not connected', address: endpoint, addressReadOnly: mode !== 'website',
            actions: actionStates(mode), accounts: [], version: `Connect ${CONNECT_VERSION}`,
            autoFillSingle: false, preferencePending: mode === 'website',
            note: mode === 'app'
                ? 'Authorize this app once for all websites.'
                : mode === 'relay'
                    ? 'Confirm in the existing KeeWebX tab you want to use. No database is opened on this connection page.'
                    : 'Keep your authorized KeeWebX tab open. If a temporary connection page opens, it closes automatically after connection.'
        };
        if (mode === 'relay') this.panelStyle = { position: 'relative', inset: 'auto', width: 'min(420px,calc(100vw - 32px))', maxHeight: 'calc(100dvh - 32px)', transform: 'none' };
        if (mode === 'app') this.appDrag = new ConnectLauncherDrag(this.host, () => this.place());
        document.body.append(this.host);
        this.paint();
        this.appDrag?.reposition();
        if (mode === 'app' && this.panel) new ResizeObserver(() => this.place()).observe(this.panel);
        if (mode === 'website') {
            const reposition = () => { if (this.field?.isConnected) this.place(); };
            addEventListener('scroll', reposition, true); addEventListener('resize', reposition);
            visualViewport?.addEventListener('resize', reposition); visualViewport?.addEventListener('scroll', reposition);
            if (this.panel) new ResizeObserver(reposition).observe(this.panel);
        }
    }

    enableRelayLookup(handler: ActionHandler): void {
        this.relayLookup = handler;
        this.paint();
    }

    get address(): string { return this.view.address; }
    on(action: ConnectAction, handler: ActionHandler): void { this.actions.set(action, handler); }
    action(action: ConnectAction, patch: Partial<ActionState>): void {
        this.update({ actions: { ...this.view.actions, [action]: { ...this.view.actions[action], ...patch } } });
    }
    isDisabled(action: ConnectAction): boolean {
        return !!this.view.actions[action].disabled ||
            (this.connectionPending && ['lookup', 'probe', 'open'].includes(action)) ||
            (this.view.preferencePending && (action === 'lookup' || action === 'probe'));
    }
    preparingConnection(pending: boolean): void {
        if (pending === this.connectionPending) return;
        this.connectionPending = pending; this.paint();
    }
    preference(enabled: boolean, pending = false, error?: string): void {
        this.update({ autoFillSingle: enabled, preferencePending: pending, preferenceError: error });
    }
    show(tab: ConnectTab = this.mode === 'website' ? 'accounts' : 'config', open = true): void {
        this.update({ tab, open }); this.place();
    }
    hide(): void { this.update({ open: false }); this.onClose(); }
    pairing(origin?: string): void { this.update({ pairingOrigin: origin }); if (origin !== undefined) this.show('config'); }
    state(status: BackendConnectionState, message: string): void {
        if (status !== this.view.status) transportEvent({ state: status });
        this.update({ status, message });
    }
    busy(busy: boolean): void {
        this.update({ busy, actions: { ...this.view.actions,
            lookup: { ...this.view.actions.lookup, disabled: busy }, probe: { ...this.view.actions.probe, disabled: busy } } });
    }
    clear(): void { this.selections.clear(); this.update({ accounts: [], emptyMessage: undefined }); }
    empty(message: string): void { this.selections.clear(); this.update({ accounts: [], emptyMessage: message }); }
    entry(index: number, title: string, username: string, select: ActionHandler): void {
        const id = String(index); this.selections.set(id, select);
        this.update({ accounts: [...this.view.accounts, { id, title, username }] });
    }
    anchor(field?: HTMLInputElement): void {
        if (this.mode !== 'website') return;
        this.field = field; this.update({ launcherVisible: !!field });
        if (!field) {
            if (this.view.open) { transportEvent({ action: 'anchor-lost' }); this.hide(); }
            return;
        }
        this.place();
    }

    private update(patch: Partial<ConnectViewState>): void { this.view = { ...this.view, ...patch }; this.paint(); }
    private paint(): void {
        const state = this.connectionPending ? { ...this.view, busy: true, actions: { ...this.view.actions,
            lookup: { ...this.view.actions.lookup, disabled: true },
            probe: { ...this.view.actions.probe, disabled: true },
            open: { ...this.view.actions.open, disabled: true }
        } } : this.view;
        render(h(Fragment, null, h('style', null, connectStyles), h(ConnectPanel, {
            state, panelStyle: this.panelStyle, panelRef: this.panelRef, launcherRef: this.appDrag?.ref,
            connectionExtra: this.mode === 'relay' ? undefined : h(Fragment, null,
                this.relayLookup && h('button', {
                    type: 'button',
                    class: 'kwx-connect__button kwx-connect__button--secondary',
                    'data-action': 'relay-lookup',
                    disabled: this.connectionPending || this.view.preferencePending,
                    onClick: (event: MouseEvent) => {
                        if (event.isTrusted && !this.connectionPending && !this.view.preferencePending) {
                            transportEvent({ action: 'lookup' });
                            this.relayLookup?.(event);
                        }
                    }
                }, 'Find accounts via relay'),
                h(LocalConnectLog, { mode: this.mode, snapshot: this.readLogSnapshot })
            ),
            onAction: (action, event) => { if (event.isTrusted && !this.isDisabled(action)) {
                // Relay-only actions have no local connection log.
                if (action !== 'return' && action !== 'pair' && action !== 'decline') transportEvent({ action });
                this.actions.get(action)?.(event);
            } },
            onSelectAccount: (id, event) => { if (event.isTrusted && !this.view.busy && !this.connectionPending) {
                transportEvent({ action: 'select-account' }); this.selections.get(id)?.(event);
            } },
            onToggle: event => {
                if (!event.isTrusted) return;
                transportEvent({ action: this.view.open ? 'panel-close' : 'panel-open' });
                if (this.view.open) this.hide(); else { this.show(); this.onOpen(event); }
            },
            onClose: event => { if (event.isTrusted) { transportEvent({ action: 'panel-close' }); this.hide(); } },
            onTab: (tab, event) => { if (event.isTrusted) {
                transportEvent({ action: tab }); if (tab === 'config') this.onConfig(); this.show(tab);
            } },
            onAddressInput: (address, event) => { if (event.isTrusted) this.update({ address }); },
            onAutoFillSingleChange: (enabled, event) => {
                if (event.isTrusted && !this.view.preferencePending) {
                    transportEvent({ action: 'preference' }); this.onAutoFillSingleChange(enabled);
                }
            },
            onPanelKeyDown: event => { if (event.isTrusted && event.key === 'Escape') {
                event.stopPropagation(); transportEvent({ action: 'escape' }); this.hide();
            } }
        })), this.shadow);
    }
    private readonly readLogSnapshot = () => ({ ...this.connectionSnapshot(), state: this.view.status });
    private panelRef = (element: HTMLElement | null): void => { this.panel = element ?? undefined; };

    private place(): void {
        if (this.mode === 'app') {
            if (!this.view.open) return;
            const rect = this.host.getBoundingClientRect();
            const vx = visualViewport?.offsetLeft || 0, vy = visualViewport?.offsetTop || 0;
            const vw = visualViewport?.width || innerWidth, vh = visualViewport?.height || innerHeight;
            const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));
            const width = Math.min(348, vw - 24);
            const desiredHeight = Math.max(this.panel?.offsetHeight || 0, (this.panel?.scrollHeight || 0) + 2, 310);
            const above = Math.max(0, rect.top - vy - 24), below = Math.max(0, vy + vh - rect.bottom - 24);
            const useAbove = above >= desiredHeight || above >= below;
            const maxHeight = useAbove ? above : below, height = Math.min(desiredHeight, maxHeight);
            const py = useAbove ? rect.top - height - 12 : rect.bottom + 12;
            const style: JSX.CSSProperties = { position: 'fixed', left: `${clamp(rect.right - width, vx + 12, vx + vw - width - 12)}px`,
                top: `${clamp(py, vy + 12, vy + vh - height - 12)}px`, right: 'auto', bottom: 'auto',
                width: `${width}px`, maxHeight: `${maxHeight}px` };
            if (JSON.stringify(style) !== JSON.stringify(this.panelStyle)) { this.panelStyle = style; this.paint(); }
            return;
        }
        const field = this.field;
        if (this.mode !== 'website' || !field?.isConnected) return;
        const rect = field.getBoundingClientRect();
        const vx = visualViewport?.offsetLeft || 0, vy = visualViewport?.offsetTop || 0;
        const vw = visualViewport?.width || innerWidth, vh = visualViewport?.height || innerHeight;
        const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));
        const x = clamp(rect.right + 50 <= vx + vw - 8 ? rect.right + 6 : rect.right - 46, vx + 8, vx + vw - 52);
        const y = clamp(rect.top + (rect.height - 44) / 2, vy + 8, vy + vh - 52);
        this.host.style.left = `${x}px`; this.host.style.top = `${y}px`; this.host.style.right = 'auto'; this.host.style.bottom = 'auto';
        const width = Math.min(348, vw - 24), height = Math.min(this.panel?.offsetHeight || 310, vh - 24);
        const py = rect.bottom + 8 + height <= vy + vh - 8 ? rect.bottom + 8 : rect.top - height - 8;
        const style: JSX.CSSProperties = { position: 'fixed', left: `${clamp(rect.left, vx + 12, vx + vw - width - 12)}px`,
            top: `${clamp(py, vy + 12, vy + vh - height - 12)}px`, right: 'auto', bottom: 'auto', width: `${width}px`, maxHeight: `${Math.max(100, vh - 24)}px` };
        if (JSON.stringify(style) !== JSON.stringify(this.panelStyle)) { this.panelStyle = style; this.paint(); }
    }
}
