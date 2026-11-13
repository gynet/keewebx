import { createRequire } from 'node:module';
import path from 'node:path';
const root = path.resolve(import.meta.dir, '../..');
const require = createRequire(path.join(root, 'modules/ui/package.json'));
const webpack = require('webpack');
const config = require('../../modules/ui/webpack.config.js')({}, { mode: 'development' });
config.context = path.join(root, 'modules/ui');
config.entry = { next: path.join(import.meta.dir, 'fixture.ts') };
config.output = { path: process.env.KEEWEBX_BACKUP_BUILD_DIR || path.join(root, '.cache/backup/site'), filename: 'js/[name].js', clean: true };
config.resolveLoader = { modules: [path.join(root, 'modules/ui/node_modules'), path.join(root, 'node_modules')] };
if (!process.env.KEEWEBX_BACKUP_REUSE_BUILD) await new Promise<void>((resolve, reject) => webpack(config, (error: Error | null, stats: { hasErrors(): boolean; toString(): string }) => {
    if (error || stats.hasErrors()) reject(error || new Error(stats.toString())); else resolve();
}));
let fail = false, hold = false;
let uploads: { path: string; data: string; options: string | null; account: string | null; failed: boolean }[] = [];
const pending: (() => void)[] = [];
const port = Number(process.env.KEEWEBX_E2E_PORT || 8155);
Bun.serve({ hostname: '127.0.0.1', port, async fetch(request) {
    const pathname = new URL(request.url).pathname;
    if (pathname === '/backup-control') {
        if (request.method === 'POST') {
            const body = await request.json();
            if (body.release || body.reset) { hold = false; pending.splice(0).forEach(resolve => resolve()); }
            if (body.reset) { uploads = []; fail = false; }
            if (typeof body.fail === 'boolean') fail = body.fail;
            if (typeof body.hold === 'boolean') hold = body.hold;
        }
        return Response.json({ uploads });
    }
    if (pathname.startsWith('/backup-api/')) {
        if (request.method === 'HEAD') return new Response(null, { status: 200 });
        if (request.method !== 'PUT') return new Response(null, { status: 405 });
        const failed = fail;
        uploads.push({ path: decodeURIComponent(pathname.slice('/backup-api/'.length)),
            data: Buffer.from(await request.arrayBuffer()).toString('base64'), options: request.headers.get('X-Backup-Options'),
            account: request.headers.get('X-Backup-Account'), failed });
        if (hold) await new Promise<void>(resolve => pending.push(resolve));
        return new Response(null, { status: failed ? 503 : 201 });
    }
    const target = path.resolve(config.output.path, '.' + (pathname === '/' ? '/next.html' : pathname));
    if (!target.startsWith(config.output.path + path.sep)) return new Response('', { status: 403 });
    const file = Bun.file(target);
    return await file.exists() ? new Response(file) : new Response('', { status: 404 });
} });
console.log(`Backup fixture listening on http://127.0.0.1:${port}`);
