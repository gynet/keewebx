import { BackendConnectionState } from '../../src/common/backend-connection-state';

const text = <T extends HTMLElement>(element: T, value: string): T => { element.textContent = value; return element; };
const button = (label: string, name: string) => {
    const el = text(document.createElement('button'), label);
    el.type = 'button'; el.dataset.action = name;
    return el;
};

/** Small extension-style panel. Metadata lives in a closed shadow tree. */
export class ConnectUI {
    readonly host = document.createElement('div');
    private shadow = this.host.attachShadow({ mode: 'closed' });
    readonly toggle = button('KeeWebX Connect', 'toggle');
    readonly panel = document.createElement('section');
    readonly status = text(document.createElement('p'), 'Not connected');
    readonly address = document.createElement('input');
    readonly targetSite = document.createElement('input');
    readonly save = button('Save address', 'save');
    readonly open = button('Open KeeWebX', 'open');
    readonly authorize = button('Authorize Connect', 'authorize');
    readonly returnToSite = button('Back to site', 'return');
    readonly revoke = button('Disconnect', 'revoke');
    readonly lookup = button('Find accounts', 'lookup');
    readonly probe = button('Test connection', 'probe');
    readonly pair = button('Connect this tab', 'pair');
    readonly decline = button('Decline', 'decline');
    readonly list = document.createElement('div');
    private pairingCard = document.createElement('div');
    private pairingOrigin = document.createElement('p');
    private accounts = document.createElement('div');
    private config = document.createElement('div');
    private dot = document.createElement('span');
    private accountTab = button('Accounts', 'accounts-tab');
    private configTab = button('Connection', 'config-tab');
    private close = button('Close', 'close');
    onClose = () => {};
    onConfig = () => {};
    onOpen = (_event: MouseEvent) => {};
    private field?: HTMLInputElement;

