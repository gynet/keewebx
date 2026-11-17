import type { DiagnosticCode, DiagnosticCommand, DiagnosticData, DiagnosticSession } from './types';

export const SESSION_MS = 3_600_000;
export const TIMEOUT_MS = 8_000;
export const POLL_MS = 5_000;
export const BATCH_SIZE = 32;
const COMMAND_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const codes = new Set<DiagnosticCode>([
    'session.started', 'session.stopped', 'page.visible', 'page.hidden', 'page.show', 'page.hide',
    'connect.state', 'connect.action', 'connect.stage', 'connect.error',
    'app.locked', 'app.unlocked', 'app.receiver', 'transport.event', 'command.result'
]);
const booleans = [
    'locked', 'authorized', 'authorizing', 'selected', 'live', 'direct', 'hasSession',
    'hasPort', 'online', 'visible', 'persisted'
] as const;
const enums = {
    layer: ['userscript', 'app', 'website', 'worker'],
    state: ['Initializing', 'ReadyToConnect', 'Connecting', 'Connected', 'Error'],
    action: ['open', 'authorize', 'revoke', 'lookup', 'probe', 'save', 'close'],
    stage: ['connect', 'access', 'lookup', 'fields', 'fill', 'test', 'authorize', 'restore'],
    event: ['receiver-ready', 'discovery', 'discovery-reply', 'discovery-timeout', 'handoff', 'port-ready', 'hello-received', 'hello-replied',
        'wire-received', 'wire-replied', 'wire-error', 'receipt', 'suppressed', 'unavailable',
        'discovery-received', 'discovery-sent', 'discovery-rejected', 'port-received', 'port-rejected',
        'rpc-sent', 'rpc-received', 'rpc-accepted', 'rpc-rejected', 'runtime-duplicate'],
    reason: ['timeout', 'locked', 'canceled', 'unavailable', 'changed', 'other'],
    detail: [
        'wrong-source', 'wrong-address', 'wrong-host', 'wrong-origin', 'wrong-generation',
        'wrong-port', 'wrong-shape', 'bad-signature', 'no-pending', 'expired', 'closed',
        'not-selected', 'duplicate-runtime', 'legacy', 'matched'
    ]
} as const;

/** Never invoke getters, inspect nested values, or coerce input to strings. */
function object(value: unknown): object | undefined {
    if (!value || typeof value !== 'object') return;
    try {
        const prototype = Object.getPrototypeOf(value);
        if (prototype === Object.prototype || prototype === null) return value;
    } catch { /* Revoked proxies and other hostile objects are not diagnostics. */ }
}

function field(value: object, key: string): unknown {
    try {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor && 'value' in descriptor ? descriptor.value : undefined;
    } catch { return undefined; }
}

function exact(value: unknown, keys: readonly string[]): object | undefined {
    const record = object(value);
    if (!record) return;
    try {
        if (Reflect.ownKeys(record).every(key => {
            const descriptor = Object.getOwnPropertyDescriptor(record, key);
            return typeof key === 'string' && keys.includes(key) && descriptor && 'value' in descriptor;
        })) return record;
    } catch { /* Invalid envelopes are rejected. */ }
}

export function sanitizeData(value: unknown): DiagnosticData {
    const result: Record<string, boolean | number | string> = {};
    const record = object(value);
    if (!record) return result;
    for (const key of booleans) {
        const item = field(record, key);
        if (typeof item === 'boolean') result[key] = item;
    }
    for (const key of ['traceId', 'portId'] as const) {
        const item = field(record, key);
        if (typeof item === 'string' && item.length === 36 && UUID.test(item)) result[key] = item;
    }
    for (const key of ['elapsedMs', 'pending', 'ports', 'authorization', 'runtimeCount'] as const) {
        const item = field(record, key);
        const maximum = key === 'elapsedMs' ? SESSION_MS : key === 'runtimeCount' ? 32 : 10_000;
        if (typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= maximum
            && (key === 'elapsedMs' || Number.isInteger(item))) result[key] = item;
    }
    for (const key of Object.keys(enums) as (keyof typeof enums)[]) {
        const item = field(record, key);
        if (typeof item === 'string' && (enums[key] as readonly string[]).includes(item)) result[key] = item;
    }
    return result as DiagnosticData;
}

export function sanitizeEvent(code: unknown, data?: unknown): { code: DiagnosticCode; data: DiagnosticData } | undefined {
    if (typeof code !== 'string' || !codes.has(code as DiagnosticCode)) return;
    return { code: code as DiagnosticCode, data: sanitizeData(data) };
}

export function readSession(value: unknown, now: number, maximum = now + SESSION_MS): DiagnosticSession | undefined {
    const record = exact(value, ['id', 'token', 'expiresAt']);
    if (!record) return;
    const id = field(record, 'id');
    const token = field(record, 'token');
    const expiresAt = field(record, 'expiresAt');
    if (typeof id !== 'string' || !UUID.test(id) || typeof token !== 'string'
        || !/^[\x21-\x7e]{1,2048}$/.test(token) || !timestamp(expiresAt)
        || expiresAt <= now || expiresAt > maximum) return;
    return { id: id.toLowerCase(), token, expiresAt };
}

function timestamp(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function readExchange(value: unknown): { commands: unknown[]; expiresAt: number } | undefined {
    const record = exact(value, ['commands', 'expiresAt']);
    if (!record) return;
    const commands = field(record, 'commands');
    const expiresAt = field(record, 'expiresAt');
    if (!Array.isArray(commands) || commands.length > BATCH_SIZE || !timestamp(expiresAt)) return;
    // Copy data descriptors rather than invoking getters on untrusted array slots.
    const safe: unknown[] = [];
    for (let index = 0; index < commands.length; index++) safe.push(field(commands, String(index)));
    return { commands: safe, expiresAt };
}

export function readCommand(value: unknown, client: string, now: number): DiagnosticCommand | undefined {
    const record = exact(value, ['id', 'kind', 'target', 'issuedAt', 'expiresAt']);
    if (!record) return;
    const id = field(record, 'id');
    const kind = field(record, 'kind');
    const target = field(record, 'target');
    const issuedAt = field(record, 'issuedAt');
    const expiresAt = field(record, 'expiresAt');
    if (typeof id !== 'string' || !UUID.test(id)
        || (kind !== 'snapshot' && kind !== 'ping' && kind !== 'receiver-check')
        || (target !== undefined && (typeof target !== 'string' || target.toLowerCase() !== client))
        || !timestamp(issuedAt) || !timestamp(expiresAt) || issuedAt > now || expiresAt <= now
        || expiresAt <= issuedAt || expiresAt - issuedAt > COMMAND_MS) return;
    return { id: id.toLowerCase(), kind, ...(target === undefined ? {} : { target: client }), issuedAt, expiresAt };
}
