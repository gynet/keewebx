import { expect, test } from 'bun:test';
import { sanitizeData, sanitizeEvent } from '../src';
import type { DiagnosticData } from '../src/types';

test('data accepts only flat, exact primitive fields and fixed enums', () => {
    expect(sanitizeData({
        locked: false, authorized: true, authorizing: false, selected: true, live: true,
        direct: false, hasSession: true, hasPort: false, online: true, visible: false, persisted: true,
        elapsedMs: 1.5, pending: 2, ports: 3, authorization: 4,
        layer: 'app', state: 'Connected', action: 'probe', stage: 'restore', event: 'receipt', reason: 'locked',
        url: 'https://private', message: 'error', useragent: 'private', account: 'private', password: 'private', key: 'private',
        title: 'private', privatekeys: 'private', ciphertext: 'private', token: 'private', nested: { locked: true }
    })).toEqual({
        locked: false, authorized: true, authorizing: false, selected: true, live: true,
        direct: false, hasSession: true, hasPort: false, online: true, visible: false, persisted: true,
        elapsedMs: 1.5, pending: 2, ports: 3, authorization: 4,
        layer: 'app', state: 'Connected', action: 'probe', stage: 'restore', event: 'receipt', reason: 'locked'
    });
});

test('sanitizing does not invoke getters, recurse, stringify, or read inherited fields', () => {
    const value = Object.create(null);
    Object.defineProperty(value, 'locked', { get() { throw new Error('must not collect'); } });
    Object.defineProperty(value, 'password', { get() { throw new Error('must not inspect'); } });
    value.toJSON = () => { throw new Error('must not serialize'); };
    value.self = value;
    value.online = true;
    expect(sanitizeData(value)).toEqual({ online: true });
    expect(sanitizeData(Object.create({ locked: true }))).toEqual({});
    const proxy = Proxy.revocable({}, {});
    proxy.revoke();
    expect(sanitizeData(proxy.proxy)).toEqual({});
});

test('numbers are finite and bounded, counts are integers, and enum strings are exact', () => {
    for (const invalid of [-1, Infinity, NaN, 3_600_001, '5', {}, null]) {
        expect(sanitizeData({ elapsedMs: invalid })).toEqual({});
    }
    expect(sanitizeData({ pending: 1.1, ports: 10_001, authorization: -1 })).toEqual({});
    expect(sanitizeData({ elapsedMs: 3_600_000, pending: 10_000, ports: 0, authorization: 10_000 })).toEqual({
        elapsedMs: 3_600_000, pending: 10_000, ports: 0, authorization: 10_000
    });
    expect(sanitizeData({ locked: 'true', online: 1, state: 'connected', layer: 'background', reason: 'secret', event: 'log' })).toEqual({});
});

test('each permitted layer and worker discovery event is accepted verbatim', () => {
    for (const layer of ['userscript', 'app', 'website', 'worker']) expect(sanitizeData({ layer })).toEqual({ layer });
    for (const event of ['discovery', 'discovery-reply', 'discovery-timeout']) expect(sanitizeData({ event })).toEqual({ event });
});

test('return-path metadata is typed, preserved verbatim, and copied independently of its input', () => {
    const input: DiagnosticData = {
        traceId: '12345678-1234-4abc-8def-123456789abc', portId: '87654321-abcd-4fed-9123-abcdef123456',
        runtimeCount: 2, layer: 'worker', event: 'rpc-rejected', detail: 'wrong-generation', hasPort: true
    };
    const expected = { ...input };
    const output = sanitizeData(input);
    expect(output).toEqual(expected);
    expect(output).not.toBe(input);
    expect(sanitizeEvent('transport.event', input)).toEqual({ code: 'transport.event', data: expected });
    input.traceId = 'private';
    input.runtimeCount = 33;
    expect(output).toEqual(expected);
});

