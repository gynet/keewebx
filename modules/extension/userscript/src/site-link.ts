export const SETUP_MARK = 'keewebx-connect-relay-setup-v1';
const TIMEOUT = 8000;
const httpsOrigin = (value: string) => /^https:\/\/[^/]+$/.test(value);

/** Pins native window identity and origin before associating a website. */
export class SiteLink {
    private peer: Window | null;
    private origin?: string;
    private pending?: { peer: Window; origin?: string; nonce: string; deadline: number };
    private timer?: ReturnType<typeof setInterval>;

    constructor(peer: Window | null, private linked: (peer: Window, origin: string) => void,
        private waiting: (expired: boolean) => void = () => {},
        private options: { followOpener?: boolean; routingId?: string; endpoint?: string } = {}) {
        this.peer = peer;
        addEventListener('message', this.receive);
    }

    expect(peer: Window, origin?: string): void {
        this.pause(); this.peer = peer; this.origin = origin;
        this.challenge(peer, origin);
    }

    restart(): void {
        if (this.options.followOpener && window.opener) this.peer = window.opener;
        if (this.peer && !this.peer.closed) this.challenge(this.peer, this.options.followOpener ? undefined : this.origin);
    }
    recover(): void {
        if (this.options.followOpener && window.opener && window.opener !== this.peer) { this.restart(); return; }
        if (this.pending && Date.now() < this.pending.deadline) this.send(); else this.restart();
    }

    private challenge(peer: Window, origin?: string): void {
        this.pause();
        this.pending = { peer, origin, nonce: crypto.randomUUID(), deadline: Date.now() + TIMEOUT };
        this.waiting(false); this.send();
        this.timer = setInterval(() => this.send(), 400);
    }

    private send(): void {
        const pending = this.pending;
        if (!pending) return;
        if (Date.now() >= pending.deadline || pending.peer.closed) {
            this.pause(); this.waiting(true); return;
        }
        // The wildcard is limited to a non-secret challenge for the initial opener.
        pending.peer.postMessage({ marker: SETUP_MARK, kind: 'ready', nonce: pending.nonce, routingId: this.options.routingId, endpoint: this.options.endpoint }, pending.origin || '*');
    }

    private receive = (event: MessageEvent) => {
        if (!event.isTrusted || !event.source || event.source === window || !httpsOrigin(event.origin) ||
            event.data?.marker !== SETUP_MARK || event.data.routingId !== this.options.routingId || event.data.endpoint !== this.options.endpoint) return;
        const peer = event.source as Window;
        if (event.data.kind === 'reconnect') {
            // A new window may reuse the helper only for the already pinned origin.
            if (this.origin ? event.origin !== this.origin && !(this.options.followOpener && peer === this.peer) : peer !== this.peer) return;
            const pending = this.pending;
            if (pending && pending.peer === peer && pending.origin === event.origin && Date.now() < pending.deadline) this.send();
            else this.challenge(peer, event.origin);
            return;
        }
        const pending = this.pending;
        if (event.data.kind !== 'site' || !pending || peer !== pending.peer ||
            (pending.origin && pending.origin !== event.origin) || event.data.nonce !== pending.nonce) return;
        // A delayed browser event proves reachability, but cannot extend an expired proof.
        if (Date.now() >= pending.deadline) { this.challenge(peer, event.origin); return; }
        this.pause(); this.pending = undefined;
        this.peer = peer; this.origin = event.origin;
        this.linked(peer, event.origin);
    };

    pause(): void { clearInterval(this.timer); this.timer = undefined; }
    dispose(): void { this.pause(); this.pending = undefined; removeEventListener('message', this.receive); }
}