    constructor(readonly app: boolean, endpoint: string) {
        this.host.id = 'keewebx-userscript-connect';
        this.host.style.cssText = 'position:fixed;right:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));z-index:2147483647;';
        const style = document.createElement('style');
        style.textContent = `
          :host{all:initial;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark;--bg:#fff;--ink:#192337;--muted:#63718a;--line:#dee5ef;--soft:#f3f6fb;--accent:#1769e0;color:var(--ink)}
          *{box-sizing:border-box}button,input{font:inherit}button{cursor:pointer;min-height:42px;border:1px solid var(--line);border-radius:10px;padding:9px 12px;color:var(--ink);background:var(--soft);font-weight:550}button:disabled{opacity:.5;cursor:default}button:hover{filter:brightness(.97)}button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
          section{position:absolute;right:0;bottom:52px;width:min(348px,calc(100vw - 24px));max-height:calc(100dvh - 92px);overflow:auto;background:var(--bg);border:1px solid var(--line);border-radius:18px;padding:16px;box-shadow:0 12px 44px #142b4b30}section[hidden],[hidden]{display:none!important}header{display:flex;align-items:center;justify-content:space-between;gap:10px}h2{font-size:17px;line-height:1.4;margin:0;font-weight:650}.close{min-width:38px;min-height:38px;padding:6px;background:transparent;border:0;font-size:20px}.tabs{display:flex;gap:4px;background:var(--soft);padding:3px;border-radius:11px;margin:14px 0}.tabs button{flex:1;border:0;min-height:36px;padding:6px;background:transparent;color:var(--muted)}.tabs button[aria-selected=true]{background:var(--bg);color:var(--ink);box-shadow:0 1px 4px #15274416}
          .status{font-size:13px;line-height:1.55;margin:12px 0;overflow-wrap:anywhere;color:var(--muted)}.indicator{display:inline-block;width:7px;height:7px;border-radius:50%;background:#98a3b4;margin-right:7px}.indicator[data-state=Connected]{background:#20a36b}.indicator[data-state=Connecting]{background:#d49416}.indicator[data-state=Error]{background:#d24d4d}
          .pairing-card{margin:12px 0;padding:12px;border:1px solid var(--accent);border-radius:12px;background:var(--soft)}.pairing-card h3{font-size:14px;margin:0}.pairing-origin{font-size:14px;font-weight:600;line-height:1.5;margin:8px 0;overflow-wrap:anywhere;unicode-bidi:isolate}
          label{display:block;font-size:12px;color:var(--muted);margin:14px 0 7px}input{display:block;width:100%;height:42px;padding:9px 10px;border:1px solid var(--line);border-radius:10px;color:var(--ink);background:var(--soft)}.actions{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.actions button{flex:1;white-space:nowrap}.actions button.primary{flex-basis:100%}.primary{background:var(--accent);color:#fff;border-color:var(--accent)}.note{font-size:12px;line-height:1.55;color:var(--muted);margin:10px 0}.entry{display:block;width:100%;text-align:left;margin-top:8px;background:var(--bg);border:1px solid var(--line);padding:11px 12px;min-height:60px}.entry strong,.entry small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.entry small{color:var(--muted);font-size:12px;font-weight:400;margin-top:3px}.toggle{display:flex;align-items:center;justify-content:center;width:44px;height:44px;padding:10px;border-radius:14px;background:var(--accent);border:0;color:#fff;box-shadow:0 4px 14px #1769e033}.toggle svg{width:23px;height:23px}.empty{font-size:13px;color:var(--muted);padding:12px 0;line-height:1.5}
          @media(prefers-color-scheme:dark){:host{--bg:#1e232c;--ink:#f0f4fb;--muted:#a4b1c5;--line:#394250;--soft:#292f3a;--accent:#438df2}section{box-shadow:0 12px 44px #0007}}`;
        this.shadow.append(style);
        const header = document.createElement('header');
        this.close.textContent = '×'; this.close.className = 'close'; this.close.setAttribute('aria-label', 'Close');
        header.append(text(document.createElement('h2'), 'KeeWebX Connect'), this.close);
        const tabs = document.createElement('div'); tabs.className = 'tabs';
        tabs.append(this.accountTab, this.configTab);
        const statusLine = document.createElement('div');
        this.dot.className = 'indicator';
        this.status.className = 'status'; this.status.setAttribute('role', 'status'); this.status.setAttribute('aria-live', 'polite');
        statusLine.append(this.dot, this.status); this.status.style.display = 'inline';
        const accountActions = document.createElement('div'); accountActions.className = 'actions';
        this.lookup.className = 'primary'; accountActions.append(this.lookup);
        this.list.dataset.role = 'entries';
        this.accounts.append(accountActions, this.list, text(document.createElement('p'), 'Select an account to fill it. The login form will not be submitted automatically.'));
        this.accounts.lastElementChild!.className = 'note';
        const addressLabel = text(document.createElement('label'), 'KeeWebX address');
        this.address.type = 'url'; this.address.value = endpoint; this.address.autocomplete = 'off'; this.address.spellcheck = false;
        addressLabel.append(this.address);
        const configActions = document.createElement('div'); configActions.className = 'actions'; configActions.append(this.save, this.open);
        const appActions = document.createElement('div'); appActions.className = 'actions';
        this.authorize.className = 'primary';
        appActions.append(this.authorize, this.returnToSite, this.revoke);
        const extraActions = document.createElement('div'); extraActions.className = 'actions'; extraActions.append(this.probe);
        const pairingTitle = text(document.createElement('h3'), 'Website connection request');
        pairingTitle.id = 'kwx-pairing-title';
        this.pairingOrigin.id = 'kwx-pairing-origin'; this.pairingOrigin.className = 'pairing-origin'; this.pairingOrigin.dir = 'ltr';
        this.pairingCard.className = 'pairing-card'; this.pairingCard.hidden = true;
        this.pairingCard.setAttribute('role', 'group'); this.pairingCard.setAttribute('aria-live', 'polite');
        this.pairingCard.setAttribute('aria-labelledby', pairingTitle.id); this.pairingCard.setAttribute('aria-describedby', this.pairingOrigin.id);
        const pairingActions = document.createElement('div'); pairingActions.className = 'actions';
        this.pair.className = 'primary'; pairingActions.append(this.pair, this.decline);
        this.pairingCard.append(pairingTitle, text(document.createElement('p'), 'Connect this KeeWebX tab to:'), this.pairingOrigin, pairingActions);
        this.config.append(this.pairingCard, addressLabel);
        if (app) {
            const siteLabel = text(document.createElement('label'), 'Or open a login website here');
            this.targetSite.type = 'url'; this.targetSite.value = 'https://example.com/'; this.targetSite.autocomplete = 'off'; siteLabel.append(this.targetSite);
            this.config.append(appActions, siteLabel, configActions, text(document.createElement('p'), 'First use: unlock the database, authorize Connect, then return to the website.'));
        }
        else this.config.append(configActions, extraActions, text(document.createElement('p'), 'Keep your authorized KeeWebX tab open. A temporary connection page finds it and closes after verification. Each website connects to the same App. If needed, reconnect to that existing tab.'));
        this.config.lastElementChild!.className = 'note';
        this.panel.hidden = true;
        this.panel.append(header, tabs, statusLine, this.accounts, this.config);
        this.toggle.className = 'toggle'; this.toggle.setAttribute('aria-label', 'KeeWebX Connect');
        this.toggle.textContent = '';
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8');
        const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', 'M15 3a6 6 0 0 0-5.5 8.4L3 18v3h3l1.5-1.5V17H10l2.6-2.6A6 6 0 1 0 15 3Z M16.5 6.5h.01'); svg.append(path); this.toggle.append(svg);
        this.shadow.append(this.panel, this.toggle); document.body.append(this.host);
        this.toggle.onclick = event => { if (event.isTrusted) {
            const opening = this.panel.hidden;
            this.show(this.app ? 'config' : 'accounts', opening);
            if (opening) this.onOpen(event);
        } };
        this.close.onclick = event => { if (event.isTrusted) this.hide(); };
        this.accountTab.onclick = event => { if (event.isTrusted) this.show('accounts'); };
        this.configTab.onclick = event => { if (event.isTrusted) { this.onConfig(); this.show('config'); } };
        if (app) this.accountTab.hidden = true;
        this.tab(app ? 'config' : 'accounts');
        this.shadow.addEventListener('keydown', event => { if ((event as KeyboardEvent).key === 'Escape') this.hide(); });
        if (!app) {
            const reposition = () => { if (this.field?.isConnected) this.anchor(this.field); };
            addEventListener('scroll', reposition, true); addEventListener('resize', reposition);
            visualViewport?.addEventListener('resize', reposition);
            visualViewport?.addEventListener('scroll', reposition);
            new ResizeObserver(reposition).observe(this.panel);
        }
    }

