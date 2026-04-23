/* eslint-disable @typescript-eslint/no-explicit-any */
import morphdom from 'morphdom';
import EventEmitter from 'events';
import { Tip } from 'util/ui/tip';
import { KeyHandler } from 'comp/browser/key-handler';
import { FocusManager } from 'comp/app/focus-manager';
import { Logger } from 'util/logger';

interface EventHandler {
    selector?: string;
    method: string;
}

interface ElementEventListener {
    event: string;
    selector: string;
    method: string;
    els: Element[];
    listener?: (e: Event) => void;
}

const DoesNotBubble: Record<string, boolean> = {
    mouseenter: true,
    mouseleave: true,
    blur: true,
    focus: true
};

const DefaultTemplateOptions = {
    allowProtoPropertiesByDefault: true,
    allowedProtoProperties: { length: true, active: true }
};

class View extends EventEmitter {
    parent: string | Element | undefined = undefined;
    template: ((data: any, options?: any) => string) | undefined = undefined;
    events: Record<string, string> = {};
    model: any = undefined;
    options: Record<string, any> = {};
    views: Record<string, View | View[] | undefined> = {};
    hidden: boolean | undefined = undefined;
    removed = false;
    modal: string | undefined = undefined;
    el!: HTMLElement;
    $el: any; // legacy jQuery wrapper
    eventListeners: Record<string, (e: Event) => void> = {};
    elementEventListeners: ElementEventListener[] = [];
    debugLogger: Logger | undefined = (localStorage as any).debugView
        ? new Logger('view', this.constructor.name)
        : undefined;

    constructor(model: any = undefined, options: Record<string, any> = {}) {
        super();

        this.model = model;
        this.options = options;

        this.setMaxListeners(100);
    }

    render(templateData?: any): this | undefined {
        if (this.removed) {
            return;
        }

        let ts: number | string | undefined;
        if (this.debugLogger) {
            this.debugLogger.debug('Render start');
            ts = this.debugLogger.ts();
        }

        if (this.el) {
            Tip.destroyTips(this.el);
        }

        this.renderElement(templateData);

        Tip.createTips(this.el);

        this.debugLogger?.debug('Render finished', this.debugLogger.ts(ts as number));

        return this;
    }

    renderElement(templateData?: any): void {
        const html = this.template!(templateData, DefaultTemplateOptions);
        if (this.el) {
            const mountRoot = this.options.ownParent ? this.el.firstChild : this.el;
            morphdom(mountRoot as Node, html);
            this.bindElementEvents();
        } else {
            let parent: string | Element | null | undefined =
                this.options.parent || this.parent;
            if (parent) {
                if (typeof parent === 'string') {
                    parent = document.querySelector(parent);
                }
                if (!parent) {
                    throw new Error(`Error rendering ${this.constructor.name}: parent not found`);
                }
                if (this.options.replace) {
                    Tip.destroyTips(parent as Element);
                    (parent as Element).innerHTML = '';
                }
                const el = document.createElement('div');
                el.innerHTML = html;
                const root = el.firstChild as HTMLElement;
                if (this.options.ownParent) {
                    if (root) {
                        (parent as Element).appendChild(root);
                    }
                    this.el = parent as HTMLElement;
                } else {
                    this.el = root;
                    (parent as Element).appendChild(this.el);
                }
                if (this.modal) {
                    FocusManager.setModal(this.modal);
                }
                this.bindEvents();
            } else {
                throw new Error(
                    `Error rendering ${this.constructor.name}: I don't know how to insert the view`
                );
            }
            this.$el = $(this.el); // legacy
        }
    }

    bindEvents(): void {
        const eventsMap: Record<string, EventHandler[]> = {};
        for (const [eventDef, method] of Object.entries(this.events)) {
            const spaceIx = eventDef.indexOf(' ');
            let event: string;
            let selector: string | undefined;
            if (spaceIx > 0) {
                event = eventDef.substr(0, spaceIx);
                selector = eventDef.substr(spaceIx + 1);
                if (DoesNotBubble[event]) {
                    this.elementEventListeners.push({ event, selector, method, els: [] });
                    continue;
                }
            } else {
                event = eventDef;
            }
            if (!eventsMap[event]) {
                eventsMap[event] = [];
            }
            eventsMap[event].push({ selector, method });
        }
        for (const [event, handlers] of Object.entries(eventsMap)) {
            this.debugLogger?.debug('Bind', 'view', event, handlers);
            const listener = (e: Event): void => this.eventListener(e, handlers);
            this.eventListeners[event] = listener;
            this.el.addEventListener(event, listener);
        }
        this.bindElementEvents();
    }

