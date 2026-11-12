/**
 * Ambient declarations for the vault package: the `events` polyfill and the
 * files an app bundles in (demo vault, release signing keys).
 */

// npm `events` polyfill (used in browser via webpack)
declare module 'events' {
    class EventEmitter {
        addListener(event: string | symbol, listener: (...args: unknown[]) => void): this;
        on(event: string | symbol, listener: (...args: unknown[]) => void): this;
        once(event: string | symbol, listener: (...args: unknown[]) => void): this;
        off(event: string | symbol, listener: (...args: unknown[]) => void): this;
        removeListener(event: string | symbol, listener: (...args: unknown[]) => void): this;
        removeAllListeners(event?: string | symbol): this;
        setMaxListeners(n: number): this;
        getMaxListeners(): number;
        listeners(event: string | symbol): ((...args: unknown[]) => void)[];
        rawListeners(event: string | symbol): ((...args: unknown[]) => void)[];
        emit(event: string | symbol, ...args: unknown[]): boolean;
        listenerCount(event: string | symbol): number;
        prependListener(event: string | symbol, listener: (...args: unknown[]) => void): this;
        prependOnceListener(event: string | symbol, listener: (...args: unknown[]) => void): this;
        eventNames(): (string | symbol)[];
    }
    export = EventEmitter;
}

// The demo vault, bundled by the app as a base64 string.
declare module 'demo.kdbx' {
    const data: string;
    export default data;
}

// Release signing keys, bundled by the app as text.
declare module 'public-key.pem' {
    const data: string;
    export default data;
}
declare module 'public-key-new.pem' {
    const data: string;
    export default data;
}

// Webpack-style synchronous require.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const require: (id: string) => any;