test('all legacy and return-path event and detail enums are closed and exact', () => {
    const events = [
        'receiver-ready', 'discovery', 'discovery-reply', 'discovery-timeout', 'handoff', 'port-ready',
        'hello-received', 'hello-replied', 'wire-received', 'wire-replied', 'wire-error', 'receipt',
        'suppressed', 'unavailable', 'discovery-received', 'discovery-sent', 'discovery-rejected',
        'port-received', 'port-rejected', 'rpc-sent', 'rpc-received', 'rpc-accepted', 'rpc-rejected', 'runtime-duplicate'
    ] as const satisfies readonly NonNullable<DiagnosticData['event']>[];
    const details = [
        'wrong-source', 'wrong-address', 'wrong-host', 'wrong-origin', 'wrong-generation',
        'wrong-port', 'wrong-shape', 'bad-signature', 'no-pending', 'expired', 'closed',
        'not-selected', 'duplicate-runtime', 'legacy', 'matched'
    ] as const satisfies readonly NonNullable<DiagnosticData['detail']>[];
    for (const [key, values] of [['event', events], ['detail', details]] as const) {
        expect(new Set(values).size).toBe(values.length);
        for (const value of values) {
            expect(sanitizeData({ [key]: value })).toEqual({ [key]: value });
            for (const invalid of [value.toUpperCase(), value + '\n', ' ' + value]) {
                expect(sanitizeData({ [key]: invalid })).toEqual({});
            }
        }
        for (const invalid of ['private', 'https://private.test', 'password=private', 'duplicate', null, {}, true]) {
            expect(sanitizeData({ [key]: invalid })).toEqual({});
        }
    }
});

test('protocol identifiers accept only UUIDs without coercion or whitespace', () => {
    const uuid = '12345678-1234-4abc-8def-123456789abc';
    for (const key of ['traceId', 'portId']) {
        for (const value of [uuid, uuid.toUpperCase(), ...Array.from({ length: 8 }, (_, index) =>
            `12345678-1234-${index + 1}abc-8def-123456789abc`)]) {
            expect(sanitizeData({ [key]: value })).toEqual({ [key]: value });
        }
        for (const value of ['', 'private', 'https://private.test', ` ${uuid}`, `${uuid}\n`,
            uuid.slice(1), uuid + '0', uuid.replace('-4abc-', '-0abc-'), uuid.replace('-4abc-', '-9abc-'),
            uuid.replace('-8def-', '-7def-'), '00000000-0000-0000-0000-000000000000',
            null, undefined, 123, {}, [], new String(uuid), { toString() { throw new Error('must not coerce'); } }]) {
            expect(sanitizeData({ [key]: value, online: true })).toEqual({ online: true });
        }
    }
});

test('runtime count is an integer from zero through 32 and other numeric caps stay bounded', () => {
    for (const [key, maximum] of Object.entries({ elapsedMs: 3_600_000, pending: 10_000,
        ports: 10_000, authorization: 10_000, runtimeCount: 32 })) {
        for (const value of [0, 1, maximum]) expect(sanitizeData({ [key]: value })).toEqual({ [key]: value });
        for (const value of [-1, maximum + 1, Infinity, -Infinity, NaN, '1', true, null, undefined, {}]) {
            expect(sanitizeData({ [key]: value })).toEqual({});
        }
        expect(sanitizeData({ [key]: 1.5 })).toEqual(key === 'elapsedMs' ? { elapsedMs: 1.5 } : {});
    }
});

test('new metadata getters and forbidden fields are dropped without being read', () => {
    const value = Object.create(null);
    for (const key of ['traceId', 'portId', 'runtimeCount', 'event', 'detail', 'url', 'password', 'key']) {
        Object.defineProperty(value, key, { get() { throw new Error('must not collect'); }, enumerable: true });
    }
    value.online = true;
    expect(sanitizeData(value)).toEqual({ online: true });
    expect(sanitizeData(Object.create({ traceId: crypto.randomUUID(), portId: crypto.randomUUID(),
        runtimeCount: 2, detail: 'matched' }))).toEqual({});
    const traceId = crypto.randomUUID();
    expect(sanitizeData({ traceId, runtimeCount: 0, detail: 'matched', url: 'https://private.test',
        password: 'private', key: 'private', [Symbol('private')]: 'private' })).toEqual({ traceId, runtimeCount: 0, detail: 'matched' });
});

test('event names are fixed and output owns a fresh sanitized copy', () => {
    for (const code of [
        'session.started', 'session.stopped', 'page.visible', 'page.hidden', 'page.show', 'page.hide',
        'connect.state', 'connect.action', 'connect.stage', 'connect.error', 'app.locked', 'app.unlocked',
        'app.receiver', 'transport.event', 'command.result'
    ]) expect(sanitizeEvent(code)?.code).toBe(code);
    for (const code of ['password', 'connect.state\nprivate', {}, null, 2]) expect(sanitizeEvent(code)).toBeUndefined();
    const input = { locked: true, url: 'private' };
    const event = sanitizeEvent('app.locked', input)!;
    input.locked = false;
    expect(event).toEqual({ code: 'app.locked', data: { locked: true } });
});

test('non-record input is omitted without coercion or exceptions', () => {
    for (const input of [undefined, null, 3, false, 'private', [], new Date(), () => 'private']) {
        expect(sanitizeData(input)).toEqual({});
    }
});
