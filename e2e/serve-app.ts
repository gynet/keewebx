import { resolve, sep } from 'node:path';

const root = resolve(import.meta.dir, '../packages/core/dist');
const previewRoot = process.env.KEEWEBX_PREVIEW_DIST ? resolve(process.env.KEEWEBX_PREVIEW_DIST) : null;

Bun.serve({
    hostname: '127.0.0.1',
    port: Number(process.env.KEEWEBX_E2E_PORT || 8085),
    async fetch(request) {
        let pathname: string;
        try {
            pathname = decodeURIComponent(new URL(request.url).pathname);
        } catch {
            return new Response('Bad request', { status: 400 });
        }
        let directory = root;
        if (previewRoot && pathname === '/preview') {
            return Response.redirect(new URL('/preview/', request.url), 302);
        }
        if (previewRoot && pathname.startsWith('/preview/')) {
            if (pathname === '/preview/index.html') {
                return Response.redirect(new URL('/app?ui=classic', request.url), 302);
            }
            directory = previewRoot;
            pathname = pathname === '/preview/' ? '/next.html' : pathname.slice('/preview'.length);
        } else if (pathname === '/app') {
            pathname = '/index.html';
        }
        const filePath = resolve(directory, `.${pathname.endsWith('/') ? pathname + 'index.html' : pathname}`);
        if (!filePath.startsWith(directory + sep)) {
            return new Response('Forbidden', { status: 403 });
        }
        const file = Bun.file(filePath);
        if (!(await file.exists())) {
            return new Response('Not found', { status: 404 });
        }
        return new Response(file, { headers: { 'Cache-Control': 'no-store' } });
    }
});
