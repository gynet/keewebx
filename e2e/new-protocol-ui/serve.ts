import { createRequire } from 'node:module';
import path from 'node:path';
const root = path.resolve(import.meta.dir, '../..');
const require = createRequire(path.join(root, 'modules/ui/package.json'));
const webpack = require('webpack');
const HtmlWebpackPlugin = require('html-webpack-plugin');
const config = require('../../modules/ui/webpack.config.js')({}, { mode: 'development' });
config.context = path.join(root, 'modules/ui');
config.entry = { fixture: path.join(import.meta.dir, 'fixture.tsx') };
config.output = { path: path.join(root, '.cache/new-protocol-ui/site'), filename: '[name].js', clean: true };
config.resolveLoader = { modules: [path.join(root, 'modules/ui/node_modules'), path.join(root, 'node_modules')] };
config.plugins = config.plugins.filter((plugin: { constructor: { name: string } }) => plugin.constructor.name !== 'HtmlWebpackPlugin');
config.plugins.push(new HtmlWebpackPlugin({ filename: 'index.html', templateContent:
    '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Extension UI fixture</title></head><body><div id="root"></div></body></html>' }));
await new Promise<void>((resolve, reject) => webpack(config, (error: Error | null, stats: { hasErrors(): boolean; toString(): string }) => {
    if (error || stats.hasErrors()) reject(error || new Error(stats.toString())); else resolve();
}));
const port = Number(process.env.KEEWEBX_E2E_PORT || 8097);
Bun.serve({ hostname: '127.0.0.1', port, async fetch(request) {
    const pathname = new URL(request.url).pathname;
    const target = path.resolve(config.output.path, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (!target.startsWith(config.output.path + path.sep)) return new Response('', { status: 403 });
    const file = Bun.file(target);
    return await file.exists() ? new Response(file) : new Response('', { status: 404 });
} });
console.log(`Extension UI fixture listening on http://127.0.0.1:${port}`);
