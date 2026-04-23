/**
 * Global type declarations for @keewebx/core.
 * Provides ambient module declarations for JS-only dependencies
 * and global types used across the application.
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

// morphdom
declare module 'morphdom' {
    function morphdom(
        fromNode: Node,
        toNode: string | Node,
        options?: Record<string, unknown>
    ): Node;
    export default morphdom;
}

// baron scrollbar library
declare module 'baron' {
    interface BaronInstance {
        update(): void;
        dispose(): void;
    }
    function baron(opts: Record<string, unknown>): BaronInstance;
    export default baron;
}

// pikaday — date picker library (used by field-view-date)
declare module 'pikaday' {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    class Pikaday {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        constructor(options: any);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        el: any;
        show(): void;
        hide(): void;
        destroy(): void;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        adjustPosition: (...args: any[]) => void;
    }
    export default Pikaday;
}

// jsqrcode — pure JS QR code decoder (no types published)
declare module 'jsqrcode' {
    class QrCode {
        constructor(image: HTMLImageElement | HTMLCanvasElement);
        decode(): string;
    }
    export default QrCode;
}

// marked@2.x — Markdown renderer. We pin v2 (#6 legacy deps). The
// upstream package didn't ship .d.ts at this version. We declare a
// minimal surface covering the call sites in util/formatting/md-to-html.
declare module 'marked' {
    interface MarkedOptions {
        renderer?: Renderer;
        breaks?: boolean;
    }
    class Renderer {
        link(href: string, title: string, text: string): string;
    }
    interface MarkedFn {
        (md: string, options?: MarkedOptions): string;
        Renderer: typeof Renderer;
    }
    const marked: MarkedFn;
    export default marked;
}

// dompurify@2.x — HTML sanitiser. The package ships .d.ts at v3 but
// we're pinned to v2 (#6 legacy deps), so we declare the minimal call
// surface used by md-to-html locally.
declare module 'dompurify' {
    interface SanitizeOptions {
        ADD_ATTR?: string[];
    }
    const dompurify: {
        sanitize(input: string, options?: SanitizeOptions): string;
    };
    export default dompurify;
}

// Handlebars templates loaded via webpack handlebars-loader.
// Each `import tpl from 'templates/...hbs'` yields a compiled
// template function that accepts template data + options and
// returns the rendered HTML string.
declare module '*.hbs' {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const template: (data?: any, options?: any) => string;
    export default template;
}

// The bundled demo database, loaded via webpack's base64-loader.
// `demo.kdbx` is a resolve.alias target in webpack.config.js pointing
// at app/resources/Demo.kdbx — it's handed to file-model to open the
// live demo on first run. base64-loader returns a base64-encoded
// string which file-model then passes through kdbxweb.ByteUtils.
declare module 'demo.kdbx' {
    const data: string;
    export default data;
}

// PEM public keys bundled as resolve.alias targets and loaded via
// webpack's raw-loader-equivalent (a simple String(source) loader),
// used by util/data/signature-verifier to validate signed releases.
declare module 'public-key.pem' {
    const data: string;
    export default data;
}
declare module 'public-key-new.pem' {
    const data: string;
    export default data;
}

// util/ui/tip — now a real TS module (migrated from JS)

// comp/browser/key-handler — TS module; keep ambient broader so views
// that still rely on number|string key codes type-check without fuss.
declare module 'comp/browser/key-handler' {
    const KeyHandler: {
        SHORTCUT_ACTION: number;
        SHORTCUT_OPT: number;
        SHORTCUT_SHIFT: number;
        init(): void;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        onKey(
            key: number,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            handler: (...args: any[]) => void,
            view: unknown,
            shortcut?: number,
            modal?: unknown,
            noPrevent?: boolean
        ): void;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        offKey(key: number, handler: (...args: any[]) => void, view: unknown): void;
        reg(): void;
    };
    export { KeyHandler };
}

// comp/app/focus-manager — JS module not yet migrated
declare module 'comp/app/focus-manager' {
    const FocusManager: {
        modal: string | null;
        setModal(modal: string | null): void;
    };
    export { FocusManager };
}

// comp/i18n/date-format — now a real TS module, keep ambient signature broader
declare module 'comp/i18n/date-format' {
    const DateFormat: {
        dtStr(dt: Date | number | null | undefined): string;
        dStr(dt: Date | number | null | undefined): string;
        dtStrFs(dt: Date | number | null | undefined): string;
        months(): string[];
        weekDays(): string[];
        shortWeekDays(): string[];
    };
    export { DateFormat };
}

// Handlebars (aliased as 'hbs' via webpack/tsconfig paths)
declare module 'hbs' {
    const Handlebars: {
        registerHelper(name: string, fn: (...args: any[]) => any): void;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        [key: string]: any;
    };
    export default Handlebars;
}

// jQuery global — intentionally loose (legacy code uses many shapes)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const $: ((...args: any[]) => any) & {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trim(str: any): string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    [key: string]: any;
};

// JQuery<T> generic type — legacy views/components use this to type
// form input references. We don't ship @types/jquery (adds ~2MB of
// types for a single legacy usage site each), so alias to a minimal
// shape that covers the methods actually called (.val, .on, .off,
// element indexing via [0]).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JQuery<T = HTMLElement> = any;

// Webpack-style synchronous require (used for dynamic .hbs template loading)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const require: (id: string) => any;

// localStorage extended
interface Storage {
    debugView?: string;
    debugBrowserExtension?: string;
}

// Build-identity globals injected by webpack.DefinePlugin. These exist so
// the live demo, bundle, and CI can all verify the exact same commit SHA
// ("code = build = demo = test"). Do not fall back to 'unknown' in prod —
// if the build produced 'unknown' here, the build system is broken.
declare const __KEEWEBX_BUILD_SHA__: string;
declare const __KEEWEBX_BUILD_SHA_SHORT__: string;
declare const __KEEWEBX_BUILD_TIME__: string;
