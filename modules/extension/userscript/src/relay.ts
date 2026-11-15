import { AppBridge, type ConnectBridge } from './app-bridge';
import { object, uuid, isId } from './native-rpc';

const MARK = 'keewebx-connect-relay-v1';
const DISCOVERY_TTL = 120000;
const REQUEST_TTL = 65000;
interface Frame {
    marker: typeof MARK;
    kind: 'discover' | 'available' | 'claim' | 'commit' | 'ready' | 'wire' | 'reply' | 'reset' | 'notice' | 'leave' | 'decline' | 'focus';
    helper: string;
    discovery: string;
    host?: string;
    token?: string;
    id?: string;
    epoch?: number;
    site?: string;
    sentAt: number;
    deadline: number;
    body?: any;
    error?: string;
}
export interface PairingRequest { helper: string; discovery: string; site: string; deadline: number; }
const channelName = (endpoint: URL) => `${MARK}:${endpoint.pathname.replace(/\/$/, '')}`;
const valid = (data: unknown): data is Frame => object(data) && data.marker === MARK &&
    isId(data.helper) && isId(data.discovery) &&
    ['discover', 'available', 'claim', 'commit', 'ready', 'wire', 'reply', 'reset', 'notice', 'leave', 'decline', 'focus'].includes(data.kind) &&
    Number.isFinite(data.sentAt) && Number.isFinite(data.deadline) &&
    data.sentAt <= Date.now() + 1000 && data.deadline > Date.now() &&
    data.deadline > data.sentAt && data.deadline - data.sentAt <= DISCOVERY_TTL;
const frame = (kind: Frame['kind'], link: Pick<Frame, 'helper' | 'discovery'>, detail: Partial<Frame> = {}): Frame => {
    const sentAt = Date.now();
    return { marker: MARK, kind, helper: link.helper, discovery: link.discovery, sentAt, deadline: sentAt + REQUEST_TTL, ...detail };
};

