/** One user action has one deadline, even when it contains several RPCs. */
export class Operation {
    readonly deadline: number;
    stage: string;
    private closed = false;
    private stop!: (error: Error) => void;
    private readonly aborted: Promise<never>;
    private readonly timer: ReturnType<typeof setTimeout>;

    constructor(stage: string, budgetMs: number, private readonly progress: (stage: string) => void,
        expired: (stage: string) => void, private readonly now: () => number = () => Date.now()) {
        if (!Number.isFinite(budgetMs) || budgetMs <= 0) throw new RangeError('The operation needs a finite positive budget.');
        this.stage = stage;
        this.deadline = this.now() + budgetMs;
        this.aborted = new Promise<never>((_resolve, reject) => { this.stop = reject; });
        void this.aborted.catch(() => {});
        this.timer = setTimeout(() => {
            if (this.closed) return;
            const stage = this.stage;
            this.cancel(this.timeout());
            expired(stage);
        }, Math.max(1, budgetMs));
        this.progress(stage);
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
