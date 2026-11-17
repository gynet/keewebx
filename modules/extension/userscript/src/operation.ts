/** Bound each operation and its explicit App recovery phase. */
export class Operation {
    stage: string;
    private expiresAt: number;
    private closed = false;
    private stop!: (error: Error) => void;
    private readonly aborted: Promise<never>;
    private timer: ReturnType<typeof setTimeout>;

    constructor(stage: string, budgetMs: number, private readonly progress: (stage: string) => void,
        private readonly expired: (stage: string) => void, private readonly now: () => number = () => Date.now()) {
        if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new RangeError('The operation needs a finite positive budget.');
        this.stage = stage;
        this.expiresAt = this.now() + budgetMs;
        this.aborted = new Promise<never>((_resolve, reject) => { this.stop = reject; });
        void this.aborted.catch(() => {});
        this.timer = this.expirationTimer();
        this.progress(stage);
    }

    get deadline(): number { return this.expiresAt; }

    resetBudget(budgetMs: number): number {
        this.assert();
        if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new RangeError('The operation needs a finite positive budget.');
        this.expiresAt = this.now() + budgetMs;
        clearTimeout(this.timer); this.timer = this.expirationTimer();
        return this.expiresAt;
    }

    private expirationTimer(): ReturnType<typeof setTimeout> {
        return setTimeout(() => {
            if (this.closed) return;
            const stage = this.stage;
            this.cancel(this.timeout());
            this.expired(stage);
        }, Math.max(1, this.deadline - this.now()));
    }

    private timeout(): Error { return new Error(`${this.stage} timed out. Try Find accounts again.`); }

    assert(): void {
        if (this.closed) throw new Error('The operation was canceled.');
        if (this.now() >= this.deadline) throw this.timeout();
    }

    get remainingMs(): number { this.assert(); return Math.max(1, this.deadline - this.now()); }

    setStage(stage: string): void { this.assert(); this.stage = stage; this.progress(stage); }

    async run<T>(stage: string, work: () => Promise<T>): Promise<T> {
        this.setStage(stage);
        const result = await Promise.race([Promise.resolve().then(() => { this.assert(); return work(); }), this.aborted]);
        this.assert();
        return result;
    }

    cancel(reason = new Error('The operation was canceled.')): void {
        if (this.closed) return;
        this.closed = true; clearTimeout(this.timer); this.stop(reason);
    }
}
