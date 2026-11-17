import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('the production installer has no support upload capability or UI', () => {
    const source = readFileSync(new URL('../keewebx-connect.user.js', import.meta.url), 'utf8');
    for (const retired of ['GM.xmlHttpRequest', '/api/connect-diagnostics', 'Enable remote diagnostics',
        'Connection diagnostics', 'Support ID:']) expect(source).not.toContain(retired);
    expect(source).not.toMatch(/^\/\/ @connect\s/m);
});

test('the App connector and handoff worker have no support event hooks', () => {
    const app = readFileSync(new URL('../../../vault/src/comp/extension/browser-extension-connector.ts', import.meta.url), 'utf8');
    const worker = readFileSync(new URL('../../../ui/connect-port/worker.js', import.meta.url), 'utf8');
    for (const source of [app, worker]) {
        expect(source).not.toContain('kwDiagnostics');
        expect(source).not.toContain('connect-diagnostics');
        expect(source).not.toContain('recordConnectDiagnostic');
    }
});
