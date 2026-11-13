import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const resolve = createRequire(require.resolve('../../modules/ui/node_modules/webpack'))('enhanced-resolve');

test('both builds resolve injected hooks before the public fallback', () => {
    const extra = mkdtempSync(path.join(tmpdir(), 'keewebx-hooks-'));
    const previous = process.env.KEEWEBX_EXTRA_SOURCE_DIR;
    try {
        mkdirSync(path.join(extra, 'hooks'));
        writeFileSync(path.join(extra, 'hooks/init.ts'), 'export const fixture = true;');
        process.env.KEEWEBX_EXTRA_SOURCE_DIR = extra;
        for (const ui of ['ui', 'ui-classic']) {
            const filename = require.resolve(`../../modules/${ui}/webpack.config.js`);
            delete require.cache[filename];
            const config = require(filename)({}, { mode: 'production' });
            const resolver = resolve.create.sync(config.resolve);
            expect(resolver(path.resolve(`modules/${ui}`), 'hooks/init')).toBe(path.join(extra, 'hooks/init.ts'));
            // Missing injected modules still resolve to the shared public registry.
            expect(resolver(path.resolve(`modules/${ui}`), 'hooks/data-registry'))
                .toBe(path.resolve('modules/vault/src/hooks/data-registry.ts'));
        }
    } finally {
        if (previous === undefined) delete process.env.KEEWEBX_EXTRA_SOURCE_DIR;
        else process.env.KEEWEBX_EXTRA_SOURCE_DIR = previous;
        rmSync(extra, { recursive: true, force: true });
    }
});
