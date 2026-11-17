import { expect, test } from 'bun:test';
import { claimRuntime } from '../src/runtime-owner';

test('the document reserves one runtime before asynchronous initialization', async () => {
    const scope = {}, document = {};
    let starts = 0, duplicates = 0;
    const install = async () => {
        const runtime = claimRuntime(scope, document);
        if (!runtime) return;
        runtime.onDuplicate(() => { duplicates++; });
        await Promise.resolve();
        starts++;
    };
    await Promise.all([install(), install(), install()]);
    expect(starts).toBe(1);
    expect(duplicates).toBe(2);
});

test('a replaced document can create its own runtime', () => {
    const scope = {};
    expect(claimRuntime(scope, {})).toBeDefined();
    expect(claimRuntime(scope, {})).toBeDefined();
});

test('separate script worlds do not imply an authorization relationship', () => {
    const document = {};
    expect(claimRuntime({}, document)).toBeDefined();
    expect(claimRuntime({}, document)).toBeDefined();
});
