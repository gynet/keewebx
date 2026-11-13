/** Best-effort expiry for this page: compare the observed value before clearing.
 * Browser clipboard reads and writes are not an atomic compare-and-swap. */
export class ClipboardExpiry {
    private cancelPending?: () => void;

    schedule(text: string, seconds: number, clipboard: Pick<Clipboard, 'readText' | 'writeText'> = navigator.clipboard): void {
        this.cancelPending?.();
        this.cancelPending = undefined;
        if (!(seconds > 0) || !clipboard) return;
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
            } finally {
                expected = undefined;
                if (this.cancelPending === cancel) this.cancelPending = undefined;
            }
        }, seconds * 1000);
    }
}

export const clipboardExpiry = new ClipboardExpiry();
