import EventEmitter from 'events';

// Accept arbitrary listener shapes without forcing every caller to
// reshape their callback into `(...args: unknown[]) => void`. The
// webpack-bundled `events` polyfill defaults to a stricter listener
// signature than Node's `EventEmitter`, which caused ~88 TS2345
// errors across the codebase for callbacks like
// `(file: FileModel) => void`. Upstream KeeWeb used Node's
// `any[]`-based typing; we match it here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyListener = (...args: any[]) => void;

class Events extends EventEmitter {
    constructor() {
        super();
        this.setMaxListeners(1000);
    }

    override on(eventName: string | symbol, listener: AnyListener): this {
        return super.on(eventName, listener);
    }

    override once(eventName: string | symbol, listener: AnyListener): this {
        return super.once(eventName, listener);
    }

    override off(eventName: string | symbol, listener: AnyListener): this {
        return super.off(eventName, listener);
    }

    override addListener(eventName: string | symbol, listener: AnyListener): this {
        return super.addListener(eventName, listener);
    }

    override removeListener(eventName: string | symbol, listener: AnyListener): this {
        return super.removeListener(eventName, listener);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    override emit(eventName: string | symbol, ...args: any[]): boolean {
        return super.emit(eventName, ...args);
    }
}

const instance = new Events();

export { instance as Events };
