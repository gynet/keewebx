/** Best-effort expiry for this page: compare the observed value before clearing.
 * Browser clipboard reads and writes are not an atomic compare-and-swap. */
export class ClipboardExpiry {
    private cancelPending?: () => void;

    constructor(private readonly onFailure?: () => void) {}

    schedule(text: string, seconds: number, clipboard: Pick<Clipboard, 'readText' | 'writeText'> = navigator.clipboard): void {
        this.cancelPending?.();
        this.cancelPending = undefined;
        if (!(seconds > 0)) return;
        if (!clipboard) {
            this.onFailure?.();
            return;
        }
        let active = true;
        let expected: string | undefined = text;
        const cancel = () => { active = false; expected = undefined; clearTimeout(timer); };
        this.cancelPending = cancel;
        const timer = setTimeout(async () => {
            try {
                const current = await clipboard.readText();
                if (active && expected !== undefined && current === expected) await clipboard.writeText('');
            } catch {
                // Browsers may deny reads/writes when unfocused or without permission.
                // Do not fall back to an unconditional write that can erase newer data.
                if (active) this.onFailure?.();
            } finally {
                expected = undefined;
                if (this.cancelPending === cancel) this.cancelPending = undefined;
            }
        }, seconds * 1000);
    }
}

function showClipboardFailure(): void {
    const id = 'clipboard-expiry-warning';
    if (typeof document === 'undefined' || !document.body || document.getElementById(id)) return;
    const notice = document.createElement('aside');
    notice.id = id;
    notice.style.cssText = 'position:fixed;bottom:1rem;left:1rem;z-index:2147483647;padding:.75rem;' +
        'max-width:calc(100vw - 2rem);background:Canvas;color:CanvasText;border:1px solid currentColor';
    const message = document.createElement('span');
    message.setAttribute('role', 'status');
    message.textContent = 'KeeWebX could not confirm clipboard clearing. Clear it manually if needed. ';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Dismiss';
    close.addEventListener('click', () => notice.remove());
    notice.append(message, close);
    document.body.append(notice);
}

export const clipboardExpiry = new ClipboardExpiry(showClipboardFailure);
