/** Identity of one signed request on its original authenticated port. */
export interface ReceiptBinding {
    request: string;
    port: string;
    authorization: number;
    key: object;
    deadline: number;
}

/** One opaque reply in document memory. This never executes a request or uses storage. */
export class ReplyReceipt<T> {
    private latest?: { binding: ReceiptBinding; reply: T };

    constructor(private readonly now: () => number = () => Date.now()) {}

    remember(binding: ReceiptBinding, reply: T): void {
        this.clear();
        if (Number.isFinite(binding.deadline) && binding.deadline > this.now()) {
            this.latest = { binding: { ...binding }, reply };
        }
    }

    read(binding: ReceiptBinding): T | undefined {
        const entry = this.latest;
        if (!entry) return;
        if (entry.binding.deadline <= this.now()) { this.clear(); return; }
        const saved = entry.binding;
        if (saved.request === binding.request && saved.port === binding.port &&
            saved.authorization === binding.authorization && saved.key === binding.key &&
            saved.deadline === binding.deadline) return entry.reply;
    }

    clear(): void { this.latest = undefined; }
}