/** Runs in an existing vault document. Discovery never grants vault access. */
export class RelayHost {
    readonly id = uuid();
    private channel: BroadcastChannel;
    private pending?: PairingRequest;
    private reservation?: { request: PairingRequest; deadline: number; resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };
    private link?: { helper: string; discovery: string; token: string; epoch: number; deadline: number; discoveryDeadline: number; authorizing: boolean };
    private bridge?: AppBridge;
    private live = true;
    constructor(endpoint: URL, private onPairing: (request?: PairingRequest) => void, private onCanceled = () => {}) {
        this.channel = new BroadcastChannel(channelName(endpoint));
        this.channel.addEventListener('message', this.receive);
    }
    private send(kind: Frame['kind'], link: Pick<Frame, 'helper' | 'discovery'>, detail: Partial<Frame> = {}): void {
        if (this.live) this.channel.postMessage(frame(kind, link, { host: this.id, ...detail }));
    }
    private receive = (event: MessageEvent) => {
        if (!this.live || !event.isTrusted || event.origin !== location.origin || !valid(event.data)) return;
        const data = event.data;
        if (data.kind === 'discover') {
            let site: URL;
            try { site = new URL(data.site || ''); } catch { return; }
            if (site.protocol !== 'https:' || site.origin !== data.site || site.origin === location.origin) return;
            this.send('available', data);
            if (this.link?.helper === data.helper && this.link.discovery === data.discovery) return;
            if (!this.pending || this.pending.deadline <= Date.now()) {
                this.pending = { helper: data.helper, discovery: data.discovery, site: site.origin, deadline: data.deadline };
                this.onPairing(this.pending);
            }
            return;
        }
        if (data.host !== this.id) return;
        if (data.kind === 'commit') {
            const reservation = this.reservation;
            if (!reservation || reservation.deadline <= Date.now() || reservation.request.deadline <= Date.now() || reservation.request.helper !== data.helper || reservation.request.discovery !== data.discovery ||
                !isId(data.token)) return;
            clearTimeout(reservation.timer); this.reservation = undefined;
            this.detach('Another connection was selected.');
            this.link = { helper: data.helper, discovery: data.discovery, token: data.token, epoch: 0, deadline: reservation.deadline, discoveryDeadline: reservation.request.deadline, authorizing: false };
            reservation.resolve(); return;
        }
        const link = this.link;
        if (!link || link.helper !== data.helper || link.discovery !== data.discovery || link.token !== data.token) return;
        if (data.kind === 'leave') { this.detach('The connection page closed.', true); return; }
        if (data.kind === 'reset') {
            if (Number.isSafeInteger(data.epoch) && data.epoch! > link.epoch) {
                link.epoch = data.epoch!; this.bridge?.reset();
            }
            return;
        }
        if (data.kind !== 'wire' || !this.bridge || data.epoch !== link.epoch || !isId(data.id) ||
            data.deadline - data.sentAt > REQUEST_TTL) return;
        const epoch = link.epoch;
        const bridge = this.bridge;
        void bridge.request(data.body, data.deadline).then(body => {
            if (this.link === link && link.epoch === epoch && this.bridge === bridge && Date.now() < data.deadline) {
                this.send('reply', link, { token: link.token, epoch, id: data.id, deadline: data.deadline, body });
            }
        }).catch(error => {
            if (this.link === link && link.epoch === epoch && this.bridge === bridge && Date.now() < data.deadline) {
                this.send('reply', link, { token: link.token, epoch, id: data.id, deadline: data.deadline, error: error instanceof Error ? error.message : 'The vault request failed.' });
            }
        });
    };
    async reserve(): Promise<void> {
        const request = this.pending;
        if (!request || request.deadline <= Date.now()) throw new Error('The pairing request expired. Find app tabs again.');
        if (this.reservation) throw new Error('A pairing confirmation is already in progress.');
        const deadline = Math.min(Date.now() + 8000, request.deadline);
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.reservation?.request === request) { this.reservation = undefined; reject(new Error('Another app tab was selected, or the connection page is unavailable.')); }
            }, Math.min(8000, request.deadline - Date.now()));
            this.reservation = { request, deadline, resolve, reject, timer };
            this.send('claim', request, { deadline });
        });
        if (!this.link || Date.now() >= this.link.deadline) throw new Error('The app confirmation expired. Find app tabs again.');
    }
    beginAuthorization(): void {
        if (!this.link || Date.now() >= this.link.deadline) throw new Error('The app confirmation expired.');
        this.link.authorizing = true; this.link.deadline = Math.min(Date.now() + REQUEST_TTL, this.link.discoveryDeadline);
    }
    get authorizationDeadline(): number { return this.link?.deadline || 0; }
    assertAuthorization(): void {
        if (!this.link?.authorizing || Date.now() >= this.link.deadline) throw new Error('The app authorization expired or was canceled.');
    }
    complete(): void {
        this.assertAuthorization();
        const link = this.link;
        if (!link) throw new Error('The connection was canceled before authorization completed.');
        this.bridge = new AppBridge();
        this.bridge.onLocked = () => { if (this.link === link) this.send('notice', link, { token: link.token, body: { kind: 'locked' } }); };
        this.bridge.onAttention = () => { if (this.link === link) this.send('notice', link, { token: link.token, body: { kind: 'attention' } }); };
        this.pending = undefined; this.onPairing();
        this.send('ready', link, { token: link.token });
    }
    get connected(): boolean { return !!this.link && !!this.bridge; }
    returnToSite(): void { if (this.link) this.send('focus', this.link, { token: this.link.token }); }
    decline(): void {
        if (this.pending) this.send('decline', this.pending);
        this.pending = undefined; this.onPairing();
    }
    private detach(reason: string, canceled = false): void {
        if (this.link) this.send('notice', this.link, { token: this.link.token, body: { kind: 'disconnected', message: reason } });
        const hadLink = !!this.link;
        this.link = undefined; this.bridge?.dispose(); this.bridge = undefined;
        if (canceled && hadLink) this.onCanceled();
    }
    revoke(): void {
        if (this.reservation) { clearTimeout(this.reservation.timer); this.reservation.reject(new Error('Pairing was canceled.')); this.reservation = undefined; }
        this.detach('Disconnected in KeeWebX.'); this.pending = undefined; this.onPairing();
    }
    dispose(): void { this.revoke(); this.live = false; this.channel.removeEventListener('message', this.receive); this.channel.close(); }
}

