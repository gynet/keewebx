export type DiagnosticCommandKind = 'snapshot' | 'ping' | 'receiver-check';

export type DiagnosticCode =
    | 'session.started' | 'session.stopped'
    | 'page.visible' | 'page.hidden' | 'page.show' | 'page.hide'
    | 'connect.state' | 'connect.action' | 'connect.stage' | 'connect.error'
    | 'app.locked' | 'app.unlocked' | 'app.receiver'
    | 'transport.event' | 'command.result';

/** A flat allowlist: no arbitrary strings, nested objects, or protected values. */
export interface DiagnosticData {
    layer?: 'userscript' | 'app' | 'website' | 'worker';
    locked?: boolean;
    authorized?: boolean;
    authorizing?: boolean;
    selected?: boolean;
    live?: boolean;
    direct?: boolean;
    hasSession?: boolean;
    hasPort?: boolean;
    online?: boolean;
    visible?: boolean;
    persisted?: boolean;
    /** Ephemeral protocol UUIDs, never credentials or stable identifiers. */
    traceId?: string;
    portId?: string;
    elapsedMs?: number;
    pending?: number;
    ports?: number;
    authorization?: number;
    /** Integer from 0 through 32. */
    runtimeCount?: number;
    state?: 'Initializing' | 'ReadyToConnect' | 'Connecting' | 'Connected' | 'Error';
    action?: 'open' | 'authorize' | 'revoke' | 'lookup' | 'probe' | 'save' | 'close';
    stage?: 'connect' | 'access' | 'lookup' | 'fields' | 'fill' | 'test' | 'authorize' | 'restore';
    event?: 'receiver-ready' | 'discovery' | 'discovery-reply' | 'discovery-timeout' | 'handoff' | 'port-ready' | 'hello-received'
        | 'hello-replied' | 'wire-received' | 'wire-replied' | 'wire-error' | 'receipt'
        | 'suppressed' | 'unavailable' | 'mailbox-start' | 'mailbox-notified' | 'mailbox-signal'
        | 'mailbox-signal-read' | 'mailbox-read-failed' | 'mailbox-request' | 'mailbox-reply'
        | 'discovery-received' | 'discovery-sent' | 'discovery-rejected' | 'port-received' | 'port-rejected'
        | 'rpc-sent' | 'rpc-received' | 'rpc-accepted' | 'rpc-rejected' | 'runtime-duplicate'
        | 'relay-opened' | 'relay-ready' | 'relay-error' | 'mailbox-preferred'
        | 'port-message' | 'port-posted' | 'port-closed' | 'page-focus' | 'page-blur' | 'page-show' | 'page-hide' | 'page-interaction';
    reason?: 'timeout' | 'locked' | 'canceled' | 'unavailable' | 'changed' | 'other';
    /** Public routing error codes only; never copy an error message or URL. */
    relayCode?: 'invalid' | 'busy' | 'worker-unavailable' | 'relay-closed' | 'helper-unavailable'
        | 'noapp' | 'address' | 'disabled' | 'refreshed' | 'unreachable' | 'app-timeout' | 'timeout' | 'expired' | 'inactive';
    /** Local receiver callback entry time, before accessing MessageEvent.data. */
    dispatchAt?: number;
    detail?: 'wrong-source' | 'wrong-address' | 'wrong-host' | 'wrong-origin' | 'wrong-generation'
        | 'wrong-port' | 'wrong-shape' | 'bad-signature' | 'no-pending' | 'expired' | 'closed'
        | 'not-selected' | 'duplicate-runtime' | 'legacy' | 'matched' | 'inactive' | 'missing-key' | 'handler-error' | 'decode-error';
}

export interface DiagnosticSession {
    id: string;
    token: string;
    /** Absolute epoch milliseconds. */
    expiresAt: number;
}

export type DiagnosticError = 'storage' | 'network' | 'timeout' | 'invalid-response' | 'expired';

export interface DiagnosticState {
    enabled: boolean;
    id?: string;
    expiresAt?: number;
    status: 'off' | 'starting' | 'sending' | 'connected' | 'offline';
    error?: DiagnosticError;
}

export interface DiagnosticStore {
    load(): Promise<DiagnosticSession | undefined>;
    /** Persistent revocation marker. Required for stores shared between clients. */
    revision?(): Promise<string>;
    /** Grant writes must be bound to expectedRevision; clearing must advance it. */
    save(session: DiagnosticSession | undefined, expectedRevision?: string): Promise<void>;
}

/** The adapter POSTs JSON to the supplied relative path and honors signal. */
export type DiagnosticTransport = (
    path: string, body: unknown, token: string | undefined, signal: AbortSignal
) => Promise<unknown>;

export interface DiagnosticClientOptions {
    source: 'app' | 'website';
    version: string;
    store: DiagnosticStore;
    transport: DiagnosticTransport;
    snapshot(kind: DiagnosticCommandKind): Promise<DiagnosticData> | DiagnosticData;
    onChange(state: DiagnosticState): void;
    now?: () => number;
}

export interface DiagnosticEvent {
    seq: number;
    at: number;
    code: DiagnosticCode;
    data: DiagnosticData;
}

export interface DiagnosticResult {
    id: string;
    kind: DiagnosticCommandKind;
    status: 'ok' | 'failed';
    data: DiagnosticData;
}

export interface DiagnosticCommand {
    id: string;
    kind: DiagnosticCommandKind;
    target?: string;
    issuedAt: number;
    expiresAt: number;
}
