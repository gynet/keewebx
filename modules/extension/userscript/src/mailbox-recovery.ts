/** Transport preference for one route and website document. */
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
    private preference?: { route: RecoveryRoute; href: string; observedAt: number };
    current(attempt: RecoveryAttempt | undefined): boolean { return attempt?.epoch === this.epoch; }
    begin(route: RecoveryRoute, href: string, retryDirect = false): RecoveryAttempt {
        if (retryDirect) this.clear();
        this.refresh(route, href);
        return { epoch: ++this.epoch, mailbox: this.preference !== undefined };
    }
    refresh(route: RecoveryRoute | undefined, href: string): void {
        const choice = this.preference;
        if (choice && (!route || !sameRecoveryRoute(choice.route, route) || choice.href !== href ||
            Date.now() < choice.observedAt || Date.now() - choice.observedAt >= MAILBOX_RECOVERY_MS)) this.clear();
    }
    verified(attempt: RecoveryAttempt | undefined, route: RecoveryRoute, href: string, receivedAt: number): void {
        if (!attempt || attempt.epoch !== this.epoch || !route.mailbox || route.messagePort !== 1 ||
            !Number.isFinite(receivedAt) || receivedAt > Date.now() || Date.now() - receivedAt >= MAILBOX_RECOVERY_MS) return;
        this.preference = { route: { ...route }, href, observedAt: receivedAt };
    }
    failed(attempt: RecoveryAttempt | undefined): void {
        if (this.current(attempt)) this.preference = undefined;
    }
    clear(): void { this.preference = undefined; this.epoch++; }
}