/** The helper forwards encrypted wire messages; it never decrypts credentials. */
export class RelayClientBridge implements ConnectBridge {
    readonly helper = uuid();
    readonly discovery = uuid();
    private channel: BroadcastChannel;
    private candidates = new Set<string>();
    private selected?: { host: string; token: string };
    private epoch = 0;
    private ready = false;
    private discoveryDeadline = Date.now() + DISCOVERY_TTL;
    private live = true;
    private pending = new Map<string, { deadline: number; epoch: number; resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
    onLocked = () => {};
    onAttention = () => {};
    onReturn = () => {};
    constructor(endpoint: URL, readonly site: string, private update: (state: 'searching' | 'available' | 'confirming' | 'connected' | 'disconnected', count: number) => void) {
        this.channel = new BroadcastChannel(channelName(endpoint));
        this.channel.addEventListener('message', this.receive);
    }
    get candidateCount(): number { return this.candidates.size; }
    private send(kind: Frame['kind'], detail: Partial<Frame> = {}): void {
        if (this.live) this.channel.postMessage(frame(kind, this, { host: this.selected?.host, token: this.selected?.token, ...detail }));
    }
    get connected(): boolean { return this.ready && !!this.selected; }
    discover(): void { this.update('searching', 0); this.send('discover', { site: this.site, deadline: this.discoveryDeadline }); }
    private receive = (event: MessageEvent) => {
        if (!this.live || !event.isTrusted || event.origin !== location.origin || !valid(event.data)) return;
        const data = event.data;
        if (data.helper !== this.helper || data.discovery !== this.discovery || !isId(data.host)) return;
        if (data.kind === 'available' && !this.selected) {
            this.candidates.add(data.host); this.update('available', this.candidates.size); return;
        }
        if (data.kind === 'decline' && !this.selected) { this.candidates.delete(data.host); this.update('available', this.candidates.size); return; }
        if (data.kind === 'claim' && Date.now() < this.discoveryDeadline && this.candidates.has(data.host)) {
            if (this.selected && this.selected.host !== data.host) return;
            this.selected ||= { host: data.host, token: uuid() };
            this.send('commit', { deadline: Math.min(data.deadline, this.discoveryDeadline) }); this.update('confirming', this.candidates.size); return;
        }
        if (!this.selected || data.host !== this.selected.host || data.token !== this.selected.token) return;
        if (data.kind === 'focus') { this.onReturn(); return; }
        if (data.kind === 'ready' && Date.now() < this.discoveryDeadline) { this.ready = true; this.update('connected', this.candidates.size); return; }
        if (data.kind === 'notice') {
            if (data.body?.kind === 'attention') this.onAttention();
            else {
                this.reset(); this.onLocked();
                if (data.body?.kind === 'disconnected') { this.ready = false; this.selected = undefined; this.update('disconnected', this.candidates.size); }
            }
            return;
        }
        if (data.kind !== 'reply' || !isId(data.id)) return;
        const pending = this.pending.get(data.id);
        if (!pending || pending.epoch !== data.epoch || pending.deadline !== data.deadline) return;
        clearTimeout(pending.timer); this.pending.delete(data.id);
        if (!this.ready || pending.epoch !== this.epoch || Date.now() >= pending.deadline) pending.reject(new Error('The relayed request expired.'));
        else if (data.error) pending.reject(new Error(data.error));
        else pending.resolve(data.body);
    };
    request(body: any, deadline = Date.now() + REQUEST_TTL): Promise<any> {
        if (!this.live || !this.ready || !this.selected) return Promise.reject(new Error('Confirm the connection in the KeeWebX tab you want to use.'));
        if (deadline <= Date.now() || deadline > Date.now() + REQUEST_TTL || !object(body) || JSON.stringify(body).length > 262144) return Promise.reject(new Error('Invalid or expired relayed request.'));
        const id = uuid(); const epoch = this.epoch;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('The selected KeeWebX tab did not reply.')); this.reset(); }, deadline - Date.now());
            this.pending.set(id, { deadline, epoch, resolve, reject, timer });
            this.send('wire', { id, epoch, deadline, body });
        });
    }
    reset(reason = 'The relayed session was canceled.'): void {
        this.epoch++;
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(reason)); }
        this.pending.clear(); this.send('reset', { epoch: this.epoch });
    }
    dispose(): void {
        if (!this.live) return;
        this.reset(); this.send('leave'); this.live = false;
        this.channel.removeEventListener('message', this.receive); this.channel.close();
    }
}
