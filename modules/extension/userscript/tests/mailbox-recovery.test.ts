import { afterEach, expect, test } from 'bun:test';
import { MailboxRecovery, MAILBOX_RECOVERY_MS, type RecoveryRoute } from '../src/mailbox-recovery';

const originalNow = Date.now;
let now = 1_000_000;
afterEach(() => { Date.now = originalNow; now = 1_000_000; });
const href = 'https://login.example.org/login';
function fixture() {
    Date.now = () => now;
    const recovery = new MailboxRecovery();
    const route: RecoveryRoute = { host: crypto.randomUUID(), owner: crypto.randomUUID(),
        endpoint: 'https://keewebx.app/app', publicKey: 'public-fixture-key', authorizationRevision: 4,
        mailbox: true, messagePort: 1 };
    const first = recovery.begin(route, href);
    return { recovery, route, first, verify() { recovery.verified(first, route, href, now); } };
}

test('a successful mailbox reply allows a fresh operation without rediscovering the same App', () => {
    const f = fixture(); expect(f.first.mailbox).toBe(false);
    f.verify(); now += 4000;
    const next = f.recovery.begin(f.route, href);
    expect(next.mailbox).toBe(true); expect(next.epoch).not.toBe(f.first.epoch);
});
test.each(['host', 'owner', 'endpoint', 'publicKey', 'authorizationRevision', 'mailbox', 'messagePort'] as const)
('a changed %s invalidates recovery and fences the old operation', field => {
    const f = fixture(); f.verify();
    const route = { ...f.route, [field]: typeof f.route[field] === 'number' ? 5 : typeof f.route[field] === 'boolean' ? false : 'different' };
    f.recovery.refresh(route as RecoveryRoute, href);
    expect(f.recovery.current(f.first)).toBe(false);
    f.verify();
    expect(f.recovery.begin(route as RecoveryRoute, href).mailbox).toBe(false);
});
test.each([MAILBOX_RECOVERY_MS, MAILBOX_RECOVERY_MS + 1, -1])('a proof is not reused outside its recent interval (%i ms)', elapsed => {
    const f = fixture(); f.verify(); now += elapsed;
    expect(f.recovery.begin(f.route, href).mailbox).toBe(false);
});
test('a delayed connection continuation cannot renew an old receipt', () => {
    const f = fixture(), receivedAt = now;
    now += MAILBOX_RECOVERY_MS;
    f.recovery.verified(f.first, f.route, href, receivedAt);
    expect(f.recovery.begin(f.route, href).mailbox).toBe(false);
});
test.each([NaN, Infinity, 1_000_001])('invalid receipt time %s never creates a preference', receivedAt => {
    const f = fixture(); f.recovery.verified(f.first, f.route, href, receivedAt);
    expect(f.recovery.begin(f.route, href).mailbox).toBe(false);
});
test('route removal, navigation and document departure invalidate old replies', () => {
    for (const cause of ['removed', 'navigation', 'departure']) {
        const f = fixture(); f.verify();
        if (cause === 'removed') f.recovery.refresh(undefined, href);
        if (cause === 'navigation') f.recovery.refresh(f.route, href + '?other');
        if (cause === 'departure') f.recovery.clear();
        f.verify();
        expect(f.recovery.begin(f.route, href).mailbox).toBe(false);
    }
});
test('explicit reconnect retries direct discovery instead of retaining a mailbox preference', () => {
    const f = fixture(); f.verify();
    expect(f.recovery.begin(f.route, href, true).mailbox).toBe(false);
    f.verify();
    expect(f.recovery.begin(f.route, href).mailbox).toBe(false);
});
test('current failure drops the preference while an older operation cannot clear a newer proof', () => {
    const f = fixture(); f.verify();
    const next = f.recovery.begin(f.route, href);
    f.recovery.verified(next, f.route, href, now);
    f.recovery.failed(f.first);
    const last = f.recovery.begin(f.route, href); expect(last.mailbox).toBe(true);
    f.recovery.failed(last);
    expect(f.recovery.begin(f.route, href).mailbox).toBe(false);
});
test('a late success from an older operation cannot overwrite a current failure', () => {
    const f = fixture(); f.verify();
    const next = f.recovery.begin(f.route, href); f.recovery.failed(next);
    f.verify();
    expect(f.recovery.begin(f.route, href).mailbox).toBe(false);
});
test('a new valid reply can recover the same attempt after its earlier handshake timeout', () => {
    const f = fixture(); f.recovery.failed(f.first); f.verify();
    expect(f.recovery.begin(f.route, href).mailbox).toBe(true);
});

test('a first mobile attempt with mailbox capability skips discovery and its next retry can use direct', () => {
    const { recovery, route } = fixture();
    const first = recovery.begin(route, href, false, true);
    expect(first.mailbox).toBe(true);
    recovery.preferDirect(first, route, href);
    recovery.failed(first);
    const retry = recovery.begin(route, href, false, true);
    expect(retry.mailbox).toBe(false);
    recovery.failed(retry);
    expect(recovery.begin(route, href, false, true).mailbox).toBe(true);
});

test('a direct retry is bound to the last attempt, exact grant and website URL', () => {
    const { recovery, route, first } = fixture();
    const second = recovery.begin(route, href, false, true);
    recovery.preferDirect(first, route, href);
    expect(recovery.begin(route, href, false, true).mailbox).toBe(true);
    recovery.preferDirect(second, route, href);
    const latest = recovery.begin(route, href, false, true);
    recovery.preferDirect(latest, route, href);
    const newRoute = { ...route, host: crypto.randomUUID() };
    const newAttempt = recovery.begin(newRoute, href, false, true);
    expect(newAttempt.mailbox).toBe(true);
    recovery.preferDirect(newAttempt, newRoute, href);
    expect(recovery.begin(newRoute, href + '?new', false, true).mailbox).toBe(true);
    expect(recovery.begin({ ...newRoute, mailbox: false }, href, false, true).mailbox).toBe(false);
});
