import EventEmitter from 'events';
import { Logger } from 'util/logger';

interface ModelEmitter extends EventEmitter {
    paused?: boolean;
    noChange?: boolean;
}

const SymbolEvents: unique symbol = Symbol('events');
const SymbolDefaults: unique symbol = Symbol('defaults');
const SymbolExtensions: unique symbol = Symbol('extensions');

// Generic event listener type — Node's EventEmitter is intentionally
// loose about listener arity, and the various Model subclasses emit
// changes with shapes ranging from `(model)` to `(model, value, prev)`
// to `(model, change)` to fully variadic. The legacy callers pass
// concretely-typed listeners like `(file: FileModel) => void`, so we
// keep the variadic args as `any[]` here — narrowing to `unknown[]`
// would break covariance against every subclass listener and force a
// cascading retype of every change-handler in the app. This is the
// one strategic `any` in the framework layer; everything else is now
// structurally typed via IndexableModel below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ModelEventListener = (...args: any[]) => void;

// Models are intentionally indexable: subclasses register their fields
// via `defineModelProperties` and the Proxy handler reads/writes them
// dynamically. Rather than scatter `(target as any)[prop]` everywhere
// we narrow once via this structural type.
type IndexableModel = Model & Record<string | symbol, unknown>;

function emitPropChange(
    target: Model,
    property: string | symbol,
    value: unknown,
    prevValue: unknown
): void {
    const emitter = target[SymbolEvents];
    if (!emitter.paused) {
        emitter.emit('change:' + String(property), target, value, prevValue);
        if (!emitter.noChange) {
            emitter.emit('change', target, { [property as string]: value });
        }
    }
}

const ProxyDef: ProxyHandler<Model> = {
    deleteProperty(target: Model, property: string | symbol): boolean {
        if (Object.prototype.hasOwnProperty.call(target, property)) {
            const indexable = target as IndexableModel;
            const defaults = target[SymbolDefaults];
            const value = defaults[property as string];
            const prevValue = indexable[property];
            if (prevValue !== value) {
                if (Object.prototype.hasOwnProperty.call(defaults, property)) {
                    indexable[property] = value;
                } else {
                    delete indexable[property];
                }
                emitPropChange(target, property, value, prevValue);
            }
            return true;
        }
        return true;
    },
    set(target: Model, property: string | symbol, value: unknown, receiver: unknown): boolean {
        const indexable = target as IndexableModel;
        if (
            Object.prototype.hasOwnProperty.call(target, property) ||
            target[SymbolExtensions]
        ) {
            if (indexable[property] !== value) {
                const prevValue = indexable[property];
                indexable[property] = value;
                emitPropChange(target, property, value, prevValue);
            }
            return true;
        } else {
            const ctor =
                receiver && typeof receiver === 'object'
                    ? (receiver as { constructor?: { name?: string } }).constructor
                    : undefined;
            new Logger(ctor?.name ?? 'Model').warn(
                `Unknown property: ${String(property)}`,
                new Error().stack
            );
        }
        return false;
    }
};

class Model {
    declare [SymbolEvents]: ModelEmitter;
    declare [SymbolDefaults]: Record<string, unknown>;
    declare [SymbolExtensions]: boolean;

    constructor(data?: Record<string, unknown>) {
        const emitter: ModelEmitter = new EventEmitter();
        emitter.setMaxListeners(100);

        const properties: PropertyDescriptorMap = {
            [SymbolEvents]: { value: emitter }
        };
        for (const [propName, defaultValue] of Object.entries(
            this[SymbolDefaults] ?? {}
        )) {
            properties[propName] = {
                configurable: true,
                enumerable: true,
                writable: true,
                value: defaultValue
            };
        }
        Object.defineProperties(this, properties);

        const object = new Proxy(this, ProxyDef);

        if (data) {
            object.set(data, { silent: true });
        }

        return object;
    }

    set(props: Record<string, unknown>, options?: { silent?: boolean }): void {
        const emitter = this[SymbolEvents];
        const silent = options?.silent;
        if (silent) {
            emitter.paused = true;
        }
        emitter.noChange = true;
        const indexable = this as IndexableModel;
        for (const [prop, value] of Object.entries(props)) {
            indexable[prop] = value;
        }
        emitter.noChange = false;
        if (silent) {
            emitter.paused = false;
        } else {
            emitter.emit('change', this, props);
        }
    }

    on(eventName: string, listener: ModelEventListener): void {
        this[SymbolEvents].on(eventName, listener);
    }

    once(eventName: string, listener: ModelEventListener): void {
        this[SymbolEvents].once(eventName, listener);
    }

    off(eventName: string, listener: ModelEventListener): void {
        this[SymbolEvents].off(eventName, listener);
    }

    emit(eventName: string, ...args: unknown[]): void {
        this[SymbolEvents].emit(eventName, ...args);
    }

    static defineModelProperties(
        properties: Record<string, unknown>,
        options?: { extensions?: boolean }
    ): void {
        this.prototype[SymbolDefaults] = { ...this.prototype[SymbolDefaults], ...properties };
        if (options?.extensions) {
            this.prototype[SymbolExtensions] = true;
        }
    }

    static set(properties: Record<string, unknown>): void {
        this.prototype[SymbolDefaults] = properties;
    }
}

export { Model };
