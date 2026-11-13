import { test, expect } from 'bun:test';
import { safeLogs, diagnosticsText } from '../src/diagnostics-data';

test('summaries never read protected values, getters, cyclic objects or arbitrary log text', () => {
    const value: Record<string, unknown> = {};
    value.self = value;
    Object.defineProperty(value, 'password', { get() { throw new Error('must not inspect'); } });
    value.getText = () => { throw new Error('must not unwrap'); };
    const logs = safeLogs([
        { level: 'error', args: ['2026-11-13T00:00:00.000Z [sync:Secret vault] Sync error token=secret', value] },
        { level: 'warn', args: ['2026-11-13T00:00:00.000Z [<script>secret</script>] <img onerror=secret>', 'password-secret'] },
        { level: '<script>', args: [value] }
    ]);
    expect(logs[0]).toEqual({ level: 'error', time: '2026-11-13T00:00:00.000Z', source: 'sync', message: 'Synchronization failed' });
    expect(JSON.stringify(logs)).not.toMatch(/secret|Secret|script|password|token/);
    expect(logs[1].source).toBe('Application');
    expect(logs[2].level).toBe('info');
});
test('logs preserve ordered operation summaries and bound the snapshot', () => {
    const logs = safeLogs(Array.from({ length: 105 }, (_, n) => ({ level: 'info', args: [`2026-11-13T00:00:00.000Z [sync:${n}] Sync started`] })));
    expect(logs).toHaveLength(100);
    expect(logs.every(log => log.message === 'Synchronization started')).toBe(true);
});
test('diagnostics contain only explicit build and browser information with bounded control-free values', () => {
    const value = diagnosticsText({ version: '1.2.3', buildDate: '2026-11-13', commit: '' }, 'Browser\nInjected\0' + 'x'.repeat(900));
    expect(value).toStartWith('KeeWebX 1.2.3\nBuild: 2026-11-13\nCommit: unavailable\nEnvironment: web\nBrowser: Browser Injected ');
    expect(value).not.toContain('\0');
    expect(value.length).toBeLessThan(650);
});
