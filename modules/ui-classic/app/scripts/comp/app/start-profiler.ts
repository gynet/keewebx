import { Logger } from 'util/logger';

const logger = new Logger('start-profiler');

let lastTs = 0;

interface ProfileOperation {
    name: string;
    elapsed: number;
}

const operations: ProfileOperation[] = [];

const StartProfiler = {
    milestone(name: string): void {
        const ts = logger.ts();
        const elapsed = ts - lastTs;
        lastTs = ts;
        operations.push({ name, elapsed });
    },

    report(): void {
        const networkTime = this.getNetworkTime();
        operations.unshift({ name: 'fetching', elapsed: networkTime });

        const time = Math.round(performance.now());

        this.printReport('App', operations, time);
    },

    reportAppProfile(data: { timings: ProfileOperation[]; totalTime: number }): void {
        this.printReport('Electron app', data.timings, data.totalTime);
    },

    printReport(name: string, ops: ProfileOperation[], totalTime: number): void {
        const message =
            `${name} started in ${totalTime}ms: ` +
            ops.map((op) => `${op.name}=${Math.round(op.elapsed)}ms`).join(', ');

        logger.info(message);
    },

    getNetworkTime(): number {
        let perfEntry: PerformanceNavigationTiming | PerformanceTiming | undefined;

        if (performance.getEntriesByType) {
            [perfEntry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
        }
        if (!perfEntry || !(perfEntry as PerformanceNavigationTiming).responseEnd || !(perfEntry as PerformanceNavigationTiming).fetchStart) {
            perfEntry = performance.timing;
        }

        return (perfEntry as PerformanceNavigationTiming | PerformanceTiming).responseEnd -
            (perfEntry as PerformanceNavigationTiming | PerformanceTiming).fetchStart;
    }
};

StartProfiler.milestone('pre-init');

export { StartProfiler };
