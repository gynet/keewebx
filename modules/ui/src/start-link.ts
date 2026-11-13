export type StartLink = { kind: 'demo' } | { kind: 'webdav'; url: string } | { kind: 'error'; message: string };

/** Remote file links only prefill a form; they never transmit credentials or unlock. */
export function readStartLink(): StartLink | undefined {
    const hash = location.hash.slice(1);
    const params = new URLSearchParams(hash);
    const demo = hash === 'demo' || params.get('demo') === '1' || new URLSearchParams(location.search).get('demo') === '1';
    if (!demo && !params.has('open')) return;
    // Consume the intent once and keep remote addresses out of subsequent navigation.
    const current = new URL(location.href);
    current.hash = ''; current.searchParams.delete('demo');
    history.replaceState(history.state, '', current.pathname + current.search);
    if (demo && params.has('open')) return { kind: 'error', message: 'Choose either a demo link or a database link.' };
    if (demo) return { kind: 'demo' };
    try {
        const raw = params.get('open') ?? '';
        // eslint-disable-next-line no-control-regex
        if (/[\x00-\x1f\x7f\\]/.test(raw)) throw new Error('Invalid address');
        const url = new URL(raw);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid address');
        return { kind: 'webdav', url: url.href };
    } catch { return { kind: 'error', message: 'This database link is invalid. Use an HTTP or HTTPS file address without embedded credentials.' }; }
}
