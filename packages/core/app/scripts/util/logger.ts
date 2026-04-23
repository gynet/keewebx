const Level: Readonly<Record<string, number>> = {
    Off: 0,
    Error: 1,
    Warn: 2,
    Info: 3,
    Debug: 4,
    All: 5
};

interface LogEntry {
    level: string;
    args: unknown[];
}

const MaxLogsToSave: number = 100;

const lastLogs: LogEntry[] = [];

class Logger {
    static Level = Level;

    prefix: string;
    level: number;

    constructor(name?: string, id?: string, level: number = Level.All) {
        this.prefix = name ? name + (id ? ':' + id : '') : 'default';
        this.level = level;
    }

    // Overloaded so callers can do `const t = logger.ts(); ...; logger.ts(t)`
    // without TS complaining about feeding a `number | string` back into
    // a `number | undefined` parameter. The 0-arg call returns a numeric
    // timestamp (the start time), the 1-arg call returns a human-readable
    // "Nms" delta string suitable for logging.
    ts(): number;
    ts(start: number): string;
    ts(start?: number): number | string {
        if (start !== undefined) {
            return Math.round(performance.now() - start) + 'ms';
        }
        return performance.now();
    }

    getPrefix(): string {
        return new Date().toISOString() + ' [' + this.prefix + '] ';
    }

    debug(...args: unknown[]): void {
        (args as unknown[])[0] = this.getPrefix() + args[0];
        if (this.level >= Level.Debug) {
            Logger.saveLast('debug', args);
            console.log(...args); // eslint-disable-line no-console
        }
    }

    info(...args: unknown[]): void {
        (args as unknown[])[0] = this.getPrefix() + args[0];
        if (this.level >= Level.Info) {
            Logger.saveLast('info', args);
            console.info(...args); // eslint-disable-line no-console
        }
    }

    warn(...args: unknown[]): void {
        (args as unknown[])[0] = this.getPrefix() + args[0];
        if (this.level >= Level.Warn) {
            Logger.saveLast('warn', args);
            console.warn(...args); // eslint-disable-line no-console
        }
    }

    error(...args: unknown[]): void {
        (args as unknown[])[0] = this.getPrefix() + args[0];
        if (this.level >= Level.Error) {
            Logger.saveLast('error', args);
            console.error(...args); // eslint-disable-line no-console
        }
    }

    setLevel(level: number): void {
        this.level = level;
    }

    getLevel(): number {
        return this.level;
    }

    static saveLast(level: string, args: unknown[]): void {
        lastLogs.push({ level, args: Array.prototype.slice.call(args) });
        if (lastLogs.length > MaxLogsToSave) {
            lastLogs.shift();
        }
    }

    static getLast(): LogEntry[] {
        return lastLogs;
    }
}

export { Logger };