    private tab(tab: 'accounts' | 'config'): void {
        this.accounts.hidden = tab !== 'accounts'; this.config.hidden = tab !== 'config';
        this.accountTab.setAttribute('aria-selected', String(tab === 'accounts'));
        this.configTab.setAttribute('aria-selected', String(tab === 'config'));
    }
    show(tab: 'accounts' | 'config' = this.app ? 'config' : 'accounts', open = true): void {
        this.tab(tab); this.panel.hidden = !open; this.toggle.setAttribute('aria-expanded', String(open));
        if (this.field?.isConnected) this.anchor(this.field);
    }
    hide(): void { this.panel.hidden = true; this.toggle.setAttribute('aria-expanded', 'false'); this.onClose(); }
    pairing(origin?: string): void {
        this.pairingCard.hidden = origin === undefined;
        this.pairingOrigin.textContent = origin ?? '';
        if (origin !== undefined) this.show('config');
    }
    state(state: BackendConnectionState, message: string): void { this.dot.dataset.state = state; this.status.textContent = message; }
    busy(value: boolean): void { this.lookup.disabled = value; this.probe.disabled = value; }
    clear(): void { this.list.replaceChildren(); }
    anchor(field: HTMLInputElement): void {
        if (this.app) return;
        this.field = field;
        const rect = field.getBoundingClientRect();
        const vx = visualViewport?.offsetLeft || 0;
        const vy = visualViewport?.offsetTop || 0;
        const vw = visualViewport?.width || innerWidth;
        const vh = visualViewport?.height || innerHeight;
        const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), Math.max(lo, hi));
        const x = clamp(rect.right + 6 + 44 <= vx + vw - 8 ? rect.right + 6 : rect.right - 46, vx + 8, vx + vw - 52);
        const y = clamp(rect.top + (rect.height - 44) / 2, vy + 8, vy + vh - 52);
        this.host.style.left = `${x}px`; this.host.style.top = `${y}px`; this.host.style.right = 'auto'; this.host.style.bottom = 'auto';
        const width = Math.min(348, vw - 24);
        const height = Math.min(this.panel.offsetHeight || 310, vh - 24);
        const py = rect.bottom + 8 + height <= vy + vh - 8 ? rect.bottom + 8 : rect.top - height - 8;
        this.panel.style.position = 'fixed'; this.panel.style.left = `${clamp(rect.left, vx + 12, vx + vw - width - 12)}px`;
        this.panel.style.right = 'auto'; this.panel.style.top = `${clamp(py, vy + 12, vy + vh - height - 12)}px`; this.panel.style.bottom = 'auto';
        this.panel.style.width = `${width}px`; this.panel.style.maxHeight = `${Math.max(100, vh - 24)}px`;
    }
    empty(message: string): void { this.clear(); const note = text(document.createElement('p'), message); note.className = 'empty'; this.list.append(note); }
    entry(index: number, title: string, user: string, select: (event: MouseEvent) => void): void {
        const el = button('', `entry-${index}`); el.className = 'entry';
        el.append(text(document.createElement('strong'), title || 'Untitled account'), text(document.createElement('small'), user || 'No username'));
        el.onclick = event => { if (event.isTrusted) select(event); }; this.list.append(el);
    }
}