    unbindEvents(): void {
        for (const [event, listener] of Object.entries(this.eventListeners)) {
            this.el.removeEventListener(event, listener);
        }
        this.unbindElementEvents();
    }

    bindElementEvents(): void {
        if (!this.elementEventListeners.length) {
            return;
        }
        this.unbindElementEvents();
        for (const cfg of this.elementEventListeners) {
            const els = this.el.querySelectorAll(cfg.selector);
            this.debugLogger?.debug('Bind', 'element', cfg.event, cfg.selector, els.length);
            cfg.listener = (e: Event): void => this.eventListener(e, [cfg]);
            for (const el of els) {
                el.addEventListener(cfg.event, cfg.listener);
                cfg.els.push(el);
            }
        }
    }

    unbindElementEvents(): void {
        if (!this.elementEventListeners.length) {
            return;
        }
        for (const cfg of this.elementEventListeners) {
            for (const el of cfg.els) {
                el.removeEventListener(cfg.event, cfg.listener!);
            }
            cfg.els = [];
        }
    }

    eventListener(e: Event, handlers: EventHandler[]): void {
        this.debugLogger?.debug('Listener fired', e.type);
        for (const { selector, method } of handlers) {
            if (selector) {
                const closest = (e.target as Element).closest(selector);
                if (!closest || !this.el.contains(closest)) {
                    continue;
                }
            }
            if (!(this as any)[method]) {
                this.debugLogger?.debug('Method not defined', method);
                continue;
            }
            this.debugLogger?.debug('Handling event', e.type, method);
            (this as any)[method](e);
        }
    }

    remove(): void {
        if (this.modal && FocusManager.modal === this.modal) {
            FocusManager.setModal(null);
        }
        this.emit('remove');

        this.removeInnerViews();
        Tip.hideTips(this.el);
        this.el.remove();
        this.removed = true;

        this.debugLogger?.debug('Remove');
    }

    removeInnerViews(): void {
        if (this.views) {
            for (const view of Object.values(this.views)) {
                if (view) {
                    if (view instanceof Array) {
                        view.forEach((v) => v.remove());
                    } else {
                        view.remove();
                    }
                }
            }
            this.views = {};
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listenTo(model: any, event: string, callback: (...args: any[]) => any): void {
        const boundCallback = callback.bind(this);
        model.on(event, boundCallback);
        this.once('remove', () => model.off(event, boundCallback));
    }

    hide(): void {
        Tip.hideTips(this.el);
        this.toggle(false);
    }

    show(): void {
        this.toggle(true);
    }

    toggle(visible?: boolean): void {
        this.debugLogger?.debug(visible ? 'Show' : 'Hide');
        if (visible === undefined) {
            visible = !!this.hidden;
        }
        if (this.hidden === !visible) {
            this.debugLogger?.debug('Toggle: noop', visible);
            return;
        }
        this.hidden = !visible;
        if (this.modal) {
            if (visible) {
                FocusManager.setModal(this.modal);
            } else if (FocusManager.modal === this.modal) {
                FocusManager.setModal(null);
            }
        }
        if (this.el) {
            this.el.classList.toggle('show', !!visible);
            this.el.classList.toggle('hide', !visible);
            if (!visible) {
                Tip.hideTips(this.el);
            }
        }
        this.emit(visible ? 'show' : 'hide');
    }

    isHidden(): boolean {
        return !!this.hidden;
    }

    isVisible(): boolean {
        return !this.hidden;
    }

    afterPaint(callback: () => void): void {
        requestAnimationFrame(() => requestAnimationFrame(callback));
    }

    onKey(
        key: number,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        handler: (...args: any[]) => any,
        // Accept null as well as number | undefined — legacy callers
        // pass explicit `null` to mean "no modifier shortcut", which
        // the underlying KeyHandler treats identically to absent.
        shortcut?: number | null,
        // KeyHandler.onKey types `modal` as `unknown`; legacy callers
        // pass a modal name string OR the literal `false` to mean
        // "no modal-scoped dispatch". Mirror that here.
        modal?: string | boolean,
        noPrevent?: boolean
    ): void {
        (KeyHandler as any).onKey(key, handler, this, shortcut, modal, noPrevent);
        this.once('remove', () => (KeyHandler as any).offKey(key, handler, this));
    }

    off(event: string, listener?: (...args: unknown[]) => void): this {
        if (listener === undefined) {
            return super.removeAllListeners(event);
        } else {
            return super.off(event, listener);
        }
    }
}

export { View, DefaultTemplateOptions };
