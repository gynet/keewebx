import { createRequire } from 'node:module';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const root = path.resolve(import.meta.dir, '../..');
const extension = path.join(root, 'modules/extension');
const require = createRequire(path.join(extension, 'package.json'));
const webpack = require('webpack');
const output = path.resolve(process.env.KW_E2E_COMMAND_CLIENT_DIR || path.join(root, '.cache/extension-command-client'));
await mkdir(output, { recursive: true });
await new Promise<void>((resolve, reject) => webpack({
    mode: 'development', devtool: false, context: extension,
    entry: { background: path.join(import.meta.dir, 'background.ts'), client: path.join(import.meta.dir, 'client.ts'),
        'content-keeweb': path.join(extension, 'src/content/content-keeweb.ts') },
    output: { path: output, filename: 'js/[name].js' },
    module: { rules: [{ test: /\.ts$/, use: { loader: require.resolve('ts-loader'), options: {
        transpileOnly: true, configFile: path.join(extension, 'tsconfig.json'), compilerOptions: { module: 'esnext' }
    } } }] },
    resolve: { extensions: ['.ts', '.js'], modules: [path.join(extension, 'node_modules'), path.join(root, 'node_modules')],
        fallback: { events: path.join(root, 'modules/vault/node_modules/events/events.js') },
        alias: { background: path.join(extension, 'src/background'), common: path.join(extension, 'src/common') } }
}, (error: Error | null, stats: { hasErrors(): boolean; toString(): string }) => {
    if (error || stats.hasErrors()) reject(error || new Error(stats.toString())); else resolve();
}));
await copyFile(path.join(import.meta.dir, 'client.html'), path.join(output, 'client.html'));
await writeFile(path.join(output, 'manifest.json'), JSON.stringify({
    manifest_version: 3, name: 'Compatible command client', version: '1.0.0',
    permissions: ['tabs', 'scripting', 'storage'], host_permissions: ['http://localhost/*', 'http://127.0.0.1/*'],
    background: { service_worker: 'js/background.js' }
}, null, 2));
console.log('Compatible command client built.');
