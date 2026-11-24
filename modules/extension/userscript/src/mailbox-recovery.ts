/** A recent verified transport choice, never an authorization or reusable session. */
export interface RecoveryRoute {
    host: string; owner: string; endpoint: string; publicKey: string;
    authorizationRevision?: number; mailbox?: boolean; messagePort?: number;
}
export const MAILBOX_RECOVERY_MS = 30000;
export function sameRecoveryRoute(left: RecoveryRoute, right: RecoveryRoute): boolean {
    return left.host === right.host && left.owner === right.owner && left.endpoint === right.endpoint &&
        left.publicKey === right.publicKey && left.authorizationRevision === right.authorizationRevision &&
        left.mailbox === right.mailbox && left.messagePort === right.messagePort;
}
export interface RecoveryAttempt { readonly epoch: number; readonly mailbox: boolean }

export class MailboxRecovery {
    private epoch = 0;
    private proof?: { route: RecoveryRoute; href: string; receivedAt: number };
    current(attempt: RecoveryAttempt | undefined): boolean { return attempt?.epoch === this.epoch; }
    begin(route: RecoveryRoute, href: string, retryDirect = false): RecoveryAttempt {
        if (retryDirect) this.clear();
        this.refresh(route, href);
        return { epoch: ++this.epoch, mailbox: !!this.proof };
    }
    refresh(route: RecoveryRoute | undefined, href: string): void {
        if (this.proof && (!route || !sameRecoveryRoute(this.proof.route, route) || this.proof.href !== href ||
            Date.now() < this.proof.receivedAt || Date.now() - this.proof.receivedAt >= MAILBOX_RECOVERY_MS)) this.clear();
    }
    verified(attempt: RecoveryAttempt | undefined, route: RecoveryRoute, href: string, receivedAt: number): void {
        if (!attempt || attempt.epoch !== this.epoch || !route.mailbox || route.messagePort !== 1 ||
            !Number.isFinite(receivedAt) || receivedAt > Date.now() || Date.now() - receivedAt >= MAILBOX_RECOVERY_MS) return;
        this.proof = { route: { ...route }, href, receivedAt };
    }
    failed(attempt: RecoveryAttempt | undefined): void {
        if (this.current(attempt)) this.proof = undefined;
    }
    clear(): void { this.proof = undefined; this.epoch++; }
}
