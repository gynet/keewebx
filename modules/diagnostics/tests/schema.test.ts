import { expect, test } from 'bun:test';
import { sanitizeData, sanitizeEvent } from '../src';

test('data accepts only flat, exact primitive fields and fixed enums', () => {
    expect(sanitizeData({
        locked: false, authorized: true, authorizing: false, selected: true, live: true,
        direct: false, hasSession: true, hasPort: false, online: true, visible: false, persisted: true,
        elapsedMs: 1.5, pending: 2, ports: 3, authorization: 4,
        layer: 'app', state: 'Connected', action: 'probe', stage: 'restore', event: 'receipt', reason: 'locked',
        url: 'https://private', message: 'error', useragent: 'private', account: 'private', password: 'private',
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
