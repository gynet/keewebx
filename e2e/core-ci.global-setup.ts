import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

// Fail before starting any browser if the production build is incomplete.
// In particular, offline.spec.ts must not silently skip a missing service worker.
export default async function requireCoreBuild() {
    for (const file of ['index.html', 'next.html', 'js/app.js', 'js/next.js', 'css/next.css', 'service-worker.js']) {
        const artifact = resolve(__dirname, '../dist', file);
        try {
            await access(artifact);
        } catch {
            throw new Error(`Core CI requires a complete build; missing ${artifact}. Run KEEWEBX_NEW_EXTENSION=1 bun run build first.`);
        }
    }
}
